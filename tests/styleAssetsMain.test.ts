import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ root: '' }))
h.root = mkdtempSync(path.join(tmpdir(), 'ssw-style-assets-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(h.root, name), isPackaged: false, getAppPath: () => h.root },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => undefined },
  BrowserWindow: class {},
  shell: {}
}))

const { applyStyleDefaults, loadStyleDefaults, saveStyleDefaults } = await import('../src/main/styleDefaults')
const { importAsset, looksLikeAudio, looksLikeImage } = await import('../src/main/assetIpc')
const { lookOf } = await import('../src/shared/editor/styleDefaults')
const { createProject } = await import('../src/shared/engine/project')
const { projectDir } = await import('../src/main/projects')

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const userData = () => path.join(h.root, 'userData')
const defaultsFile = () => path.join(userData(), 'style-defaults.json')

function project(id: string) {
  mkdirSync(projectDir(id), { recursive: true })
  return createProject({
    id,
    name: id,
    duration: 5,
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

beforeEach(async () => {
  await saveStyleDefaults(null, defaultsFile())
})

describe('saved look with a watermark (main process)', () => {
  it('keeps a copy of the watermark image and copies it into new recordings', async () => {
    const src = project('rec-src')
    writeFileSync(path.join(projectDir('rec-src'), 'watermark.png'), PNG)
    src.watermark = { show: true, kind: 'image', path: 'watermark.png', position: 'top-left', size: 0.15, opacity: 0.7, margin: 0.02 }
    src.style = { ...src.style, frame: { kind: 'browser', theme: 'dark', title: 'acme.dev' }, border: { width: 4, color: '#ffffff', glass: true }, shadowStyle: 'glow', shadowColor: '#ff00ff' }
    src.zoomSettings = { ...src.zoomSettings!, defaultScale: 1.5, easing: 'bouncy', transition: 1.2 }
    const stored = await saveStyleDefaults(lookOf(src), defaultsFile())
    expect(stored?.watermark).toMatchObject({ kind: 'image', path: 'watermark.png', position: 'top-left' })
    expect(stored).not.toHaveProperty('source')
    expect(JSON.parse(readFileSync(defaultsFile(), 'utf8'))).not.toHaveProperty('source')
    expect(readFileSync(path.join(userData(), 'style-defaults-watermark.png'))).toEqual(PNG)

    const fresh = project('rec-new')
    const applied = applyStyleDefaults(fresh, await loadStyleDefaults(defaultsFile()), defaultsFile())
    expect(applied.watermark).toEqual(stored?.watermark)
    expect(readFileSync(path.join(projectDir('rec-new'), 'watermark.png'))).toEqual(PNG)
    expect(applied.style).toMatchObject({ frame: { kind: 'browser', theme: 'dark', title: 'acme.dev' }, border: { width: 4, glass: true }, shadowStyle: 'glow', shadowColor: '#ff00ff' })
    expect(applied.zoomSettings).toMatchObject({ defaultScale: 1.5, easing: 'bouncy', transition: 1.2 })
  })

  it('saves the look without the watermark when its image is missing, and never copies one in', async () => {
    const src = project('rec-missing')
    src.watermark = { show: true, kind: 'image', path: 'watermark.webp', position: 'center', size: 0.1, opacity: 1, margin: 0 }
    const stored = await saveStyleDefaults(lookOf(src), defaultsFile())
    expect(stored?.watermark).toBeUndefined()
    expect(stored?.style.padding).toBe(src.style.padding)
    expect(readdirSync(userData()).filter((f) => f.startsWith('style-defaults-watermark'))).toEqual([])
  })

  it('a text watermark needs no file, and replaces an earlier image copy', async () => {
    const src = project('rec-img')
    writeFileSync(path.join(projectDir('rec-img'), 'watermark.png'), PNG)
    src.watermark = { show: true, kind: 'image', path: 'watermark.png', position: 'top-left', size: 0.15, opacity: 0.7, margin: 0.02 }
    await saveStyleDefaults(lookOf(src), defaultsFile())
    src.watermark = { show: true, kind: 'text', text: '© ACME', position: 'bottom-right', size: 0.04, opacity: 0.8, margin: 0.03 }
    await saveStyleDefaults(lookOf(src), defaultsFile())
    expect(existsSync(path.join(userData(), 'style-defaults-watermark.png'))).toBe(false)
    const applied = applyStyleDefaults(project('rec-text'), await loadStyleDefaults(defaultsFile()), defaultsFile())
    expect(applied.watermark).toMatchObject({ kind: 'text', text: '© ACME' })
  })

  it('drops the watermark from a new recording when the saved copy is gone', async () => {
    const src = project('rec-gone')
    writeFileSync(path.join(projectDir('rec-gone'), 'watermark.png'), PNG)
    src.watermark = { show: true, kind: 'image', path: 'watermark.png', position: 'top-left', size: 0.15, opacity: 0.7, margin: 0.02 }
    await saveStyleDefaults(lookOf(src), defaultsFile())
    rmSync(path.join(userData(), 'style-defaults-watermark.png'))
    const applied = applyStyleDefaults(project('rec-after'), await loadStyleDefaults(defaultsFile()), defaultsFile())
    expect(applied.watermark).toBeUndefined()
    expect(applied.style.padding).toBe(src.style.padding)
  })

  it('reset removes the image copy too', async () => {
    const src = project('rec-reset')
    writeFileSync(path.join(projectDir('rec-reset'), 'watermark.png'), PNG)
    src.watermark = { show: true, kind: 'image', path: 'watermark.png', position: 'top-left', size: 0.15, opacity: 0.7, margin: 0.02 }
    await saveStyleDefaults(lookOf(src), defaultsFile())
    await saveStyleDefaults(null, defaultsFile())
    expect(readdirSync(userData()).filter((f) => f.startsWith('style-defaults'))).toEqual([])
  })

  it('refuses to read a watermark from outside the projects folder', async () => {
    const src = project('rec-evil')
    src.watermark = { show: true, kind: 'image', path: 'watermark.png', position: 'top-left', size: 0.15, opacity: 0.7, margin: 0.02 }
    const stored = await saveStyleDefaults({ ...lookOf(src), source: '../..' }, defaultsFile())
    expect(stored?.watermark).toBeUndefined()
  })
})

describe('importAsset', () => {
  const dir = path.join(h.root, 'picked')
  mkdirSync(dir, { recursive: true })
  const file = (name: string, data: Buffer | string): string => {
    const f = path.join(dir, name)
    writeFileSync(f, data)
    return f
  }

  it('copies a real image in as watermark.<ext>, replacing an earlier pick', async () => {
    project('rec-asset')
    const first = await importAsset('rec-asset', 'watermark', file('logo.png', PNG))
    expect(first.path).toBe('watermark.png')
    const svg = await importAsset('rec-asset', 'watermark', file('logo.svg', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))
    expect(svg.path).toBe('watermark.svg')
    const files = readdirSync(projectDir('rec-asset'))
    expect(files.filter((f) => f.startsWith('watermark') || f.includes('.part'))).toEqual(['watermark.svg'])
  })

  it('refuses wrong types, disguised files, empty files, folders and bad ids', async () => {
    project('rec-bad')
    await expect(importAsset('rec-bad', 'watermark', file('notes.txt', 'hello'))).rejects.toThrow(/PNG, JPG, WebP or SVG/)
    await expect(importAsset('rec-bad', 'watermark', file('fake.png', 'MZ this is an exe'))).rejects.toThrow(/could not be read/)
    await expect(importAsset('rec-bad', 'watermark', file('empty.png', ''))).rejects.toThrow(/empty/)
    mkdirSync(path.join(dir, 'folder.png'), { recursive: true })
    await expect(importAsset('rec-bad', 'watermark', path.join(dir, 'folder.png'))).rejects.toThrow()
    await expect(importAsset('../escape', 'watermark', file('ok.png', PNG))).rejects.toThrow(/Invalid project id/)
    await expect(importAsset('rec-bad', 'toString' as 'watermark', file('ok2.png', PNG))).rejects.toThrow(/Unknown asset kind/)
    // Nothing was left behind.
    expect(readdirSync(projectDir('rec-bad')).filter((f) => f !== 'project.json')).toEqual([])
  })

  it('recognises common image and audio headers', () => {
    expect(looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true)
    expect(looksLikeImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe(true)
    expect(looksLikeImage(Buffer.from('GIF89a'))).toBe(false)
    expect(looksLikeAudio(Buffer.from('ID3\x04'))).toBe(true)
    expect(looksLikeAudio(Buffer.from('\0\0\0\x20ftypM4A ', 'latin1'))).toBe(true)
    expect(looksLikeAudio(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1'))).toBe(true)
    expect(looksLikeAudio(Buffer.from('OggS'))).toBe(true)
    expect(looksLikeAudio(Buffer.from('fLaC'))).toBe(true)
    expect(looksLikeAudio(Buffer.from([0xff, 0xfb, 0x90]))).toBe(true)
    expect(looksLikeAudio(Buffer.from('<html>'))).toBe(false)
  })
})
