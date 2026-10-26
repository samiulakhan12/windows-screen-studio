import type { ExportCapabilities, FfmpegVideoEncoder } from '../api/export'
import { visibleSize } from '../engine/crop'
import { outputSize } from '../engine/layout'
import type { AspectRatio, ExportFormat, Project } from '../types'
import type { ExportOptions } from './exportPresets'

/** GIFs play at 15 fps; their size options stop at 1080p. */
export const GIF_FPS = 15
export const GIF_MAX_HEIGHT = 1080

/**
 * Longest side of an exported video. H.264 GPU encoders (NVENC, Quick Sync, AMF,
 * Media Foundation, and WebCodecs on top of them) handle up to 4096 pixels; above
 * that an export would silently fall back to the slow software encoder, and above
 * 8192 the main process refuses the job. Standard shapes stay below this at every resolution
 * (16:9 4K is 3840x2160); only very wide or tall recordings with the 'auto' aspect
 * (a toolbar strip, a narrow window, ultrawide at 4K) reach it.
 */
export const MAX_EXPORT_SIDE = 4096

export interface ExportSize {
  width: number
  height: number
  fps: number
  /** True when the requested resolution was scaled down to MAX_EXPORT_SIDE on the long side. */
  capped: boolean
}

const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2)

/** `size` scaled down, keeping its shape, so neither side exceeds `max` (even numbers, at least 2). */
export function capSize(size: { width: number; height: number }, max = MAX_EXPORT_SIDE): { width: number; height: number; capped: boolean } {
  const long = Math.max(size.width, size.height)
  if (long <= max) return { ...size, capped: false }
  const k = max / long
  const fit = (v: number): number => Math.min(max - (max % 2), Math.max(2, Math.round((v * k) / 2) * 2))
  return { width: fit(size.width), height: fit(size.height), capped: true }
}

/** Aspect ratio of the exported file: the options' override, else the project's own. */
export const exportAspect = (project: Pick<Project, 'style'>, options: Pick<ExportOptions, 'aspect'>): AspectRatio => options.aspect ?? project.style.aspectRatio

/**
 * The project as an export with `options` draws it: the same project with the export's
 * aspect ratio. The saved project is never changed (a copy is returned when they differ).
 */
export function exportProject<P extends Pick<Project, 'style'>>(project: P, options: Pick<ExportOptions, 'aspect'>): P {
  const aspectRatio = exportAspect(project, options)
  return aspectRatio === project.style.aspectRatio ? project : { ...project, style: { ...project.style, aspectRatio } }
}

/** Effective export size and rate, with whether the size was capped. 'auto' follows the recording as shown (its crop). */
export function exportSize(project: Project, settings: ExportOptions): ExportSize {
  const gif = settings.format === 'gif'
  const height = gif ? Math.min(settings.resolution, GIF_MAX_HEIGHT) : settings.resolution
  const shown = visibleSize(project)
  let size = outputSize(exportAspect(project, settings), shown.width, shown.height, height)
  if (settings.maxWidth && size.width > settings.maxWidth) {
    const k = settings.maxWidth / size.width
    size = { width: Math.max(2, settings.maxWidth - (settings.maxWidth % 2)), height: even(size.height * k) }
  }
  return { ...capSize(size), fps: gif ? GIF_FPS : settings.fps }
}

/** Effective export parameters. */
export function exportDimensions(project: Project, settings: ExportOptions): { width: number; height: number; fps: number } {
  const { width, height, fps } = exportSize(project, settings)
  return { width, height, fps }
}

/** Formats without video frames (nothing is rendered). */
export const isAudioOnly = (format: ExportFormat): boolean => format === 'm4a'

/** Video codec a format carries. */
export const videoCodecOf = (format: ExportFormat): 'h264' | 'vp9' | 'gif' | null =>
  format === 'webm' ? 'vp9' : format === 'gif' ? 'gif' : format === 'm4a' ? null : 'h264'

/** How frames become a file, in the order to try them. */
export type ExportRoute =
  | { video: 'webcodecs'; codec: 'h264' | 'vp9'; hardware: boolean }
  | { video: 'ffmpeg'; encoder: FfmpegVideoEncoder }
  /** Audio only: nothing is rendered. */
  | { video: 'none' }

const ENCODER_NAMES: Record<FfmpegVideoEncoder, string> = {
  h264_nvenc: 'GPU (NVIDIA NVENC)',
  h264_qsv: 'GPU (Intel Quick Sync)',
  h264_amf: 'GPU (AMD AMF)',
  h264_mf: 'GPU (Media Foundation)',
  libx264: 'Software (x264)',
  'libvpx-vp9': 'Software (VP9)'
}

export function routeLabel(r: ExportRoute, format: ExportFormat): string {
  if (r.video === 'none' || format === 'm4a') return 'Audio only (AAC)'
  if (format === 'gif') return 'GIF (two-pass palette)'
  if (r.video === 'webcodecs') {
    const name = r.codec === 'vp9' ? 'WebCodecs VP9' : 'WebCodecs'
    return r.hardware ? `GPU (${name})` : `${name} (software)`
  }
  return ENCODER_NAMES[r.encoder]
}

