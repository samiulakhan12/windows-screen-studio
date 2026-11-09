import { describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { ColorTags, ExportJob } from '../src/shared/api/export'
import type { CodecCaps } from '../src/shared/render/codecRoutes'
import type { ExportRoute } from '../src/shared/render/exportPlan'
import type { ExportSettings, Project } from '../src/shared/types'

/*
 * The exporter's side of the wave 12 codecs (docs/design/output-and-languages.md §4.2, §5.3): the job
 * names the codec when it is not the format's default and carries alpha for a transparent export, so
 * main plans it with the codec's own arguments; the WebCodecs HEVC and AV1 sinks get the export's
 * quality; and the exports of before send the jobs they sent. Decoding and drawing are stand-ins.
 */

const h = vi.hoisted(() => ({
  bases: [] as { route: unknown; base: Record<string, unknown> }[],
  pro: [] as { route: unknown; fps: number; bitrate: number; quality: unknown }[],
  started: [] as ExportJob[],
  caps: undefined as CodecCaps | undefined
}))

class FakeSource {
  readonly kind = 'decoder'
  async get(i: number) {
    await Promise.resolve()
    return { image: { i }, width: 1920, height: 1080 }
  }
  next(): void {}
  close(): void {}
}
const sink = { push: async () => undefined, finish: async () => ({ bytes: 1 }), close: () => undefined }

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
vi.mock('../src/renderer/src/render/compositor', () => ({ drawFrame: () => undefined }))
vi.mock('../src/renderer/src/render/joinLayer', () => ({ composeJoinStill: () => undefined, scratchTarget: () => ({}), releaseScratch: () => undefined }))
vi.mock('../src/renderer/src/render/tiltLayer', () => ({ releaseTilt: () => undefined }))
vi.mock('../src/renderer/src/render/gradeLayer', async (orig) => ({ ...(await orig<Record<string, unknown>>()), releaseGrade: () => undefined }))
vi.mock('../src/renderer/src/render/cursorLayer', () => ({ prepareCursorAssets: async () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ prepareStyleAssets: async () => undefined }))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({ loadAudioAnalysis: async () => ({}) }))
vi.mock('../src/renderer/src/editor/media', () => ({ SCREEN_PROXY_FPS: 60, WEBCAM_PROXY_FPS: 30, createVideo: () => ({}), mediaDuration: async () => null, whenReady: async () => undefined }))
// P2's alphaOf: a transparent Background draws see-through (its stub draws every export opaque).
vi.mock('../src/shared/render/alpha', () => ({ alphaOf: (o: ExportSettings) => o.alpha }))
// The sinks: what the exporter hands them is recorded; jobCodecFields is the real one.
vi.mock('../src/renderer/src/render/proEncoders', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return {
    ...real,
    codecCapsFor: async () => h.caps,
    rawSinkFor: (route: unknown, base: Record<string, unknown>) => {
      h.bases.push({ route, base })
      return sink
    },
    proSink: (route: unknown, _canvas: unknown, fps: number, bitrate: number, startJob: (color: ColorTags) => Promise<void>, quality: unknown) => {
      h.pro.push({ route, fps, bitrate, quality })
      void startJob({ primaries: 1, transfer: 1, matrix: 6, fullRange: false })
      return sink
    }
  }
})

const canvas = () => {
  const ctx = { name: 'export target', drawImage: () => undefined }
  return { width: 0, height: 0, getContext: () => ctx, toBlob: (cb: (b: unknown) => void) => cb({ arrayBuffer: async () => new ArrayBuffer(4) }) }
}
vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('window', {
  api: {
    exportCapabilities: async () => ({ hardwareEncoders: ['libx264'], gpuCanvas: false, overrides: { videoEncoder: 'ffmpeg' } }),
    exportStart: async (_id: string, job: ExportJob) => void h.started.push(job),
    exportCancel: async () => undefined,
    exportFinish: async () => ({ bytes: 1 })
  }
})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const EXPORTER = '../src/renderer/src/editor/exporter'
const { exportVideo } = (await import(/* @vite-ignore */ EXPORTER)) as { exportVideo(input: unknown): Promise<unknown> }

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
  return { ...p, clips: [{ id: 'a', start: 0, end: 1, speed: 1 }] }
}

async function run(settings: Partial<ExportSettings>, caps?: CodecCaps): Promise<void> {
  h.bases.length = 0
  h.pro.length = 0
  h.started.length = 0
  h.caps = caps
  const p = project()
  const path = { at: () => ({ x: 0.5, y: 0.5 }) }
  await exportVideo({
    project: p,
    scene: { project: p, cursor: { samples: [], clicks: [], valid: false }, cursorPath: path, focusPath: path },
    screenUrl: 'media://p/screen.mp4',
    webcamUrl: null,
    background: null,
    settings: { format: 'mp4', resolution: 720, fps: 30, quality: 'high', encoder: 'auto', ...settings },
    outputPath: '/tmp/out',
    onProgress: () => undefined,
    signal: new AbortController().signal
  })
}

const ffmpeg = (encoder: string): ExportRoute => ({ video: 'ffmpeg', encoder }) as ExportRoute

describe('the jobs the exporter sends for the wave 12 codecs', () => {
  it('the exports of before send no codec and no alpha', async () => {
    for (const s of [{}, { format: 'mov' as const }, { format: 'webm' as const }, { codec: 'h264' as const }, { format: 'gif' as const }]) {
      await run(s)
      expect(h.bases).toHaveLength(1)
      expect(h.bases[0].base).not.toHaveProperty('codec')
      expect(h.bases[0].base).not.toHaveProperty('alpha')
    }
  })

  it('an editing format names its codec; a transparent export carries alpha', async () => {
    await run({ format: 'mov', codec: 'cineform' })
    expect(h.bases).toEqual([{ route: ffmpeg('cfhd'), base: expect.objectContaining({ format: 'mov', codec: 'cineform' }) }])
    expect(h.bases[0].base).not.toHaveProperty('alpha')
    await run({ format: 'mov', codec: 'animation', alpha: 'overlays' })
    expect(h.bases[0]).toEqual({ route: ffmpeg('qtrle'), base: expect.objectContaining({ codec: 'animation', alpha: true }) })
    await run({ format: 'webm', alpha: 'background' })
    expect(h.bases[0]).toEqual({ route: ffmpeg('libvpx-vp9'), base: expect.objectContaining({ format: 'webm', alpha: true }) })
    expect(h.bases[0].base).not.toHaveProperty('codec')
  })

  it('AV1 on the processor names its codec on the raw route', async () => {
    await run({ codec: 'av1', encoder: 'software' })
    expect(h.bases).toEqual([{ route: ffmpeg('libaom-av1'), base: expect.objectContaining({ codec: 'av1' }) }])
  })

  it('the WebCodecs HEVC sink gets the quality, no size target, and starts a job that names HEVC', async () => {
    const caps: CodecCaps = { webcodecs: { hevc: true, av1: false }, gpu: { hevc: [], av1: [] }, overrides: {} }
    await run({ codec: 'hevc', quality: 'small' }, caps)
    expect(h.pro).toEqual([{ route: { video: 'webcodecs', codec: 'hevc', hardware: true }, fps: 30, bitrate: 0, quality: 'small' }])
    await vi.waitFor(() => expect(h.started).toHaveLength(1))
    expect(h.started[0]).toMatchObject({ format: 'mp4', codec: 'hevc', video: { kind: 'hevc', color: { primaries: 1, transfer: 1, matrix: 6, fullRange: false } } })
  })
})
