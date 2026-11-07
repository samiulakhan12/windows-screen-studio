import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * The export and the thumbnail let go of the colour grade's copies for their canvas when they are
 * done (docs/design/editing-polish.md §9.3, §15), as they let go of the 3D tilt's: the grade keeps
 * an input, an output and a CPU canvas per drawing target, and an export's target is not drawn on
 * again. Decoding, drawing and encoding are stand-ins; the grade's and the tilt's release calls
 * are logged with the target they were given.
 */

const released: { layer: string; target: unknown }[] = []
const drawnOn: unknown[] = []

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
  drawFrame: (ctx: unknown) => void drawnOn.push(ctx)
}))
vi.mock('../src/renderer/src/render/encoders', () => ({
  RawFrameSink: class {
    async push() {}
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
vi.mock('../src/renderer/src/render/tiltLayer', () => ({ releaseTilt: (target: unknown) => void released.push({ layer: 'tilt', target }) }))
vi.mock('../src/renderer/src/render/gradeLayer', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  releaseGrade: (target: unknown) => void released.push({ layer: 'grade', target })
}))
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

const canvas = () => {
  const ctx = { name: 'export target' }
  return { width: 0, height: 0, getContext: () => ctx, toBlob: (cb: (b: unknown) => void) => cb({ arrayBuffer: async () => new ArrayBuffer(4) }) }
}
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

/** A 1 s recording graded warm, without a camera. */
function project(): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 1,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  return { ...p, grade: { screen: { temperature: 0.3 } } } as Project
}

function source(p: Project) {
  const path = { at: () => ({ x: 0.5, y: 0.5 }) }
  const cursor = { samples: [], clicks: [], valid: false }
  return { project: p, scene: { project: p, cursor, cursorPath: path, focusPath: path }, screenUrl: 'media://p/screen.mp4', webcamUrl: null, background: null }
}

const SETTINGS = { format: 'mp4', resolution: 720, fps: 30, quality: 'high', encoder: 'software' }

beforeEach(() => {
  released.length = 0
  drawnOn.length = 0
})

describe('the export lets go of the grade copies of its canvas', () => {
  it('after an export, the grade is released for the same target as the tilt, the one every frame was drawn on', async () => {
    await exportVideo({ ...source(project()), settings: SETTINGS, outputPath: '/tmp/out.mp4', onProgress: () => undefined, signal: new AbortController().signal })
    expect(drawnOn.length).toBe(30)
    const target = drawnOn[0]
    expect(drawnOn.every((c) => c === target)).toBe(true)
    expect(released.filter((r) => r.layer === 'tilt').map((r) => r.target)).toEqual([target])
    expect(released.filter((r) => r.layer === 'grade').map((r) => r.target)).toEqual([target])
  })

  it('after a thumbnail, too', async () => {
    await renderThumbnail({ ...source(project()), settings: SETTINGS, time: 0.5 })
    expect(drawnOn.length).toBe(1)
    expect(released.filter((r) => r.layer === 'grade').map((r) => r.target)).toEqual([drawnOn[0]])
  })

  it('also when the export is cancelled', async () => {
    const abort = new AbortController()
    let frames = 0
    const run = exportVideo({
      ...source(project()),
      settings: SETTINGS,
      outputPath: '/tmp/out.mp4',
      onProgress: () => {
        if (++frames === 3) abort.abort()
      },
      signal: abort.signal
    })
    await expect(run).rejects.toBeTruthy()
    expect(released.filter((r) => r.layer === 'grade').length).toBe(1)
  })
})