/**
 * Fallback chain for "Auto": WebCodecs on the GPU (frames never leave the GPU
 * process; only compressed chunks cross IPC), then ffmpeg's GPU encoders (raw
 * frames over IPC), then the software encoder. "Software" means x264 (libvpx for WebM).
 *
 * WebCodecs' software H.264 encoder (OpenH264) is about 2.5x faster than raw frames +
 * x264 on a CPU-only machine, but leaves faint ghosts of anything that fades out
 * over a flat background until the next keyframe, so it is not used by default
 * (only through the test override, to exercise the WebCodecs path on Linux).
 *
 * WebM is VP9: WebCodecs VP9 on the GPU when the machine has a VP9 encoder (recent Intel
 * and AMD GPUs), else WebCodecs' own libvpx (same encoder and look as ffmpeg's realtime
 * libvpx, about twice as fast because no raw frames cross IPC), else ffmpeg's libvpx-vp9.
 * A size target skips the software WebCodecs encoder: libvpx in ffmpeg then runs two passes,
 * which lands on the size (see exportArgs).
 */
export function exportRoutes(settings: Pick<ExportOptions, 'format' | 'encoder' | 'targetSizeMB'>, caps: Pick<ExportCapabilities, 'hardwareEncoders' | 'overrides'>): ExportRoute[] {
  if (isAudioOnly(settings.format)) return [{ video: 'none' }]
  const x264: ExportRoute = { video: 'ffmpeg', encoder: 'libx264' }
  if (settings.format === 'gif') return [x264]
  const forced = caps.overrides.videoEncoder
  if (settings.format === 'webm') {
    const vpx: ExportRoute = { video: 'ffmpeg', encoder: 'libvpx-vp9' }
    if (forced === 'webcodecs-software') return [{ video: 'webcodecs', codec: 'vp9', hardware: false }, vpx]
    if (settings.encoder === 'software' || forced === 'ffmpeg') return [vpx]
    const routes: ExportRoute[] = [{ video: 'webcodecs', codec: 'vp9', hardware: true }]
    if (!settings.targetSizeMB) routes.push({ video: 'webcodecs', codec: 'vp9', hardware: false })
    return [...routes, vpx]
  }
  if (forced === 'webcodecs-software') return [{ video: 'webcodecs', codec: 'h264', hardware: false }, x264]
  if (settings.encoder === 'software') return [x264]
  const routes: ExportRoute[] = []
  if (forced !== 'ffmpeg') routes.push({ video: 'webcodecs', codec: 'h264', hardware: true })
  for (const e of caps.hardwareEncoders) routes.push({ video: 'ffmpeg', encoder: e })
  routes.push(x264)
  return routes
}

/* ---------- Target file size ---------- */

/** "MB" in size targets and limits: 1,000,000 bytes (what upload limits mean). */
export const MB = 1e6

/** Share of a size target kept free for container overhead and encoder overshoot. */
const SIZE_MARGIN = 0.97
/** Fixed container overhead (headers, sample tables), bytes. */
const CONTAINER_BYTES = 16_000

export interface TargetBitrates {
  /** Video bit rate (bit/s), 0 for audio-only exports. */
  video: number
  /** Audio bit rate (bit/s), 0 when the export is silent. */
  audio: number
  /** Video bits per pixel per frame: below ~0.02 a screen recording looks blocky. */
  bpp: number
  /** False when the size is too small to hold even a minimal video. */
  feasible: boolean
}

/** Lowest video bit rate a target-size export uses (bit/s). */
export const MIN_VIDEO_BITRATE = 100_000

/**
 * Bit rates that make a `seconds`-long export about `targetMB` in size: the audio gets a
 * modest fixed rate (less when the budget is tight), the video the rest after a small margin.
 */
export function targetBitrates(input: {
  targetMB: number
  seconds: number
  hasAudio: boolean
  format: ExportFormat
  width: number
  height: number
  fps: number
}): TargetBitrates {
  const seconds = Math.max(0.1, input.seconds)
  const total = Math.max(0, (input.targetMB * MB * SIZE_MARGIN - CONTAINER_BYTES) * 8) / seconds
  if (isAudioOnly(input.format)) {
    const audio = Math.round(Math.min(320_000, Math.max(32_000, total)))
    return { video: 0, audio, bpp: 0, feasible: total >= 32_000 }
  }
  let audio = 0
  if (input.hasAudio) {
    const opus = input.format === 'webm'
    audio = total >= 3_000_000 ? (opus ? 128_000 : 160_000) : total >= 1_000_000 ? 128_000 : total >= 400_000 ? 96_000 : 64_000
    audio = Math.min(audio, Math.max(32_000, total * 0.25))
  }
  const video = Math.max(MIN_VIDEO_BITRATE, Math.round(total - audio))
  const bpp = video / (input.width * input.height * input.fps)
  return { video, audio: Math.round(audio), bpp, feasible: total - audio >= MIN_VIDEO_BITRATE }
}

/** Below this many bits per pixel per frame the dialog suggests a lower resolution or frame rate. */
export const LOW_BPP = 0.015

/** Signed relative error of a finished file against its size target (0.05 = 5% over). */
export const sizeError = (bytes: number, targetMB: number): number => bytes / (targetMB * MB) - 1
