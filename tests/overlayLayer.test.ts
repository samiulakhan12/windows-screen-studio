import { describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { ImageOverlay, Project } from '../src/shared/types'

/*
 * Decoding image overlays (docs/design/brand-kit.md §4) from a fake project folder. URLs are
 * matched without their ?v=; a file in `missing` cannot be read, any other loads. As in Chromium,
 * an SVG with HTML in it (here: a URL with "html") taints every canvas it is drawn into, and a
 * tainted canvas cannot be read back (getImageData, VideoFrame).
 */

const missing = new Set<string>()
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
})
