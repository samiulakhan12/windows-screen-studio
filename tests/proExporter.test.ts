import { afterEach, describe, expect, it, vi } from 'vitest'
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
  caps: undefined as CodecCaps | undefined,
  /** export:start refuses every job with this message, and export:errorCode gives `code`. */
  refuse: null as { message: string; code: string | null } | null,
  /**
   * Main's last error code, as export:errorCode gives it: export:start clears it and records a
   * refusal's, a failed frame write records its own, and a cancel while a job runs leaves 'cancelled'
   * (a frame write still waiting on the killed ffmpeg rejects with it).
   */
  code: null as string | null,
  /** Main has a job running: export:start took it and no cancel came since. */
  active: false,
  /**
   * How the next sink made fails, taken once: before its job starts (a WebCodecs encoder that errors
   * before its first chunk) or after it, with the code main records for the failed frame write (none
   * for a failure of the page's own).
   */
  fail: null as { at: 'before-start' | 'after-start'; message: string; code: string | null } | null,
  /** The screen's frames fail to read with this error. */
  screenFails: null as Error | null,
  details: [] as (string | undefined)[]
}))

class FakeSource {
  readonly kind = 'decoder'
  async get(i: number) {
    await Promise.resolve()
    if (h.screenFails) throw h.screenFails
    return { image: { i }, width: 1920, height: 1080 }
  }
  next(): void {}
  close(): void {}
}
const sink = { push: async () => undefined, finish: async () => ({ bytes: 1 }), close: () => undefined }

/** The failure set for the next sink, taken once, as a push that fails before or after its job starts. */
function failingSink(start: () => Promise<void>): typeof sink | null {
  const f = h.fail
  h.fail = null
  if (!f) return null
  const push = async (): Promise<undefined> => {
    if (f.at === 'after-start') {
      await start()
      if (f.code) h.code = f.code
    }
    throw new Error(f.message)
  }
  return { ...sink, push }
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
    rawSinkFor: (route: { encoder: string }, base: Record<string, unknown>, _canvas: unknown, _ctx: unknown, startJob: (job: unknown) => Promise<void>) => {
      h.bases.push({ route, base })
      const start = (): Promise<void> => startJob({ ...base, video: { kind: 'raw', encoder: route.encoder, pixelFormat: 'yuv420p' } })
      // A refused start reaches the exporter as the raw sinks report it: on the first frame.
      return failingSink(start) ?? (h.refuse ? { ...sink, push: start } : sink)
    },
    proSink: (route: unknown, _canvas: unknown, fps: number, bitrate: number, startJob: (color: ColorTags) => Promise<void>, quality: unknown) => {
      h.pro.push({ route, fps, bitrate, quality })
      const start = (): Promise<void> => startJob({ primaries: 1, transfer: 1, matrix: 6, fullRange: false })
      const failing = failingSink(start)
      if (failing) return failing
      void start()
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
    exportStart: async (_id: string, job: ExportJob) => {
      h.started.push(job)
      h.code = null
      if (h.refuse) {
        h.code = h.refuse.code
        throw new Error(`Error invoking remote method 'export:start': Error: ${h.refuse.message}`)
      }
      h.active = true
    },
    exportErrorCode: async () => h.code,
    exportCancel: async () => {
      if (h.active) h.code = 'cancelled'
      h.active = false
    },
    exportFinish: async () => ({ bytes: 1 })
  }
})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const EXPORTER = '../src/renderer/src/editor/exporter'
const MEDIA = '../src/renderer/src/editor/media'
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
  h.details.length = 0
  h.caps = caps
  // The last export's job is over; the code it left stays, as main's does.
  h.active = false
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
    onProgress: (p: { detail?: string }) => void h.details.push(p.detail),
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

describe('a start main refuses for a reason no encoder changes (output-and-languages §5.10, §9.6)', () => {
  // AV1 on this PC: av1_nvenc first, then libaom-av1.
  const gpu: CodecCaps = { webcodecs: { hevc: false, av1: false }, gpu: { hevc: [], av1: ['av1_nvenc'] }, overrides: {} }
  const space = 'This export needs about 3.1 GB and the folder has 1.2 GB free. Choose another folder or a smaller format.'

  it('the free-space refusal (code disk-full) stops the export at the first route, with its own message', async () => {
    h.refuse = { message: space, code: 'disk-full' }
    try {
      await expect(run({ codec: 'av1' }, gpu)).rejects.toThrow(space)
      expect(h.bases.map((b) => b.route)).toEqual([ffmpeg('av1_nvenc')])
      expect(h.started).toHaveLength(1)
    } finally {
      h.refuse = null
    }
  })

  it('an encoder failure (code encoder, or none) still moves on to the next route', async () => {
    for (const code of ['encoder', null]) {
      h.refuse = { message: 'av1_nvenc: no capable devices found', code }
      try {
        await expect(run({ codec: 'av1' }, gpu)).rejects.toThrow('no capable devices found')
        expect(h.bases.map((b) => b.route)).toEqual([ffmpeg('av1_nvenc'), ffmpeg('libaom-av1')])
      } finally {
        h.refuse = null
      }
    }
  })
})

