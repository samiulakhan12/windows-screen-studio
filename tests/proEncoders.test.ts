import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ColorTags, ExportJob } from '../src/shared/api/export'
import type { CodecCaps } from '../src/shared/render/codecRoutes'
import type { ExportRoute } from '../src/shared/render/exportPlan'
import type { ExportSettings } from '../src/shared/types'

/*
 * The renderer's side of the wave 12 codecs (docs/design/output-and-languages.md §5.3-5.4, §5.9):
 * WebCodecs configurations (test 18), what this PC can make, the raw sinks of the editing formats and
 * transparent jobs (test 21), and the WebCodecs HEVC and AV1 sinks.
 */

// P2's sink of transparent jobs: a stand-in that keeps the job starter it was given.
const alpha = vi.hoisted(() => ({ startJob: null as ((job: ExportJob) => Promise<void>) | null }))
vi.mock('../src/renderer/src/render/alphaReadback', () => ({
  alphaRawSink: (_canvas: unknown, _ctx: unknown, startJob: (job: ExportJob) => Promise<void>) => {
    alpha.startJob = startJob
    return { push: async () => undefined, finish: async () => ({ bytes: 0 }), close: () => undefined }
  }
}))

type Api = {
  probeCodec: (codec: 'hevc' | 'av1') => Promise<string[]>
  exportCapabilities: () => Promise<{ hardwareEncoders: string[]; gpuCanvas: boolean; overrides: Record<string, string> }>
  exportFrame: (data: Uint8Array) => Promise<void>
  exportFinish: () => Promise<{ bytes: number }>
}
const sent: Uint8Array[] = []
const api: Api = {
  probeCodec: vi.fn(async (codec: 'hevc' | 'av1') => (codec === 'hevc' ? ['hevc_qsv', 'hevc_mf'] : ['av1_nvenc'])),
  exportCapabilities: vi.fn(async () => ({ hardwareEncoders: ['libx264'], gpuCanvas: true, overrides: {} })),
  exportFrame: async (data: Uint8Array) => void sent.push(data),
  exportFinish: async () => ({ bytes: 42 })
}
vi.stubGlobal('window', { api })

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const RENDER = '../src/renderer/src/render/'
type Sink = { push(i: number): Promise<void>; finish(): Promise<{ bytes: number }>; close(): void }
const pro = (await import(/* @vite-ignore */ `${RENDER}proEncoders`)) as {
  hevcConfigs(w: number, h: number, fps: number, bitrate: number, mode?: 'constant' | 'variable'): Record<string, unknown>[]
  av1Configs(w: number, h: number, fps: number, bitrate: number, mode?: 'constant' | 'variable'): Record<string, unknown>[]
  webCodecsSupport(w: number, h: number, fps: number): Promise<{ hevc: boolean; av1: boolean }>
  codecCapsFor(settings: ExportSettings): Promise<CodecCaps | undefined>
  jobCodecFields(settings: Pick<ExportSettings, 'format' | 'codec'>, alpha: unknown): Pick<ExportJob, 'codec' | 'alpha'>
  proBitrate(codec: 'hevc' | 'av1', w: number, h: number, fps: number, quality: ExportJob['quality']): number
  rawSinkFor(route: Extract<ExportRoute, { video: 'ffmpeg' }>, base: Omit<ExportJob, 'video'>, canvas: unknown, ctx: unknown, startJob: (job: ExportJob) => Promise<void>): Sink
  proSink(route: Extract<ExportRoute, { video: 'webcodecs' }>, canvas: unknown, fps: number, bitrate: number, startJob: (color: ColorTags) => Promise<void>, quality?: ExportJob['quality']): Sink
}

