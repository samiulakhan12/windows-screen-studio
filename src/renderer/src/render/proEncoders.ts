/**
 * The renderer's side of the wave 12 codecs (docs/design/output-and-languages.md §5.3-5.4, §5.9):
 * WebCodecs configurations for HEVC and AV1, what this PC can make, and the sinks for raw frames and
 * for HEVC and AV1 chunks.
 *
 * Part P1 writes it. The contracts' stubs keep today's behaviour: no capabilities, no WebCodecs
 * configuration, and the raw sink of before (I420 except for GIFs).
 */
import type { ColorTags } from '../../../shared/api/export'
import type { ExportSettings } from '../../../shared/types'
import type { CodecCaps } from '../../../shared/render/codecRoutes'
import type { ExportRoute } from '../../../shared/render/exportPlan'
import { RawFrameSink, type FrameSink, type JobBase, type StartJob } from './encoders'
import { t } from '../../../shared/i18n/t'

/** WebCodecs configurations for HEVC on the GPU, Annex B, best first (§5.4). Part P1. */
export function hevcConfigs(width: number, height: number, fps: number, bitrate: number): VideoEncoderConfig[] {
  void width
  void height
  void fps
  void bitrate
  return []
}

/** WebCodecs configurations for AV1, best first (§5.4). Part P1. */
export function av1Configs(width: number, height: number, fps: number, bitrate: number): VideoEncoderConfig[] {
  void width
  void height
  void fps
  void bitrate
  return []
}

/** Whether WebCodecs can make HEVC and AV1 at this size and rate on the GPU (§5.9). Part P1. */
export async function webCodecsSupport(width: number, height: number, fps: number): Promise<{ hevc: boolean; av1: boolean }> {
  void width
  void height
  void fps
  return { hevc: false, av1: false }
}

/**
 * What this PC can make for `settings`: undefined for the default codecs (nothing to probe, the
 * routes of before), else the probed GPU encoders and WebCodecs support. Part P1.
 */
export async function codecCapsFor(settings: ExportSettings): Promise<CodecCaps | undefined> {
  void settings
  return undefined
}

/**
 * The sink of a raw-frame route: RGB for the editing formats, P2's alphaRawSink for transparent
 * jobs, I420 as before otherwise (GIFs RGB). Part P1; the stub is the sink of before.
 */
export function rawSinkFor(route: Extract<ExportRoute, { video: 'ffmpeg' }>, base: JobBase, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, startJob: StartJob): FrameSink {
  return new RawFrameSink(canvas, ctx, (pixelFormat) => startJob({ ...base, video: { kind: 'raw', encoder: route.encoder, pixelFormat } }), base.format !== 'gif')
}

/** The sink of a WebCodecs HEVC or AV1 route (Annex B, or IVF with fourcc 'AV01'). Part P1. */
export function proSink(route: Extract<ExportRoute, { video: 'webcodecs' }>, canvas: HTMLCanvasElement, fps: number, bitrate: number, startJob: (color: ColorTags) => Promise<void>): FrameSink {
  void canvas
  void fps
  void bitrate
  void startJob
  void route
  throw new Error(t('errors.feature.notReady'))
}