describe('the finalizing line of a size target', () => {
  it('names the two passes for libaom as it does for x264 and libvpx, and not for a graphics card', async () => {
    const twoPasses = 'Encoding to the size target (two passes)…'
    await run({ codec: 'av1', encoder: 'software', targetSizeMB: 5 })
    expect(h.bases[0].route).toEqual(ffmpeg('libaom-av1'))
    expect(h.details).toContain(twoPasses)
    await run({ targetSizeMB: 5 })
    expect(h.bases[0].route).toEqual(ffmpeg('libx264'))
    expect(h.details).toContain(twoPasses)
    const gpu: CodecCaps = { webcodecs: { hevc: false, av1: false }, gpu: { hevc: [], av1: ['av1_nvenc'] }, overrides: {} }
    await run({ codec: 'av1', targetSizeMB: 5 }, gpu)
    expect(h.bases[0].route).toEqual(ffmpeg('av1_nvenc'))
    expect(h.details).not.toContain(twoPasses)
  })
})

describe('a route is decided by its own failure, not by what an earlier export left (output-and-languages §9.6)', () => {
  // HEVC on this PC: WebCodecs on the graphics card first, then hevc_nvenc.
  const caps: CodecCaps = { webcodecs: { hevc: true, av1: false }, gpu: { hevc: ['hevc_nvenc'], av1: [] }, overrides: {} }
  const webcodecs = { video: 'webcodecs', codec: 'hevc', hardware: true }
  const failed = "The graphics card's encoder failed: Encoder creation error."
  afterEach(() => {
    h.fail = null
    h.code = null
  })

  it('a WebCodecs encoder that fails before its first chunk tries the next route, whatever code an earlier export left', async () => {
    for (const left of [null, 'cancelled', 'disk-full']) {
      h.code = left
      h.fail = { at: 'before-start', message: failed, code: null }
      await run({ codec: 'hevc' }, caps)
      expect({ left, tried: [...h.pro.map((p) => p.route), ...h.bases.map((b) => b.route)] }).toEqual({ left, tried: [webcodecs, ffmpeg('hevc_nvenc')] })
    }
  })

  it('a route that started tries the next one after the page’s own or an encoder’s failure, though its cancel leaves “cancelled”', async () => {
    for (const code of [null, 'encoder']) {
      h.fail = { at: 'after-start', message: failed, code }
      await run({ codec: 'hevc' }, caps)
      expect({ code, tried: [...h.pro.map((p) => p.route), ...h.bases.map((b) => b.route)] }).toEqual({ code, tried: [webcodecs, ffmpeg('hevc_nvenc')] })
    }
  })

  it('a frame main could not write for a reason no encoder changes stops the export at that route', async () => {
    h.fail = { at: 'after-start', message: 'The disk is full.', code: 'disk-full' }
    await expect(run({ codec: 'hevc' }, caps)).rejects.toThrow('The disk is full.')
    expect(h.pro.map((p) => p.route)).toEqual([webcodecs])
    expect(h.bases).toHaveLength(0)
  })
})

describe('the page’s own failure to read a recording stops the export, as its words did (output-and-languages §9.6)', () => {
  const caps: CodecCaps = { webcodecs: { hevc: true, av1: false }, gpu: { hevc: ['hevc_nvenc'], av1: [] }, overrides: {} }
  afterEach(() => {
    h.screenFails = null
  })

  /** The errors media.ts's own seek and load give for a video element that fails. */
  async function mediaFailures(): Promise<Error[]> {
    const media = await vi.importActual<{ whenReady(v: unknown): Promise<void>; seekTo(v: unknown, at: number): Promise<void> }>(MEDIA)
    const video = () => Object.assign(new EventTarget(), { readyState: 0, seeking: false, currentTime: 0, duration: 10, error: { message: 'PIPELINE_ERROR_READ: FFmpegDemuxer: data source error' } })
    const failing = async (start: (v: ReturnType<typeof video>) => Promise<void>): Promise<Error> => {
      const v = video()
      const p = start(v)
      v.dispatchEvent(new Event('error'))
      return p.then(
        () => {
          throw new Error('expected a failure')
        },
        (e: Error) => e
      )
    }
    return [await failing((v) => media.seekTo(v, 2)), await failing((v) => media.whenReady(v))]
  }

  it('a recording the video element cannot read or load fails at the first route with its own message', async () => {
    const errors = await mediaFailures()
    expect(errors.map((e) => e.message)).toEqual(['Could not read video (PIPELINE_ERROR_READ: FFmpegDemuxer: data source error)', 'Could not load video (PIPELINE_ERROR_READ: FFmpegDemuxer: data source error)'])
    for (const e of errors) {
      h.screenFails = e
      await expect(run({ codec: 'hevc' }, caps)).rejects.toThrow(e.message)
      expect(h.pro).toHaveLength(1)
      expect(h.bases).toHaveLength(0)
    }
  })
})
