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
const { importAsset, isAssetFile, looksLikeAudio, looksLikeImage } = await import('../src/main/assetIpc')
const { MEDIA_FILE_RE } = await import('../src/main/mediaProtocol')
const { writeProject } = await import('../src/main/projects')
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

  it('keeps a picked logo (watermark-<n>.<ext>) under its plain name', async () => {
    const src = project('rec-pick')
    writeFileSync(path.join(projectDir('rec-pick'), 'watermark-3.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    src.watermark = { show: true, kind: 'image', path: 'watermark-3.svg', position: 'top-left', size: 0.15, opacity: 0.7, margin: 0.02 }
    const stored = await saveStyleDefaults(lookOf(src), defaultsFile())
    expect(stored?.watermark?.path).toBe('watermark.svg')
    expect(readdirSync(userData()).filter((f) => f.startsWith('style-defaults-watermark'))).toEqual(['style-defaults-watermark.svg'])
    const applied = applyStyleDefaults(project('rec-pick-new'), await loadStyleDefaults(defaultsFile()), defaultsFile())
    expect(applied.watermark?.path).toBe('watermark.svg')
    expect(existsSync(path.join(projectDir('rec-pick-new'), 'watermark.svg'))).toBe(true)
    // A hand-edited defaults file naming a pick still finds the kept copy.
    const edited = { ...(await loadStyleDefaults(defaultsFile()))!, watermark: { ...stored!.watermark!, path: 'watermark-9.svg' } }
    expect(applyStyleDefaults(project('rec-pick-edit'), edited, defaultsFile()).watermark?.path).toBe('watermark.svg')
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

  it('a text watermark that still names the logo used before saves and applies without it', async () => {
    // Switching a logo watermark to text keeps its file name in the project (switching back reuses it).
    const src = project('rec-was-logo')
    writeFileSync(path.join(projectDir('rec-was-logo'), 'watermark-2.png'), PNG)
    src.watermark = { show: true, kind: 'text', text: 'ACME', path: 'watermark-2.png', position: 'top-left', size: 0.035, opacity: 0.8, margin: 0.02 }
    const stored = await saveStyleDefaults(lookOf(src), defaultsFile())
    expect(stored?.watermark).toMatchObject({ kind: 'text', text: 'ACME' })
    expect(stored?.watermark).not.toHaveProperty('path')
    expect(JSON.parse(readFileSync(defaultsFile(), 'utf8')).watermark).not.toHaveProperty('path')
    expect(readdirSync(userData()).filter((f) => f.startsWith('style-defaults-watermark'))).toEqual([])
    const applied = applyStyleDefaults(project('rec-after-text'), await loadStyleDefaults(defaultsFile()), defaultsFile())
    expect(applied.watermark).toMatchObject({ kind: 'text', text: 'ACME' })
    expect(applied.watermark?.path).toBeUndefined()
    // A look saved before keeps working, without the stale name.
    writeFileSync(defaultsFile(), JSON.stringify({ version: 1, style: {}, watermark: { ...src.watermark } }))
    expect((await loadStyleDefaults(defaultsFile()))?.watermark?.path).toBeUndefined()
    expect(applyStyleDefaults(project('rec-older-look'), await loadStyleDefaults(defaultsFile()), defaultsFile()).watermark).toMatchObject({ kind: 'text', text: 'ACME' })
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

  const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'
  const logos = (id: string): string[] => readdirSync(projectDir(id)).filter((f) => f.startsWith('watermark') || f.includes('.part')).sort()

  it('copies every logo in under a new name, keeping the one in use', async () => {
    project('rec-asset')
    const first = await importAsset('rec-asset', 'watermark', file('logo.png', PNG))
    expect(first.path).toBe('watermark-1.png')
    expect(first.url).toContain('/rec-asset/watermark-1.png')
    const svg = await importAsset('rec-asset', 'watermark', file('logo.svg', SVG))
    expect(svg.path).toBe('watermark-2.svg')
    // The earlier logo is still there: undo can go back to it, and it is untouched.
    expect(logos('rec-asset')).toEqual(['watermark-1.png', 'watermark-2.svg'])
    expect(readFileSync(path.join(projectDir('rec-asset'), 'watermark-1.png'))).toEqual(PNG)
  })

  it('keeps the latest few picks and the logo the saved project uses', async () => {
    const p = project('rec-many')
    writeFileSync(path.join(projectDir('rec-many'), 'watermark.png'), PNG)
    await writeProject({ ...p, watermark: { show: true, kind: 'image', path: 'watermark-2.png', position: 'top-left', size: 0.1, opacity: 1, margin: 0 } })
    for (let i = 1; i <= 9; i++) expect((await importAsset('rec-many', 'watermark', file(`logo${i}.png`, PNG))).path).toBe(`watermark-${i}.png`)
    expect(logos('rec-many')).toEqual(['watermark-2.png', 'watermark-5.png', 'watermark-6.png', 'watermark-7.png', 'watermark-8.png', 'watermark-9.png'])
  })

  it('refuses an image whose content does not match its extension, leaving the logo in use alone', async () => {
    project('rec-mismatch')
    await importAsset('rec-mismatch', 'watermark', file('ok.png', PNG))
    await expect(importAsset('rec-mismatch', 'watermark', file('png-inside.svg', PNG))).rejects.toThrow(/named \.svg but holds a PNG image: rename it to \.png/)
    await expect(importAsset('rec-mismatch', 'watermark', file('svg-inside.png', SVG))).rejects.toThrow(/named \.png but holds an SVG image/)
    await expect(importAsset('rec-mismatch', 'watermark', file('webp-inside.jpg', Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')))).rejects.toThrow(/\.jpg but holds a WebP/)
    expect(logos('rec-mismatch')).toEqual(['watermark-1.png'])
    // A .jpeg is a JPG.
    expect((await importAsset('rec-mismatch', 'watermark', file('photo.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])))).path).toBe('watermark-2.jpg')
  })

  it('serves exactly the asset names it creates', () => {
    for (const f of ['watermark.png', 'watermark-1.png', 'watermark-25.svg', 'music.mp3', 'music.flac', 'music-1.mp3', 'music-12.wav']) {
      expect(isAssetFile(f), f).toBe(true)
      expect(MEDIA_FILE_RE.test(f), f).toBe(true)
    }
    for (const f of ['watermark-0.png', 'watermark-1.gif', '.watermark-1.png.part', 'music-0.mp3', 'music-1.exe', '.music-1.mp3.part', 'project.json', '../watermark.png']) {
      expect(isAssetFile(f), f).toBe(false)
      expect(MEDIA_FILE_RE.test(f), f).toBe(false)
    }
  })

  const tracks = (id: string): string[] => readdirSync(projectDir(id)).filter((f) => f.startsWith('music') || f.includes('.part')).sort()

  it('copies every music track in under a new name, keeping the one in use (undo can go back to it)', async () => {
    project('rec-music')
    const WAV = 'RIFF\0\0\0\0WAVEfmt '
    expect((await importAsset('rec-music', 'music', file('song.wav', WAV))).path).toBe('music-1.wav')
    // Same extension or not, the earlier track is still there and untouched.
    expect((await importAsset('rec-music', 'music', file('song.mp3', 'ID3\x04\0\0'))).path).toBe('music-2.mp3')
    const again = await importAsset('rec-music', 'music', file('other.wav', 'RIFF\0\0\0\0WAVEfmt other'))
    expect(again).toMatchObject({ path: 'music-3.wav' })
    expect(again.url).toContain('/rec-music/music-3.wav')
    expect(tracks('rec-music')).toEqual(['music-1.wav', 'music-2.mp3', 'music-3.wav'])
    expect(readFileSync(path.join(projectDir('rec-music'), 'music-1.wav'), 'latin1')).toBe(WAV)
  })

  it('keeps the latest few music picks and the track the saved project uses, also an older music.<ext>', async () => {
    const p = project('rec-music-many')
    writeFileSync(path.join(projectDir('rec-music-many'), 'music.mp3'), 'ID3\x04\0\0')
    await writeProject({ ...p, audio: { ...p.audio, music: { path: 'music.mp3', volume: 0.35, ducking: 0.7, loop: true, fadeIn: 1, fadeOut: 2 } } })
    for (let i = 1; i <= 6; i++) expect((await importAsset('rec-music-many', 'music', file(`track${i}.mp3`, 'ID3\x04\0\0'))).path).toBe(`music-${i}.mp3`)
    expect(tracks('rec-music-many')).toEqual(['music-4.mp3', 'music-5.mp3', 'music-6.mp3', 'music.mp3'])
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
