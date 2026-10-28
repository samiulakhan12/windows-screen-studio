import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ root: '' }))
h.root = mkdtempSync(path.join(tmpdir(), 'ssw-brand-kit-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(h.root, name), isPackaged: false, getAppPath: () => h.root },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => undefined },
  BrowserWindow: class {},
  shell: {}
}))

const { brandKitDir, loadBrandKitSync, readBrandFile, saveBrandKit } = await import('../src/main/brandKit')
const { addBrandFile, copyKitIntoProject } = await import('../src/main/brandKitFiles')
const { applyStyleDefaults } = await import('../src/main/styleDefaults')
const { importAsset } = await import('../src/main/assetIpc')
const { projectDir, writeProject } = await import('../src/main/projects')
const { createProject } = await import('../src/shared/engine/project')

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const TTF = Buffer.from([0, 1, 0, 0, 0, 10, 0, 0])
let n = 0
const kitFile = (): string => path.join(h.root, `ud-${n++}`, 'brand-kit.json')
function src(name: string, data: Buffer): string {
  const dir = path.join(h.root, 'src', String(n++))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, name), data)
  return path.join(dir, name)
}
function newProject(id: string) {
  mkdirSync(projectDir(id), { recursive: true })
  return createProject({
    id,
    name: id,
    duration: 20,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
}

async function fullKit(file: string) {
  const logo = await addBrandFile('logo', src('acme.png', PNG), file)
  const font = await addBrandFile('font', src('Acme Sans.ttf', TTF), file)
  return saveBrandKit(
    {
      logo: { file: logo.file, position: 'top-left', size: 0.1, opacity: 1, margin: 0.02 },
      colors: ['#112233'],
      fonts: [font.font],
      bodyFont: font.font!.id,
      intro: { title: 'Acme', style: 'centered', background: 'solid', length: 2 },
      autoApply: true
    },
    file
  )
}

beforeEach(() => {
  n++
})

describe('the brand kit on disk', () => {
  it('starts empty, and reads a malformed file as empty', () => {
    const file = kitFile()
    expect(loadBrandKitSync(file)).toEqual({ colors: [], fonts: [], autoApply: false })
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{ not json')
    expect(loadBrandKitSync(file)).toEqual({ colors: [], fonts: [], autoApply: false })
  })

  it('adds checked files under new names and saves a kit naming them', async () => {
    const file = kitFile()
    const kit = await fullKit(file)
    expect(kit.logo?.file).toBe('logo-1.png')
    expect(kit.fonts[0]).toMatchObject({ name: 'Acme Sans', file: 'font-1.ttf' })
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
    expect(loadBrandKitSync(file)).toEqual(kit)
    expect(await readBrandFile('logo-1.png', file)).toEqual(new Uint8Array(PNG))
    expect(await readBrandFile('../brand-kit.json', file)).toBeNull()
    expect(await readBrandFile('brand-kit.json', file)).toBeNull()
  })

  it('refuses a logo or font whose content is not what it says', async () => {
    const file = kitFile()
    await expect(addBrandFile('logo', src('fake.png', TTF), file)).rejects.toThrow(/could not be read/)
    await expect(addBrandFile('font', src('fake.ttf', PNG), file)).rejects.toThrow(/could not be read as a TTF/)
    await expect(addBrandFile('logo', src('a.gif', Buffer.from('GIF89a')), file)).rejects.toThrow(/Choose a PNG, JPG, WebP or SVG/)
    expect(existsSync(brandKitDir(file)) ? readdirSync(brandKitDir(file)).filter((f) => !f.startsWith('.')) : []).toEqual([])
  })

  it('saving removes files the kit no longer names, and a kit naming a missing file reads without it', async () => {
    const file = kitFile()
    const kit = await fullKit(file)
    await addBrandFile('logo', src('unused.png', PNG), file)
    expect(readdirSync(brandKitDir(file)).sort()).toEqual(['font-1.ttf', 'logo-1.png', 'logo-2.png'])
    await saveBrandKit({ ...kit, logo: undefined }, file)
    expect(readdirSync(brandKitDir(file)).sort()).toEqual(['font-1.ttf'])
    rmSync(path.join(brandKitDir(file), 'font-1.ttf'))
    const read = loadBrandKitSync(file)
    expect(read.fonts).toEqual([])
    expect(read.bodyFont).toBeUndefined()
  })

  it('copies its files into a project for "Apply brand kit"', async () => {
    const file = kitFile()
    await fullKit(file)
    newProject('rec-apply')
    const { kit, files } = await copyKitIntoProject('rec-apply', file)
    expect(files.logo).toBe('watermark-1.png')
    expect(files.fonts[kit.fonts[0].id]).toBe('font-1.ttf')
    expect(readFileSync(path.join(projectDir('rec-apply'), 'font-1.ttf'))).toEqual(TTF)
    // Applying again reuses the identical font file.
    const again = await copyKitIntoProject('rec-apply', file)
    expect(again.files.fonts[kit.fonts[0].id]).toBe('font-1.ttf')
  })

  it('applying an unchanged kit again reuses its logo copy, so the logo used before stays for undo', async () => {
    const file = kitFile()
    await fullKit(file)
    const p = newProject('rec-reapply')
    const own = Buffer.concat([PNG, Buffer.from([7])])
    writeFileSync(path.join(projectDir('rec-reapply'), 'watermark-1.png'), own)
    // Autosave: the saved project uses `logo`.
    const uses = (logo: string) => writeProject({ ...p, watermark: { show: true, kind: 'image', path: logo, position: 'top-left', size: 0.1, opacity: 1, margin: 0 } })
    const logos = () => readdirSync(projectDir('rec-reapply')).filter((f) => f.startsWith('watermark')).sort()
    await uses('watermark-1.png')
    for (let i = 0; i < 6; i++) {
      const { files } = await copyKitIntoProject('rec-reapply', file)
      expect(files.logo).toBe('watermark-2.png')
      await uses(files.logo!)
    }
    expect(logos()).toEqual(['watermark-1.png', 'watermark-2.png'])
    expect(readFileSync(path.join(projectDir('rec-reapply'), 'watermark-1.png'))).toEqual(own)
    // Only the latest pick is reused: older picks are removed first, so undo could lose one made current again.
    expect((await importAsset('rec-reapply', 'watermark', src('other.png', own))).path).toBe('watermark-3.png')
    expect((await copyKitIntoProject('rec-reapply', file)).files.logo).toBe('watermark-4.png')
  })
})

describe('new recordings with the brand kit', () => {
  it('start with it when "Apply to new recordings" is on', async () => {
    const file = kitFile()
    await fullKit(file)
    const p = applyStyleDefaults(newProject('rec-new-1'), null, undefined, file)
    expect(p.watermark).toMatchObject({ kind: 'image', path: 'watermark-1.png', position: 'top-left' })
    expect(p.fonts?.[0].file).toBe('font-1.ttf')
    expect(p.captions?.font).toBe(p.fonts?.[0].id)
    expect(p.titles?.find((c) => c.brand === 'intro')).toMatchObject({ start: 0, end: 2, title: 'Acme', color: '#112233' })
    expect(readdirSync(projectDir('rec-new-1')).sort()).toEqual(['font-1.ttf', 'watermark-1.png'])
  })

  it('are left as they were when it is off, or when there is no kit', async () => {
    const file = kitFile()
    const kit = await fullKit(file)
    await saveBrandKit({ ...kit, autoApply: false }, file)
    const fresh = newProject('rec-new-2')
    expect(applyStyleDefaults(fresh, null, undefined, file)).toBe(fresh)
    const none = newProject('rec-new-3')
    expect(applyStyleDefaults(none, null, undefined, kitFile())).toBe(none)
    expect(readdirSync(projectDir('rec-new-2'))).toEqual([])
  })

  it('are left as they were when a kit file vanished (the recording is never broken)', async () => {
    const file = kitFile()
    await fullKit(file)
    rmSync(path.join(brandKitDir(file), 'logo-1.png'))
    const p = applyStyleDefaults(newProject('rec-new-4'), null, undefined, file)
    // The logo is read as absent; the rest still applies.
    expect(p.watermark).toBeUndefined()
    expect(p.fonts).toHaveLength(1)
  })
})
