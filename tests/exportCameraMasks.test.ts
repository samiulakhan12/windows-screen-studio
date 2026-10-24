import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cameraShownAt } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * The export's person masks for the camera's background blur (editor/exporter.ts): made only for
 * frames that show the camera (the webcam layer's own test), the next one while the frame before
 * is encoded, and the thumbnail loads segmentation only when its frame shows the camera. Decoding,
 * drawing, encoding and segmentation are stand-ins that log what happens, in order.
 */

const log: string[] = []
const prepared: number[] = []
let preparers = 0

interface Frame {
  image: { source: string; i: number }
  width: number
  height: number
}

/** A decoded video: the same frame object until next() moves on (like the WebCodecs source). */
class FakeSource {
  readonly kind = 'decoder'
  private frames = new Map<number, Frame>()
  constructor(private readonly name: string) {}
  async get(i: number): Promise<Frame> {
    await Promise.resolve()
    let f = this.frames.get(i)
    if (!f) {
      f = { image: { source: this.name, i }, width: this.name === 'screen' ? 1920 : 1280, height: this.name === 'screen' ? 1080 : 720 }
      this.frames.set(i, f)
    }
    return f
  }
  next(): void {}
  close(): void {}
}

vi.mock('../src/renderer/src/render/frameSource', () => ({
  openTrack: async (url: string) => ({ url, fps: 30 }),
  DecoderFrameSource: { open: async (media: { url: string }) => new FakeSource(media.url.includes('webcam') ? 'camera' : 'screen') },
  ResilientFrameSource: class {
    constructor(private readonly source: FakeSource) {}
    get kind() {
      return this.source.kind
    }
    get(i: number) {
      return this.source.get(i)
    }
    next() {
      this.source.next()
    }
    close() {
      this.source.close()
    }
  },
  ElementFrameSource: class {}
}))
vi.mock('../src/renderer/src/render/segmentation/cameraMasks', () => ({
  CameraMaskPreparer: class {
    constructor() {
      preparers++
    }
    async start() {
      return true
    }
    async prepare(frame: Frame | null) {
      if (!frame) return
      log.push(`prepare ${frame.image.i}`)
      prepared.push(frame.image.i)
      await new Promise((r) => setTimeout(r, 0))
    }
  }
}))
vi.mock('../src/renderer/src/render/compositor', () => ({
  drawFrame: (_ctx: unknown, _w: number, _h: number, _t: number, _scene: unknown, src: { screenFrame: Frame }) => void log.push(`draw ${src.screenFrame.image.i}`)
}))
vi.mock('../src/renderer/src/render/encoders', () => ({
  RawFrameSink: class {
    async push(i: number) {
      log.push(`encode ${i}`)
      await new Promise((r) => setTimeout(r, 0))
      log.push(`encoded ${i}`)
    }
    async finish() {
      return { bytes: 1 }
    }
    close() {}
  },
  WebCodecsSink: class {},
  avcConfigs: () => [],
  vp9Configs: () => [],
  supportedAvcConfig: async () => null,
  cleanIpcError: (e: unknown) => e
}))
vi.mock('../src/renderer/src/render/tiltLayer', () => ({ releaseTilt: () => undefined }))
vi.mock('../src/renderer/src/render/cursorLayer', () => ({ prepareCursorAssets: async () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ prepareStyleAssets: async () => undefined }))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({ loadAudioAnalysis: async () => ({}) }))
vi.mock('../src/renderer/src/editor/media', () => ({
  SCREEN_PROXY_FPS: 60,
  WEBCAM_PROXY_FPS: 30,
  createVideo: () => ({}),
  mediaDuration: async () => null,
  whenReady: async () => undefined
}))

const canvas = () => ({ width: 0, height: 0, getContext: () => ({}), toBlob: (cb: (b: unknown) => void) => cb({ arrayBuffer: async () => new ArrayBuffer(4) }) })
vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('window', {
  api: {
    exportCapabilities: async () => ({ hardwareEncoders: [], gpuCanvas: false, overrides: { videoEncoder: 'ffmpeg' } }),
    exportStart: async () => undefined,
    exportCancel: async () => undefined,
    exportFinish: async () => ({ bytes: 1 })
  }
})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const EXPORTER = '../src/renderer/src/editor/exporter'
type Exporter = {
  exportVideo(input: unknown): Promise<unknown>
  renderThumbnail(input: unknown): Promise<unknown>
}
const { exportVideo, renderThumbnail } = (await import(/* @vite-ignore */ EXPORTER)) as Exporter

/** A 6 s recording with a camera whose background is blurred, hidden by 'screen-only' from 1.5 to 4.5 s. */
function project(): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 6,
    width: 1920,
    height: 1080,
    hasWebcam: true,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  p.webcam = { ...p.webcam, show: true, backgroundBlur: 0.6 }
  p.layouts = [{ id: 'l', start: 1.5, end: 4.5, layout: 'screen-only' }]
  return p
}

function source(p: Project) {
  const path = { at: () => ({ x: 0.5, y: 0.5 }) }
  const cursor = { samples: [], clicks: [], valid: false }
  return { project: p, scene: { project: p, cursor, cursorPath: path, focusPath: path }, screenUrl: 'media://p/screen.mp4', webcamUrl: 'media://p/webcam.mp4', background: null }
}

const SETTINGS = { format: 'mp4', resolution: 720, fps: 30, quality: 'high', encoder: 'software' }

beforeEach(() => {
  log.length = 0
  prepared.length = 0
  preparers = 0
})

describe('export: camera person masks', () => {
  it('segments only the camera frames that are drawn, never those the layout hides', async () => {
    const p = source(project())
    await exportVideo({ ...p, settings: SETTINGS, outputPath: '/tmp/out.mp4', onProgress: () => undefined, signal: new AbortController().signal })
    const frames = log.filter((l) => l.startsWith('draw')).length
    expect(frames).toBe(180)
    // The webcam layer's test at each frame's time (1280 x 720 output of a 1920 x 1080 screen).
    const shown = Array.from({ length: frames }, (_, i) => i).filter((i) => cameraShownAt(p.project, 1280, 720, 1920, 1080, i / 30))
    expect(shown.length).toBeGreaterThan(60)
    expect(shown.length).toBeLessThan(125)
    expect([...new Set(prepared)]).toEqual(shown)
    // Nothing at all while 'screen-only' has settled (2 .. 4 s).
    expect(prepared.some((i) => i >= 60 && i < 120)).toBe(false)
  })

  it("makes the next frame's mask while this frame is encoded", async () => {
    const p = source(project())
    await exportVideo({ ...p, settings: SETTINGS, outputPath: '/tmp/out.mp4', onProgress: () => undefined, signal: new AbortController().signal })
    // Frame 1's mask is under way before frame 0 has finished encoding, and is ready before frame 1 is drawn.
    expect(log.indexOf('prepare 1')).toBeLessThan(log.indexOf('encoded 0'))
    expect(log.indexOf('prepare 1')).toBeGreaterThan(log.indexOf('draw 0'))
    expect(log.indexOf('prepare 1')).toBeLessThan(log.indexOf('draw 1'))
  })
})

describe('thumbnail: camera person mask', () => {
  it('loads segmentation only when the camera is shown at the thumbnail time', async () => {
    const p = source(project())
    await renderThumbnail({ ...p, settings: SETTINGS, time: 3 })
    expect(preparers).toBe(0)
    expect(prepared).toEqual([])
    await renderThumbnail({ ...p, settings: SETTINGS, time: 0.5 })
    expect(preparers).toBe(1)
    expect(prepared).toEqual([0])
  })
})
