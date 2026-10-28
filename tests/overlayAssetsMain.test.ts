import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: unknown[]) => unknown>(), clipboard: [] as Uint8Array[] }))
h.root = mkdtempSync(path.join(tmpdir(), 'ssw-overlay-assets-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(h.root, name), isPackaged: false, getAppPath: () => h.root },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  // The system clipboard holds each of h.clipboard as a PNG.
  clipboard: { read: async () => h.clipboard.map((png) => ({ types: ['image/png'], getType: async () => new Blob([png], { type: 'image/png' }) })) },
  BrowserWindow: class {},
  shell: {}
}))

const { importAsset, importAssetData, imageType, isAssetFile, looksLikeImage, registerAssetIpc } = await import('../src/main/assetIpc')
const { OVERLAY_MAX_BYTES } = await import('../src/shared/engine/overlayData')
const { MEDIA_FILE_RE } = await import('../src/main/mediaProtocol')
const { projectDir } = await import('../src/main/projects')

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
const TTF = Buffer.from([0, 1, 0, 0, 0, 10, 0, 0])
const WOFF2 = Buffer.from('wOF2\0\0\0\0', 'latin1')

let n = 0
function folder(): string {
  const id = `rec-ov-${n++}`
  mkdirSync(projectDir(id), { recursive: true })
  return id
}
function file(name: string, data: Buffer): string {
  const dir = path.join(h.root, 'src', String(n++))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, name), data)
  return path.join(dir, name)
}
const listed = (id: string): string[] => readdirSync(projectDir(id)).sort()

