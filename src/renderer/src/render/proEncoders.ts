/**
 * The renderer's side of the wave 12 codecs (docs/design/output-and-languages.md §5.3-5.4, §5.9):
 * WebCodecs configurations for HEVC and AV1, what this PC can make, and the sinks for raw frames and
 * for HEVC and AV1 chunks.
 *
 * The codecs of before keep their sinks exactly: raw frames as I420 (GIFs as RGB), WebCodecs H.264
 * and VP9 through `WebCodecsSink` as configured by `avcConfigs` and `vp9Configs`.
 */
import type { ColorTags, ExportJob, RawPixelFormat } from '../../../shared/api/export'
import type { ExportSettings } from '../../../shared/types'
import type { CodecCaps } from '../../../shared/render/codecRoutes'
import type { ExportRoute } from '../../../shared/render/exportPlan'
import { av1CodecString, hevcCodecString } from '../../../shared/render/codecLevels'
import { codecOf, DEFAULT_CODEC, FORMAT_CODECS, isIntermediate, rateFps } from '../../../shared/render/proFormats'
import { RawFrameSink, WebCodecsSink, type FrameSink, type JobBase, type StartJob } from './encoders'
import { alphaRawSink } from './alphaReadback'
import { t } from '../../../shared/i18n/t'

type Quality = ExportJob['quality']

/** H.264's bits per pixel per frame at each quality (the WebCodecs H.264 route's, encoders.ts). */
const BPP: Readonly<Record<Quality, number>> = { high: 0.12, medium: 0.07, small: 0.04 }
/** HEVC needs about 0.7 of H.264's bits for the same quality, AV1 about 0.55 (§5.4). */
const HEVC_RATE = 0.7
const AV1_RATE = 0.55

/** A quality's bit rate for WebCodecs HEVC or AV1: H.264's, scaled by the codec and by `rateFps` (§5.4, §5.6). */
export function proBitrate(codec: 'hevc' | 'av1', width: number, height: number, fps: number, quality: Quality): number {
  return Math.round(width * height * rateFps(fps) * BPP[quality] * (codec === 'hevc' ? HEVC_RATE : AV1_RATE))
}

/**
 * WebCodecs configurations for HEVC on the GPU, best first (§5.4): Main profile at the level the size
 * and rate need, on the graphics card only (§0 decision 1), as an Annex B stream ffmpeg muxes as it
 * arrives. `mode` is 'constant' for a size target (the average the encoder must hold), else 'variable'.
 */
export function hevcConfigs(width: number, height: number, fps: number, bitrate: number, mode: 'constant' | 'variable' = 'variable'): VideoEncoderConfig[] {
  const config = {
    codec: hevcCodecString(width, height, fps),
    width,
    height,
    framerate: fps,
    bitrate,
    bitrateMode: mode,
    latencyMode: 'quality',
    hardwareAcceleration: 'prefer-hardware',
    hevc: { format: 'annexb' }
  }
  return [config as VideoEncoderConfig]
}

/** WebCodecs configurations for AV1 (Main, 8-bit), best first (§5.4): on the graphics card; the software route asks for 'prefer-software' itself. */
export function av1Configs(width: number, height: number, fps: number, bitrate: number, mode: 'constant' | 'variable' = 'variable'): VideoEncoderConfig[] {
  return [
    {
      codec: av1CodecString(width, height, fps),
      width,
      height,
      framerate: fps,
      bitrate,
      bitrateMode: mode,
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware'
    }
  ]
}

/** Whether `config` can be encoded here; the configuration to use (the one given, as the browser read it), or null. */
async function supported(config: VideoEncoderConfig): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null
  try {
    const r = await VideoEncoder.isConfigSupported(config)
    // Keep what the browser leaves out of its echo (the HEVC bitstream format) under what it read.
    return r.supported ? ({ ...config, ...(r.config ?? {}) } as VideoEncoderConfig) : null
  } catch {
    return null
  }
}

/** The first of `configs` this machine can encode, or null. */
async function firstSupported(configs: readonly VideoEncoderConfig[]): Promise<VideoEncoderConfig | null> {
  for (const c of configs) {
    const ok = await supported(c)
    if (ok) return ok
  }
  return null
}

/** Whether WebCodecs can make HEVC and AV1 at this size and rate on the GPU (§5.9). */
export async function webCodecsSupport(width: number, height: number, fps: number): Promise<{ hevc: boolean; av1: boolean }> {
  const [hevc, av1] = await Promise.all([
    firstSupported(hevcConfigs(width, height, fps, proBitrate('hevc', width, height, fps, 'high'))),
    firstSupported(av1Configs(width, height, fps, proBitrate('av1', width, height, fps, 'high')))
  ])
  return { hevc: !!hevc, av1: !!av1 }
}

/**
 * The frame the probes ask about for `settings`: the 16:9 frame of its resolution, the largest of the
 * project shapes at a resolution (9:16 has as many pixels; 1:1, 4:3 and 4:5 fewer). A wider 'auto'
 * frame is checked again by its sink, at its real size.
 */
function probeSize(settings: Pick<ExportSettings, 'resolution'>): { width: number; height: number } {
  return { width: Math.round((settings.resolution * 16) / 9 / 2) * 2, height: settings.resolution }
}

/**
 * What this PC can make for `settings`: undefined for the default codecs, for the editing formats and
 * for transparent exports (nothing to probe: the routes need no GPU), and for *Software*; else the GPU
 * encoders main's probe found for the codec (once per session) and whether WebCodecs makes it on the GPU.
 */
