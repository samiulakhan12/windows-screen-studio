import { describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { OVERLAYS_MAX_BYTES } from '../src/shared/render/imageOverlays'
import type { ImageOverlay, Project } from '../src/shared/types'

/*
 * Decoding image overlays (docs/design/brand-kit.md §4) from a fake project folder. URLs are
 * matched without their ?v=; a file in `missing` cannot be read, any other loads. As in Chromium,
 * an SVG with HTML in it (here: a URL with "html") taints every canvas it is drawn into, and a
 * tainted canvas cannot be read back (getImageData, VideoFrame). A GIF's file (`gifs`) declares its
 * size, frame count and file length; the fake decoder and createImageBitmap count the bitmap bytes
 * alive and the decoders open at once.
 */

const missing = new Set<string>()
/** Natural size of a still, by URL (400 x 200 when not listed). */
const sizes = new Map<string, [number, number]>()
const gifs = new Map<string, { width: number; height: number; frames: number; fileBytes?: number }>()
const live = { bytes: 0, peakBytes: 0, decoders: 0, peakDecoders: 0, reads: 0 }
const path = (url: string): string => url.split('?')[0]
const urlOf = (projectId: string, file: string): string => `studio-media://project/${projectId}/${file}`

class FakeImage {
  naturalWidth = 400
  naturalHeight = 200
  tainted = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  crossOrigin = ''
  decoding = ''
  set src(url: string) {
    this.tainted = url.includes('html')
    ;[this.naturalWidth, this.naturalHeight] = sizes.get(path(url)) ?? [400, 200]
    setTimeout(() => (missing.has(path(url)) ? this.onerror?.() : this.onload?.()), 0)
  }
}

function fakeCanvas(): Record<string, unknown> {
  const canvas: Record<string, unknown> = { width: 0, height: 0, tainted: false }
  const ctx = {
    canvas,
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    drawImage(source: { tainted?: boolean }) {
      if (source.tainted) canvas.tainted = true
    },
    getImageData() {
      if (canvas.tainted) throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError')
      return { data: new Uint8ClampedArray(4) }
    }
  }
  canvas.getContext = () => ctx
  return canvas
}

vi.stubGlobal('document', { createElement: () => fakeCanvas() })
vi.stubGlobal('Image', FakeImage)
vi.stubGlobal('fetch', async (url: string) => {
  const gif = gifs.get(path(url))
  if (!gif) return { ok: false, status: 404 }
  // GIF header with the logical screen size; the fake decoder reads the frame count from bytes 10..11.
  const bytes = new Uint8Array(16)
  bytes.set([...'GIF89a'].map((c) => c.charCodeAt(0)))
  bytes.set([gif.width & 255, gif.width >> 8, gif.height & 255, gif.height >> 8, gif.frames & 255, gif.frames >> 8], 6)
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(gif.fileBytes ?? bytes.length) : null) },
    arrayBuffer: async () => {
      live.reads++
      return bytes.buffer
    }
  }
})
vi.stubGlobal(
  'ImageDecoder',
  class {
    tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } }
    completed = Promise.resolve()
    width: number
    height: number
    constructor({ data }: { data: ArrayBuffer }) {
      const b = new Uint8Array(data)
      this.width = b[6] | (b[7] << 8)
      this.height = b[8] | (b[9] << 8)
      this.tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: b[10] | (b[11] << 8) } }
      live.peakDecoders = Math.max(live.peakDecoders, ++live.decoders)
    }
    async decode(): Promise<unknown> {
      await new Promise((r) => setTimeout(r, 0))
      return { image: { displayWidth: this.width, displayHeight: this.height, duration: 100_000, close() {} } }
    }
    close(): void {
      live.decoders--
    }
  }
)
vi.stubGlobal('createImageBitmap', async (_image: unknown, o: { resizeWidth: number; resizeHeight: number }) => {
  const bytes = o.resizeWidth * o.resizeHeight * 4
  live.bytes += bytes
  live.peakBytes = Math.max(live.peakBytes, live.bytes)
  return { width: o.resizeWidth, height: o.resizeHeight, close: () => (live.bytes -= bytes) }
})
vi.spyOn(console, 'warn').mockImplementation(() => {})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type Source = Pick<ImageOverlay, 'file' | 'sticker'>
type Status = { state: 'loading' } | { state: 'ready'; aspect: number; frames: number } | { state: 'failed'; error: string }
const RENDER = '../src/renderer/src/render/'
const overlays = (await import(/* @vite-ignore */ `${RENDER}overlayLayer`)) as {
  preloadOverlay: (projectId: string, o: Source, url?: string) => Promise<number>
  overlayStatus: (projectId: string, o: Source) => Status
  prepareOverlays: (p: Pick<Project, 'id' | 'overlays'>) => Promise<void>
  missingOverlays: (p: Pick<Project, 'id' | 'overlays'>) => ImageOverlay[]
  drawOverlaysLayer: (fc: unknown) => void
}
const watermarks = (await import(/* @vite-ignore */ `${RENDER}watermarkLayer`)) as {
  preloadWatermarkImage: (projectId: string, file: string, url?: string) => Promise<void>
  checkKitLogo: (file: string, bytes: Uint8Array | null) => Promise<void>
  prepareStyleAssets: (p: Project, url: (file: string) => string) => Promise<void>
  drawWatermarkLayer: (fc: unknown) => void
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

function project(id: string, extra: Partial<Project> = {}): Project {
  const p = createProject({
    id,
    name: id,
    duration: 10,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  return { ...p, ...extra }
}

const overlay = (id: string, file: string): ImageOverlay => ({ id, start: 0, end: 5, file, name: file, x: 0.5, y: 0.5, w: 0.3, h: 0.15, rotation: 0, opacity: 1, fadeIn: 0, fadeOut: 0 })

/** A frame drawn on a fresh output canvas: whether the export could still read it back. */
function exportable(draw: (fc: unknown) => void, p: Project): boolean {
  const canvas = fakeCanvas()
  const ctx = (canvas.getContext as () => { getImageData: () => unknown })()
  draw({ ctx, w: 1920, h: 1080, t: 1, k: 1, project: p, background: null })
  try {
    ctx.getImageData()
    return true
  } catch {
    return false
  }
}

describe('overlay decoding', () => {
  it('an image whose file was missing shows when it is added again under the same name', async () => {
    const o = { file: 'overlay-1.png' }
    missing.add(urlOf('p6', o.file))
    overlays.overlayStatus('p6', o)
    await settle()
    expect(overlays.overlayStatus('p6', o)).toEqual({ state: 'failed', error: 'This image could not be read.' })
    // "Add image…" again: main writes the same name back, and the editor preloads it.
    missing.delete(urlOf('p6', o.file))
    await expect(overlays.preloadOverlay('p6', o, urlOf('p6', o.file))).resolves.toBe(2)
    expect(overlays.overlayStatus('p6', o)).toEqual({ state: 'ready', aspect: 2, frames: 1 })
  })
})

describe('SVGs with HTML in them (they taint the canvas)', () => {
  it('are refused when added, with a reason', async () => {
    await expect(overlays.preloadOverlay('p4', { file: 'overlay-1.svg' }, urlOf('p4', 'html-overlay-1.svg'))).rejects.toThrow(/HTML/)
    await expect(overlays.preloadOverlay('p4', { file: 'overlay-2.svg' }, urlOf('p4', 'plain-overlay-2.svg'))).resolves.toBe(2)
  })

  it('in a project are left out of the video (and listed), so the export can still read its frames', async () => {
    // overlay-html-1.svg: the URL the layer builds for it contains "html".
    const p = project('p4b', { overlays: [overlay('a', 'overlay-html-1.svg'), overlay('b', 'overlay-2.svg')] })
    await overlays.prepareOverlays(p)
    expect(overlays.missingOverlays(p).map((o) => o.id)).toEqual(['a'])
    expect(overlays.overlayStatus('p4b', { file: 'overlay-html-1.svg' })).toMatchObject({ state: 'failed', error: expect.stringMatching(/HTML/) })
    expect(exportable(overlays.drawOverlaysLayer, p)).toBe(true)
  })

  it('as a logo are refused, and left out of the video', async () => {
    await expect(watermarks.preloadWatermarkImage('p4c', 'watermark-1.svg', urlOf('p4c', 'html-logo.svg'))).rejects.toThrow()
    const p = project('p4c', { watermark: { show: true, kind: 'image', path: 'watermark-2.svg', position: 'bottom-right', size: 0.1, margin: 0.03, opacity: 1 } })
    await watermarks.prepareStyleAssets(p, (file) => urlOf('p4c', `html-${file}`))
    expect(exportable(watermarks.drawWatermarkLayer, p)).toBe(true)
  })

  it('as the brand kit logo are refused when picked in Settings', async () => {
    // Settings reads the picked file's bytes into a blob: URL (here named after what it holds).
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:html-logo').mockReturnValueOnce('blob:plain-logo')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    await expect(watermarks.checkKitLogo('logo-1.svg', bytes)).rejects.toThrow(/HTML/)
    await expect(watermarks.checkKitLogo('logo-2.svg', bytes)).resolves.toBeUndefined()
    await expect(watermarks.checkKitLogo('logo-3.svg', null)).rejects.toThrow('This image could not be read.')
    await expect(watermarks.checkKitLogo('logo-4.png', bytes)).resolves.toBeUndefined()
    expect(made).toHaveBeenCalledTimes(2)
    expect(revoked).toHaveBeenCalledTimes(2)
    made.mockRestore()
    revoked.mockRestore()
  })
})

describe('memory of the decoded pictures', () => {
  const TOO_MANY = 'This video has too many large images to show this one too.'
  const states = (projectId: string, p: Project): string[] => (p.overlays ?? []).map((o) => overlays.overlayStatus(projectId, o).state)

  it('many small GIFs that decode large stay within the budget, one decoding at a time', async () => {
    // 720 x 720, 100 frames: a few KB on disk, about 207 MB decoded (under the 200 MiB a GIF may take).
    const list = Array.from({ length: 100 }, (_, i) => overlay(`g${i}`, `overlay-${i + 1}.gif`))
    for (const o of list) gifs.set(urlOf('p1', o.file!), { width: 720, height: 720, frames: 100 })
    const p = project('p1', { overlays: list })
    await overlays.prepareOverlays(p)
    expect(live.peakBytes).toBeLessThanOrEqual(OVERLAYS_MAX_BYTES)
    expect(live.peakDecoders).toBe(1)
    const ready = states('p1', p).filter((s) => s === 'ready').length
    expect(ready).toBe(Math.floor(OVERLAYS_MAX_BYTES / (720 * 720 * 4 * 100)))
    expect(overlays.missingOverlays(p)).toHaveLength(100 - ready)
    expect(overlays.overlayStatus('p1', list[99])).toEqual({ state: 'failed', error: TOO_MANY })
  })

  it('stills count too, and another project gets the whole budget again', async () => {
    // 2048 x 2048: 16 MiB each, so 64 fit.
    const list = Array.from({ length: 70 }, (_, i) => overlay(`s${i}`, `overlay-${i + 1}.png`))
    for (const o of list) sizes.set(urlOf('p2', o.file!), [2048, 2048])
    const p = project('p2', { overlays: list })
    await overlays.prepareOverlays(p)
    expect(states('p2', p).filter((s) => s === 'ready')).toHaveLength(OVERLAYS_MAX_BYTES / (2048 * 2048 * 4))
    expect(overlays.overlayStatus('p2', list[69])).toEqual({ state: 'failed', error: TOO_MANY })
    // Opening another project forgets these pictures (and their bytes).
    sizes.set(urlOf('p3', 'overlay-1.png'), [2048, 2048])
    await expect(overlays.preloadOverlay('p3', { file: 'overlay-1.png' })).resolves.toBe(1)
  })

  it('images no longer in the video (deleted or undone) give their room back', async () => {
    for (let n = 1; n <= 6; n++) gifs.set(urlOf('u1', `overlay-${n}.gif`), { width: 720, height: 720, frames: 100 })
    const draw = (p: Project): boolean => exportable(overlays.drawOverlaysLayer, p)
    // Five long GIFs tried one after another, each undone: the video has no images when a sixth is added.
    for (let n = 1; n <= 5; n++) {
      await overlays.preloadOverlay('u1', { file: `overlay-${n}.gif` })
      draw(project('u1', { overlays: [overlay('g', `overlay-${n}.gif`)] }))
      draw(project('u1', { overlays: [] }))
    }
    await expect(overlays.preloadOverlay('u1', { file: 'overlay-6.gif' })).resolves.toBe(1)
    expect(live.bytes).toBeLessThanOrEqual(OVERLAYS_MAX_BYTES)
    // Undo brings one back: its picture is decoded again.
    const back = project('u1', { overlays: [overlay('a', 'overlay-1.gif'), overlay('b', 'overlay-6.gif')] })
    await overlays.prepareOverlays(back)
    expect(states('u1', back)).toEqual(['ready', 'ready'])
  })

  it('an image left out for lack of room shows once other images are deleted', async () => {
    const list = Array.from({ length: 6 }, (_, i) => overlay(`h${i}`, `overlay-${i + 1}.gif`))
    for (const o of list) gifs.set(urlOf('u2', o.file!), { width: 720, height: 720, frames: 100 })
    const p = project('u2', { overlays: list })
    await overlays.prepareOverlays(p)
    expect(overlays.overlayStatus('u2', list[5])).toEqual({ state: 'failed', error: TOO_MANY })
    // Editing the images frees nothing: the one left out is not decoded again on every change.
    const reads = live.reads
    await overlays.prepareOverlays(project('u2', { overlays: list.map((o) => ({ ...o, x: 0.4 })) }))
    expect(live.reads).toBe(reads)
    // Two others deleted: now it fits.
    const after = project('u2', { overlays: list.slice(2) })
    await overlays.prepareOverlays(after)
    expect(states('u2', after)).toEqual(['ready', 'ready', 'ready', 'ready'])
    expect(overlays.missingOverlays(after)).toEqual([])
  })

  it('GIFs still waiting to decode when another project opens are skipped', async () => {
    const list = [1, 2, 3].map((n) => overlay(`q${n}`, `overlay-${n}.gif`))
    for (const o of list) gifs.set(urlOf('q1', o.file!), { width: 100, height: 100, frames: 2 })
    gifs.set(urlOf('q2', 'overlay-1.gif'), { width: 100, height: 100, frames: 2 })
    const reads = live.reads
    void overlays.prepareOverlays(project('q1', { overlays: list }))
    await expect(overlays.preloadOverlay('q2', { file: 'overlay-1.gif' })).resolves.toBe(1)
    expect(live.reads - reads).toBe(1)
  })

  it('a GIF file larger than images may be (put in the folder by hand) is refused before it is read', async () => {
    gifs.set(urlOf('p5', 'overlay-1.gif'), { width: 100, height: 100, frames: 2, fileBytes: 300 * 1024 * 1024 })
    const reads = live.reads
    await expect(overlays.preloadOverlay('p5', { file: 'overlay-1.gif' })).rejects.toThrow('This image is too large (25 MB at most).')
    expect(live.reads).toBe(reads)
  })
})