/** A fake WebCodecs: which configurations it supports, and an encoder that emits one chunk per frame. */
const wc = vi.hoisted(() => ({ supports: ((_c: { codec: string; hardwareAcceleration?: string }) => true) as (c: { codec: string; hardwareAcceleration?: string }) => boolean, asked: [] as Record<string, unknown>[], configured: [] as Record<string, unknown>[] }))
class FakeEncoder {
  state = 'configured'
  encodeQueueSize = 0
  constructor(private readonly init: { output: (chunk: unknown, meta?: unknown) => void; error: (e: Error) => void }) {}
  static async isConfigSupported(config: Record<string, unknown>): Promise<{ supported: boolean; config: Record<string, unknown> }> {
    wc.asked.push(config)
    // The browser's echo leaves out what it does not know (here: the HEVC bitstream format).
    const { hevc: _hevc, ...echo } = config
    return { supported: wc.supports(config as { codec: string }), config: echo }
  }
  configure(config: Record<string, unknown>): void {
    wc.configured.push(config)
  }
  addEventListener(): void {}
  encode(frame: { timestamp: number }): void {
    this.init.output({ byteLength: 3, timestamp: frame.timestamp, copyTo: (b: Uint8Array) => b.set([7, 8, 9]) }, { decoderConfig: { colorSpace: { matrix: 'smpte170m', fullRange: false } } })
  }
  async flush(): Promise<void> {}
  close(): void {
    this.state = 'closed'
  }
}
class FakeFrame {
  constructor(
    _source: unknown,
    readonly init: { timestamp: number }
  ) {}
  get timestamp(): number {
    return this.init.timestamp
  }
  close(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('window', { api })
  wc.asked.length = 0
  wc.configured.length = 0
  wc.supports = () => true
  sent.length = 0
  alpha.startJob = null
})

