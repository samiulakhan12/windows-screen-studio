import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { joinFeed, joinPlan, trackTimes } from '../src/shared/render/joins'
import { planOf, videoFrames } from '../src/shared/engine/freeze'
import type { Project } from '../src/shared/types'

/*
 * A dip needs no still A*, so a project whose cuts are all dips has no stills in its feeds. The
 * export still draws each dip's colour, as the preview and the Export dialog do
 * (docs/design/editing-polish.md §5.8). Decoding, drawing and encoding are stand-ins; the join
 * each frame is drawn with is logged.
 */

const joinsDrawn: ({ at: { window: { kind: string }; p: number }; still: unknown } | null)[] = []

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
  drawFrame: (...args: unknown[]) => {
    const extras = args[8] as { join: (typeof joinsDrawn)[number] } | undefined
    joinsDrawn.push(extras?.join ?? null)
  }
}))
vi.mock('../src/renderer/src/render/joinLayer', () => ({
  composeJoinStill: () => undefined,
  scratchTarget: () => ({}),
  releaseScratch: () => undefined
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
vi.mock('../src/renderer/src/render/tiltLayer', () => ({ releaseTilt: () => undefined }))
vi.mock('../src/renderer/src/render/gradeLayer', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  releaseGrade: () => undefined
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
  const ctx = { name: 'export target', drawImage: () => undefined }
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
type Exporter = { exportVideo(input: unknown): Promise<unknown> }
const { exportVideo } = (await import(/* @vite-ignore */ EXPORTER)) as Exporter

/** A 3 s recording cut to [0, 1] and [2, 3], its one cut a dip to black, without a camera. */
function project(): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 3,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  return {
    ...p,
    clips: [
      { id: 'a', start: 0, end: 1, speed: 1 },
      { id: 'b', start: 2, end: 3, speed: 1 }
    ],
    joins: { all: { kind: 'dip' } }
  }
}

function source(p: Project) {
  const path = { at: () => ({ x: 0.5, y: 0.5 }) }
  const cursor = { samples: [], clicks: [], valid: false }
  return { project: p, scene: { project: p, cursor, cursorPath: path, focusPath: path }, screenUrl: 'media://p/screen.mp4', webcamUrl: null, background: null }
}

const SETTINGS = { format: 'mp4', resolution: 720, fps: 30, quality: 'high', encoder: 'software' }

beforeEach(() => {
  joinsDrawn.length = 0
})

describe('an export whose cuts are all dips', () => {
  it('has no stills in its feeds', () => {
    const p = project()
    const windows = joinPlan(p)
    expect(windows.map((w) => w.kind)).toEqual(['dip'])
    const { pictures } = videoFrames(p.clips, planOf(p), 30)
    const feed = joinFeed({ pictures, cameraTimes: null, windows, fps: 30, screen: trackTimes(null, 60, 3), camera: null })
    expect(feed.stills).toEqual([])
  })

  it('draws the dip in the frames of its window, with no still', async () => {
    const p = project()
    const [dip] = joinPlan(p)
    await exportVideo({ ...source(p), settings: SETTINGS, outputPath: '/tmp/out.mp4', onProgress: () => undefined, signal: new AbortController().signal })
    expect(joinsDrawn.length).toBe(60)
    const inside = joinsDrawn.filter((_, i) => i / 30 >= dip.from && i / 30 < dip.to)
    expect(inside.length).toBeGreaterThan(0)
    expect(inside.every((j) => j?.at.window.kind === 'dip' && j.still === null)).toBe(true)
    // Outside the window, every frame draws no join.
    expect(joinsDrawn.filter((_, i) => i / 30 < dip.from || i / 30 >= dip.to).every((j) => j === null)).toBe(true)
  })
})
