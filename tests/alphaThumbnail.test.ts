import { describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * The thumbnail of a transparent export (docs/design/output-and-languages.md §6.5): the export
 * dialog's Frame preview shows the frame over a checkerboard, and the PNG saved from it (Save
 * thumbnail, Also save › Thumbnail) is that frame, drawn see-through on a canvas with alpha, as the
 * export draws it. An opaque export's thumbnail is drawn as before. Decoding and drawing are stand-ins.
 */

const drawn: { alpha: unknown; context: unknown }[] = []
let context: unknown = null

class FakeSource {
  readonly kind = 'decoder'
  async get(i: number) {
    await Promise.resolve()
    return { image: { i }, width: 1920, height: 1080 }
  }
  next(): void {}
  close(): void {}
}

vi.mock('../src/renderer/src/render/frameSource', () => ({
  openTrack: async (url: string) => ({ url, fps: 30 }),
  DecoderFrameSource: { open: async () => new FakeSource() },
  ResilientFrameSource: class {
    constructor(private readonly source: FakeSource) {}
    get kind() {
      return this.source.kind
    }
    get(i: number) {
      return this.source.get(i)
    }
    next() {}
    close() {}
  },
  ElementFrameSource: class {}
}))
vi.mock('../src/renderer/src/render/compositor', () => ({
  drawFrame: (_ctx: unknown, _w: number, _h: number, _t: number, scene: { alpha?: unknown }) => void drawn.push({ alpha: scene.alpha, context })
}))
vi.mock('../src/renderer/src/render/tiltLayer', () => ({ releaseTilt: () => undefined }))
vi.mock('../src/renderer/src/render/cursorLayer', () => ({ prepareCursorAssets: async () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ prepareStyleAssets: async () => undefined }))
vi.mock('../src/renderer/src/editor/media', () => ({
  SCREEN_PROXY_FPS: 60,
  WEBCAM_PROXY_FPS: 30,
  createVideo: () => ({}),
  mediaDuration: async () => null,
  whenReady: async () => undefined
}))

const canvas = () => ({
  width: 0,
  height: 0,
  getContext: (_type: string, options?: unknown) => {
    context = options ?? null
    return {}
  },
  toBlob: (cb: (b: unknown) => void) => cb({ arrayBuffer: async () => new ArrayBuffer(4) })
})
vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('window', { api: { exportCapabilities: async () => ({ hardwareEncoders: [], gpuCanvas: false, overrides: { videoEncoder: 'ffmpeg' } }) } })

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const EXPORTER = '../src/renderer/src/editor/exporter'
const { renderThumbnail } = (await import(/* @vite-ignore */ EXPORTER)) as { renderThumbnail(input: unknown): Promise<{ png: Uint8Array }> }

function project(): Project {
  return createProject({ id: 'p', name: 'p', duration: 4, width: 1920, height: 1080, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'native', cursorInVideo: false, region: null } })
}

function source(p: Project) {
  const path = { at: () => ({ x: 0.5, y: 0.5 }) }
  return { project: p, scene: { project: p, cursor: { samples: [], clicks: [], valid: false }, cursorPath: path, focusPath: path }, screenUrl: 'media://p/screen.mp4', webcamUrl: null, background: null }
}

const BASE = { resolution: 720, fps: 30, quality: 'high', encoder: 'software' }

/** The scene alpha and context options the thumbnail of `settings` is drawn with. */
async function thumbnail(settings: Record<string, unknown>): Promise<{ alpha: unknown; context: unknown }> {
  drawn.length = 0
  const shot = await renderThumbnail({ ...source(project()), settings: { ...BASE, ...settings }, time: 1 })
  expect(shot.png.byteLength).toBe(4)
  expect(drawn).toHaveLength(1)
  return drawn[0]
}

describe('the thumbnail of a transparent export (output-and-languages §6.5)', () => {
  it('is drawn see-through on a canvas with alpha, as the export draws its frames', async () => {
    expect(await thumbnail({ format: 'webm', alpha: 'background' })).toEqual({ alpha: 'background', context: { alpha: true } })
    expect(await thumbnail({ format: 'mov', codec: 'cineform', alpha: 'overlays' })).toEqual({ alpha: 'overlays', context: { alpha: true } })
    expect(await thumbnail({ format: 'mov', codec: 'animation', alpha: 'background' })).toEqual({ alpha: 'background', context: { alpha: true } })
  })

  it('an opaque export, or a Background its format cannot carry, is drawn as before', async () => {
    expect(await thumbnail({ format: 'mp4' })).toEqual({ alpha: undefined, context: { alpha: false } })
    expect(await thumbnail({ format: 'webm' })).toEqual({ alpha: undefined, context: { alpha: false } })
    expect(await thumbnail({ format: 'mp4', alpha: 'background' })).toEqual({ alpha: undefined, context: { alpha: false } })
    expect(await thumbnail({ format: 'm4a', alpha: 'background' })).toEqual({ alpha: undefined, context: { alpha: false } })
  })
})