export async function codecCapsFor(settings: ExportSettings): Promise<CodecCaps | undefined> {
  const codec = codecOf(settings)
  if (settings.alpha || settings.encoder === 'software' || (codec !== 'hevc' && codec !== 'av1') || !FORMAT_CODECS[settings.format].includes(codec)) return undefined
  const size = probeSize(settings)
  const [found, webcodecs, caps] = await Promise.all([
    window.api.probeCodec(codec).catch(() => []),
    webCodecsSupport(size.width, size.height, settings.fps).catch(() => ({ hevc: false, av1: false })),
    window.api.exportCapabilities()
  ])
  return {
    webcodecs: { hevc: codec === 'hevc' && webcodecs.hevc, av1: codec === 'av1' && webcodecs.av1 },
    gpu: {
      hevc: codec === 'hevc' ? (found.filter((e) => e.startsWith('hevc_')) as CodecCaps['gpu']['hevc']) : [],
      av1: codec === 'av1' ? (found.filter((e) => e.startsWith('av1_')) as CodecCaps['gpu']['av1']) : []
    },
    overrides: caps.overrides
  }
}

/**
 * The job fields an export's settings add (output-and-languages §4.2): `codec` when it is not the
 * format's default, and `alpha` for a transparent export. Nothing for the exports of before, so their
 * jobs are as they were.
 */
export function jobCodecFields(settings: Pick<ExportSettings, 'format' | 'codec'>, alpha: unknown): Pick<ExportJob, 'codec' | 'alpha'> {
  const codec = settings.codec
  const own = codec !== undefined && codec !== DEFAULT_CODEC[settings.format] && FORMAT_CODECS[settings.format].includes(codec)
  return { ...(own ? { codec } : {}), ...(alpha ? { alpha: true as const } : {}) }
}

/**
 * The sink of a raw-frame route: P2's alphaRawSink (straight 'bgra' or 'rgba') for a transparent job,
 * RGB as read back for the editing formats (ffmpeg converts it to their BT.709 YUV or RGB), I420 as
 * before otherwise (GIFs RGB).
 */
export function rawSinkFor(route: Extract<ExportRoute, { video: 'ffmpeg' }>, base: JobBase, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, startJob: StartJob): FrameSink {
  const start = (pixelFormat: RawPixelFormat): Promise<void> => startJob({ ...base, video: { kind: 'raw', encoder: route.encoder, pixelFormat } })
  if (base.alpha) {
    // The alpha sink reads back and unpremultiplies; the job it starts is this route's, with the byte order it read.
    return alphaRawSink(canvas, ctx, (job) => startJob({ ...base, alpha: true, video: { kind: 'raw', encoder: route.encoder, pixelFormat: job?.video?.kind === 'raw' ? job.video.pixelFormat : 'bgra' } }))
  }
  if (base.format !== 'gif' && isIntermediate(codecOf(base))) return new RawFrameSink(canvas, ctx, start, false)
  return new RawFrameSink(canvas, ctx, start, base.format !== 'gif')
}

/**
 * A WebCodecs sink whose configuration is checked before the first frame: when this PC cannot
 * encode it at this size, the first frame fails, so the export moves on to the next route.
 */
class ProWebCodecsSink implements FrameSink {
  private sink: WebCodecsSink | null = null
  private opening: Promise<WebCodecsSink> | null = null
  private closed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly codec: 'hevc' | 'av1',
    private readonly configs: readonly VideoEncoderConfig[],
    private readonly fps: number,
    private readonly startJob: (color: ColorTags) => Promise<void>
  ) {}

  private open(): Promise<WebCodecsSink> {
    this.opening ??= firstSupported(this.configs).then((config) => {
      if (!config) throw new Error(t('codecs.webcodecs.unsupported', { codec: this.codec === 'hevc' ? 'HEVC' : 'AV1', width: this.canvas.width, height: this.canvas.height }))
      if (this.closed) throw new DOMException('The export was stopped', 'AbortError')
      this.sink = new WebCodecsSink(this.canvas, config, this.fps, this.startJob, this.codec === 'av1' ? 'ivf-av01' : 'annexb')
      return this.sink
    })
    return this.opening
  }

  async push(index: number): Promise<void> {
    await (await this.open()).push(index)
  }

  async finish(): ReturnType<FrameSink['finish']> {
    return (await this.open()).finish()
  }

  close(): void {
    this.closed = true
    this.sink?.close()
  }
}

/**
 * The sink of a WebCodecs HEVC or AV1 route (§5.4): Annex B for HEVC, IVF with fourcc 'AV01' for AV1.
 * `bitrate` is a size target's (held as a constant rate); 0 asks for the quality's rate, H.264's × 0.7
 * for HEVC and × 0.55 for AV1, as a variable rate. The software route (the test override) asks for
 * WebCodecs' software AV1.
 */
export function proSink(route: Extract<ExportRoute, { video: 'webcodecs' }>, canvas: HTMLCanvasElement, fps: number, bitrate: number, startJob: (color: ColorTags) => Promise<void>, quality: Quality = 'high'): FrameSink {
  const codec = route.codec
  if (codec !== 'hevc' && codec !== 'av1') throw new Error('Invalid export settings')
  const { width, height } = canvas
  const target = bitrate > 0
  const rate = target ? Math.round(bitrate) : proBitrate(codec, width, height, fps, quality)
  const configs = (codec === 'hevc' ? hevcConfigs : av1Configs)(width, height, fps, rate, target ? 'constant' : 'variable').map((c) =>
    route.hardware ? c : { ...c, hardwareAcceleration: 'prefer-software' as const }
  )
  return new ProWebCodecsSink(canvas, codec, configs, fps, startJob)
}