const settings = (x: Partial<ExportSettings> = {}): ExportSettings => ({ format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto', ...x })

describe('WebCodecs configurations (test 18)', () => {
  it('HEVC asks for the graphics card and an Annex B stream, at the level of the size and rate', () => {
    const [c] = pro.hevcConfigs(1920, 1080, 60, 5_000_000)
    expect(c).toEqual({
      codec: 'hvc1.1.6.L123.B0',
      width: 1920,
      height: 1080,
      framerate: 60,
      bitrate: 5_000_000,
      bitrateMode: 'variable',
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware',
      hevc: { format: 'annexb' }
    })
    expect(pro.hevcConfigs(1920, 1080, 60, 5_000_000, 'constant')[0].bitrateMode).toBe('constant')
  })

  it('AV1 asks for the graphics card at its level; its bit rates are 0.55 of H.264’s, HEVC’s 0.7, scaled with rateFps', () => {
    expect(pro.av1Configs(1920, 1080, 60, 3_000_000)).toEqual([
      { codec: 'av01.0.09M.08', width: 1920, height: 1080, framerate: 60, bitrate: 3_000_000, bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration: 'prefer-hardware' }
    ])
    expect(pro.proBitrate('hevc', 1920, 1080, 60, 'high')).toBe(Math.round(1920 * 1080 * 60 * 0.12 * 0.7))
    expect(pro.proBitrate('av1', 1920, 1080, 60, 'small')).toBe(Math.round(1920 * 1080 * 60 * 0.04 * 0.55))
    expect(pro.proBitrate('av1', 1920, 1080, 120, 'small')).toBe(Math.round(1920 * 1080 * 90 * 0.04 * 0.55))
  })

  it('webCodecsSupport asks the browser about each codec on the graphics card, and says no without WebCodecs', async () => {
    expect(await pro.webCodecsSupport(1920, 1080, 60)).toEqual({ hevc: false, av1: false })
    vi.stubGlobal('VideoEncoder', FakeEncoder)
    wc.supports = (c) => c.codec.startsWith('hvc1')
    expect(await pro.webCodecsSupport(1920, 1080, 60)).toEqual({ hevc: true, av1: false })
    expect(wc.asked.map((c) => [c.codec, c.hardwareAcceleration])).toEqual([
      ['hvc1.1.6.L123.B0', 'prefer-hardware'],
      ['av01.0.09M.08', 'prefer-hardware']
    ])
  })
})

describe('WebCodecs H.264 and VP9 at 120 fps (test 19)', () => {
  it('their quality rates scale with rateFps; every rate of before keeps its bit rate', async () => {
    const enc = (await import(/* @vite-ignore */ `${RENDER}encoders`)) as {
      avcConfigs(w: number, h: number, fps: number, q: ExportJob['quality'], hardware: boolean, bitrate?: number): { bitrate: number }[]
      vp9Configs(w: number, h: number, fps: number, q: ExportJob['quality'], hardware: boolean, bitrate?: number): { bitrate: number }[]
    }
    expect(enc.avcConfigs(1920, 1080, 60, 'high', true)[0].bitrate).toBe(Math.round(1920 * 1080 * 60 * 0.12))
    expect(enc.avcConfigs(1920, 1080, 30, 'small', true)[0].bitrate).toBe(Math.round(1920 * 1080 * 30 * 0.04))
    expect(enc.avcConfigs(1920, 1080, 120, 'high', true)[0].bitrate).toBe(Math.round(1920 * 1080 * 90 * 0.12))
    expect(enc.vp9Configs(1920, 1080, 120, 'medium', true)[0].bitrate).toBe(Math.round(1920 * 1080 * 90 * 0.07 * 0.7))
    // A size target is held as given.
    expect(enc.avcConfigs(1920, 1080, 120, 'high', true, 4_000_000)[0].bitrate).toBe(4_000_000)
  })
})

describe('codecCapsFor', () => {
  it('asks nothing for the codecs of before, the editing formats, transparent exports and Software', async () => {
    for (const s of [settings(), settings({ format: 'webm' }), settings({ format: 'mov', codec: 'cineform' }), settings({ format: 'webm', alpha: 'background' }), settings({ codec: 'av1', encoder: 'software' }), settings({ format: 'gif' })])
      expect(await pro.codecCapsFor(s)).toBeUndefined()
    expect(api.probeCodec).not.toHaveBeenCalled()
  })

  it('HEVC and AV1: the probed GPU encoders of the codec, WebCodecs on the GPU, and the test overrides', async () => {
    vi.stubGlobal('VideoEncoder', FakeEncoder)
    wc.supports = (c) => c.codec.startsWith('av01')
    expect(await pro.codecCapsFor(settings({ codec: 'hevc' }))).toEqual({ webcodecs: { hevc: false, av1: false }, gpu: { hevc: ['hevc_qsv', 'hevc_mf'], av1: [] }, overrides: {} })
    expect(await pro.codecCapsFor(settings({ format: 'webm', codec: 'av1' }))).toEqual({ webcodecs: { hevc: false, av1: true }, gpu: { hevc: [], av1: ['av1_nvenc'] }, overrides: {} })
    expect(api.probeCodec).toHaveBeenCalledWith('hevc')
    expect(api.probeCodec).toHaveBeenCalledWith('av1')
  })
})

describe('the job of an export', () => {
  it('names the codec only when it is not the format’s default, and alpha only for a transparent export', () => {
    expect(pro.jobCodecFields({ format: 'mp4' }, undefined)).toEqual({})
    expect(pro.jobCodecFields({ format: 'mp4', codec: 'h264' }, undefined)).toEqual({})
    expect(pro.jobCodecFields({ format: 'webm', codec: 'vp9' }, undefined)).toEqual({})
    expect(pro.jobCodecFields({ format: 'mp4', codec: 'hevc' }, undefined)).toEqual({ codec: 'hevc' })
    expect(pro.jobCodecFields({ format: 'mov', codec: 'cineform' }, 'overlays')).toEqual({ codec: 'cineform', alpha: true })
    expect(pro.jobCodecFields({ format: 'webm' }, 'background')).toEqual({ alpha: true })
    // A codec its format does not carry is never sent (validateJob would refuse the job).
    expect(pro.jobCodecFields({ format: 'gif', codec: 'hevc' }, undefined)).toEqual({})
  })
})

/** A 4×2 canvas whose pixels are read through getImageData (no VideoFrame here). */
function canvas2d(): { canvas: { width: number; height: number }; ctx: { getImageData: () => { data: Uint8ClampedArray } } } {
  return { canvas: { width: 4, height: 2 }, ctx: { getImageData: () => ({ data: new Uint8ClampedArray(4 * 2 * 4).fill(200) }) } }
}
const base = (x: Partial<ExportJob> = {}): Omit<ExportJob, 'video'> => ({ width: 4, height: 2, fps: 30, frames: 1, format: 'mp4', quality: 'high', outputPath: '/v/o.mp4', ...x })

describe('raw sinks (test 21)', () => {
  it('the editing formats get RGB frames; H.264, HEVC and AV1 I420 as before; GIFs RGB', async () => {
    const pixels = async (route: Extract<ExportRoute, { video: 'ffmpeg' }>, b: Omit<ExportJob, 'video'>): Promise<unknown> => {
      const started: ExportJob[] = []
      const { canvas, ctx } = canvas2d()
      const sink = pro.rawSinkFor(route, b, canvas, ctx, async (job) => void started.push(job))
      await sink.push(0)
      expect(started[0].video).toMatchObject({ kind: 'raw', encoder: route.encoder })
      return started[0].video.kind === 'raw' ? started[0].video.pixelFormat : null
    }
    expect(await pixels({ video: 'ffmpeg', encoder: 'cfhd' }, base({ format: 'mov', codec: 'cineform' }))).toBe('rgba')
    expect(await pixels({ video: 'ffmpeg', encoder: 'qtrle' }, base({ format: 'mov', codec: 'animation' }))).toBe('rgba')
    expect(await pixels({ video: 'ffmpeg', encoder: 'libx264' }, base())).toBe('yuv420p')
    expect(await pixels({ video: 'ffmpeg', encoder: 'hevc_nvenc' }, base({ codec: 'hevc' }))).toBe('yuv420p')
    expect(await pixels({ video: 'ffmpeg', encoder: 'libaom-av1' }, base({ codec: 'av1' }))).toBe('yuv420p')
    expect(await pixels({ video: 'ffmpeg', encoder: 'libx264' }, base({ format: 'gif' }))).toBe('rgba')
  })

  it('a transparent job goes to the alpha sink, which starts this route’s job with alpha and the byte order it read', async () => {
    const started: ExportJob[] = []
    const { canvas, ctx } = canvas2d()
    pro.rawSinkFor({ video: 'ffmpeg', encoder: 'cfhd' }, base({ format: 'mov', codec: 'cineform', alpha: true }), canvas, ctx, async (job) => void started.push(job))
    expect(alpha.startJob).not.toBeNull()
    await alpha.startJob!({ video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' } } as ExportJob)
    expect(started).toEqual([{ ...base({ format: 'mov', codec: 'cineform', alpha: true }), video: { kind: 'raw', encoder: 'cfhd', pixelFormat: 'rgba' } }])
    await alpha.startJob!({} as ExportJob)
    expect(started[1].video).toEqual({ kind: 'raw', encoder: 'cfhd', pixelFormat: 'bgra' })
  })
})

describe('the WebCodecs HEVC and AV1 sinks', () => {
  const frameCanvas = { width: 1920, height: 1080 }

  it('HEVC: the quality’s variable rate on the graphics card, Annex B kept, chunks sent as they come', async () => {
    vi.stubGlobal('VideoEncoder', FakeEncoder)
    vi.stubGlobal('VideoFrame', FakeFrame)
    const colors: ColorTags[] = []
    const sink = pro.proSink({ video: 'webcodecs', codec: 'hevc', hardware: true }, frameCanvas, 60, 0, async (c) => void colors.push(c), 'medium')
    await sink.push(0)
    await sink.push(1)
    expect(await sink.finish()).toEqual({ bytes: 42 })
    expect(wc.configured).toEqual([
      expect.objectContaining({ codec: 'hvc1.1.6.L123.B0', bitrate: Math.round(1920 * 1080 * 60 * 0.07 * 0.7), bitrateMode: 'variable', hardwareAcceleration: 'prefer-hardware', hevc: { format: 'annexb' } })
    ])
    expect(colors).toEqual([{ primaries: 1, transfer: 1, matrix: 6, fullRange: false }])
    expect(Array.from(sent[0])).toEqual([7, 8, 9, 7, 8, 9])
  })

  it('AV1: a size target is held as a constant rate; IVF with fourcc AV01; the software route asks for WebCodecs’ software encoder', async () => {
    vi.stubGlobal('VideoEncoder', FakeEncoder)
    vi.stubGlobal('VideoFrame', FakeFrame)
    const sink = pro.proSink({ video: 'webcodecs', codec: 'av1', hardware: false }, frameCanvas, 30, 2_500_000, async () => undefined)
    await sink.push(0)
    await sink.finish()
    expect(wc.configured).toEqual([expect.objectContaining({ codec: 'av01.0.08M.08', bitrate: 2_500_000, bitrateMode: 'constant', hardwareAcceleration: 'prefer-software' })])
    expect(String.fromCharCode(...sent[0].slice(0, 4))).toBe('DKIF')
    expect(String.fromCharCode(...sent[0].slice(8, 12))).toBe('AV01')
  })

  it('a configuration this PC cannot encode fails the first frame, so the export moves on to the next route', async () => {
    vi.stubGlobal('VideoEncoder', FakeEncoder)
    vi.stubGlobal('VideoFrame', FakeFrame)
    wc.supports = () => false
    const sink = pro.proSink({ video: 'webcodecs', codec: 'hevc', hardware: true }, frameCanvas, 60, 0, async () => undefined)
    await expect(sink.push(0)).rejects.toThrow('The graphics card cannot make HEVC at 1920×1080 on this PC.')
    expect(wc.configured).toEqual([])
    sink.close()
  })
})