describe('image overlays and fonts as project assets', () => {
  it('recognises GIFs, but a GIF is still no logo', () => {
    expect(imageType(GIF)).toBe('gif')
    expect(looksLikeImage(GIF)).toBe(false)
    expect(looksLikeImage(PNG)).toBe(true)
  })

  it('copies a picked image in as overlay-<n> and keeps its name for the editor', async () => {
    const id = folder()
    const r = await importAsset(id, 'overlay', file('Logo Final.png', PNG))
    expect(r).toMatchObject({ path: 'overlay-1.png', name: 'Logo Final.png' })
    expect(r.url).toMatch(/^studio-media:\/\/project\/.+\/overlay-1\.png\?v=\d+$/)
    const g = await importAsset(id, 'overlay', file('party.gif', GIF))
    expect(g.path).toBe('overlay-2.gif')
    expect(listed(id)).toEqual(['overlay-1.png', 'overlay-2.gif'])
  })

  it('stores an identical image once and never removes earlier ones', async () => {
    const id = folder()
    const a = await importAssetData(id, 'overlay', 'a.png', PNG)
    const b = await importAssetData(id, 'overlay', 'b.png', new Uint8Array(PNG))
    expect(a.path).toBe('overlay-1.png')
    expect(b.path).toBe('overlay-1.png')
    for (let i = 0; i < 7; i++) await importAssetData(id, 'overlay', 'x.png', Buffer.concat([PNG, Buffer.from([i])]))
    expect(listed(id)).toHaveLength(8)
  })

  it('refuses content that does not match the extension, and other formats', async () => {
    const id = folder()
    await expect(importAssetData(id, 'overlay', 'a.png', GIF)).rejects.toThrow(/named \.png but holds a GIF image: rename it to \.gif/)
    await expect(importAssetData(id, 'overlay', 'a.gif', Buffer.from('hello world'))).rejects.toThrow(/could not be read as a PNG, JPG, WebP, SVG or GIF/)
    await expect(importAssetData(id, 'overlay', 'a.exe', PNG)).rejects.toThrow(/Only PNG, JPG, WebP, SVG and GIF/)
    await expect(importAssetData(id, 'overlay', 'a.png', new Uint8Array())).rejects.toThrow(/empty/)
    await expect(importAsset(id, 'watermark', file('a.gif', GIF))).rejects.toThrow(/Choose a PNG, JPG, WebP or SVG/)
    expect(listed(id)).toEqual([])
  })

  it('refuses images over 25 MB and SVGs over 2 MB before reading them', async () => {
    const id = folder()
    const big = Buffer.alloc(25 * 1024 * 1024 + 1)
    PNG.copy(big)
    await expect(importAssetData(id, 'overlay', 'big.png', big)).rejects.toThrow(/The file is too large \(26 MB; 25 MB at most\)/)
    const bigSvg = Buffer.concat([SVG, Buffer.alloc(2 * 1024 * 1024, 32)])
    await expect(importAssetData(id, 'overlay', 'big.svg', bigSvg)).rejects.toThrow(/too large/)
    await expect(importAsset(id, 'overlay', file('big.svg', bigSvg))).rejects.toThrow(/too large/)
    expect((await importAssetData(id, 'overlay', 'ok.svg', SVG)).path).toBe('overlay-1.svg')
  })

  it('stores images added at the same time one after the other, each under its own name', async () => {
    const id = folder()
    const images = [1, 2, 3, 4].map((i) => Buffer.concat([PNG, Buffer.alloc(256 * 1024, i)]))
    const picked = await Promise.all(images.map((data, i) => importAssetData(id, 'overlay', `${i}.png`, data)))
    expect(picked.map((p) => p.path).sort()).toEqual(['overlay-1.png', 'overlay-2.png', 'overlay-3.png', 'overlay-4.png'])
    picked.forEach((p, i) => expect(readFileSync(path.join(projectDir(id), p.path)).equals(images[i]), p.path).toBe(true))
    // The same image pasted twice in a row is stored once.
    const again = Buffer.concat([PNG, Buffer.alloc(256 * 1024, 9)])
    const twice = await Promise.all([importAssetData(id, 'overlay', 'a.png', again), importAssetData(id, 'overlay', 'b.png', again)])
    expect(twice.map((p) => p.path)).toEqual(['overlay-5.png', 'overlay-5.png'])
    expect(listed(id)).toEqual(['overlay-1.png', 'overlay-2.png', 'overlay-3.png', 'overlay-4.png', 'overlay-5.png'])
  })

  it('never uses the dropped name as a path', async () => {
    const id = folder()
    const r = await importAssetData(id, 'overlay', '..\\..\\..\\evil\\x.png', PNG)
    expect(r).toMatchObject({ path: 'overlay-1.png', name: 'x.png' })
    const r2 = await importAssetData(id, 'overlay', '../../etc/passwd.svg', SVG)
    expect(r2.path).toBe('overlay-2.svg')
    expect(listed(id)).toEqual(['overlay-1.png', 'overlay-2.svg'])
    expect(readdirSync(path.join(projectDir(id), '..')).some((f) => f.includes('evil') || f.includes('passwd'))).toBe(false)
  })

  it('takes bytes only for overlays and fonts', async () => {
    const id = folder()
    await expect(importAssetData(id, 'watermark', 'a.png', PNG)).rejects.toThrow(/Unknown asset kind/)
    await expect(importAssetData(id, 'music', 'a.mp3', PNG)).rejects.toThrow(/Unknown asset kind/)
    await expect(importAssetData('../x', 'overlay', 'a.png', PNG)).rejects.toThrow()
  })

  it('copies fonts in as font-<n>, checked by content and size', async () => {
    const id = folder()
    expect((await importAsset(id, 'font', file('Brand Sans.ttf', TTF))).path).toBe('font-1.ttf')
    expect((await importAssetData(id, 'font', 'brand.woff2', WOFF2)).path).toBe('font-2.woff2')
    expect((await importAssetData(id, 'font', 'again.ttf', TTF)).path).toBe('font-1.ttf')
    await expect(importAssetData(id, 'font', 'x.ttf', WOFF2)).rejects.toThrow(/rename it to \.woff2/)
    await expect(importAssetData(id, 'font', 'x.woff', WOFF2)).rejects.toThrow(/TTF, OTF or WOFF2/)
    const big = Buffer.alloc(15 * 1024 * 1024 + 1)
    TTF.copy(big)
    await expect(importAssetData(id, 'font', 'big.ttf', big)).rejects.toThrow(/too large/)
    expect(readFileSync(path.join(projectDir(id), 'font-1.ttf'))).toEqual(TTF)
  })

  it('serves overlay and font files, and nothing that only looks like one', () => {
    for (const f of ['overlay-1.png', 'overlay-12.gif', 'overlay-3.svg', 'font-1.ttf', 'font-2.woff2', 'font-3.otf']) {
      expect(isAssetFile(f), f).toBe(true)
      expect(MEDIA_FILE_RE.test(f), f).toBe(true)
    }
    for (const f of ['overlay-0.png', 'overlay.png', 'overlay-1.html', 'font-1.woff', 'font-1.ttf/../x', '../overlay-1.png', 'overlay-1.png.exe']) {
      expect(isAssetFile(f), f).toBe(false)
      expect(MEDIA_FILE_RE.test(f), f).toBe(false)
    }
  })
})

describe('the clipboard image for Ctrl+V', () => {
  beforeAll(() => registerAssetIpc())
  const appEvent = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href } }
  const clipboardImage = (withBytes: unknown, e: unknown = appEvent): Promise<unknown> => Promise.resolve(h.handlers.get('projects:clipboardImage')!(e, withBytes))
  const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

  it('gives the image by its fingerprint and size, and its bytes when asked', async () => {
    h.clipboard = [PNG]
    expect(await clipboardImage(false)).toEqual({ hash: sha256(PNG), size: PNG.length })
    expect(await clipboardImage(true)).toEqual({ hash: sha256(PNG), size: PNG.length, png: new Uint8Array(PNG) })
  })

  it('reports an image over 25 MB by its fingerprint and size, and never sends its bytes', async () => {
    const big = Buffer.alloc(OVERLAY_MAX_BYTES + 1)
    PNG.copy(big)
    h.clipboard = [big]
    expect(await clipboardImage(false)).toEqual({ hash: sha256(big), size: big.length })
    expect(await clipboardImage(true)).toEqual({ hash: sha256(big), size: big.length })
  })

  it('is null without an image, and refused to other pages', async () => {
    h.clipboard = []
    expect(await clipboardImage(true)).toBeNull()
    h.clipboard = [new Uint8Array()]
    expect(await clipboardImage(true)).toBeNull()
    await expect(clipboardImage(true, { senderFrame: { url: 'https://example.com/' } })).rejects.toThrow(/Not allowed/)
  })
})
