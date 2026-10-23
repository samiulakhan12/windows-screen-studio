import type { ExportCapabilities, H264Encoder } from '../api/export'
import { outputSize } from '../engine/layout'
import type { ExportSettings, Project } from '../types'

/** GIFs play at 15 fps; their size options stop at 1080p. */
export const GIF_FPS = 15
export const GIF_MAX_HEIGHT = 1080

/** Effective export parameters. */
export function exportDimensions(project: Project, settings: ExportSettings): { width: number; height: number; fps: number } {
  const gif = settings.format === 'gif'
  const height = gif ? Math.min(settings.resolution, GIF_MAX_HEIGHT) : settings.resolution
  const size = outputSize(project.style.aspectRatio, project.width, project.height, height)
  return { ...size, fps: gif ? GIF_FPS : settings.fps }
}

/** How frames become a file, in the order to try them. */
export type ExportRoute = { video: 'webcodecs'; hardware: boolean } | { video: 'ffmpeg'; encoder: H264Encoder }

const ENCODER_NAMES: Record<H264Encoder, string> = {
  h264_nvenc: 'GPU (NVIDIA NVENC)',
  h264_qsv: 'GPU (Intel Quick Sync)',
  h264_amf: 'GPU (AMD AMF)',
  h264_mf: 'GPU (Media Foundation)',
  libx264: 'Software (x264)'
}

export function routeLabel(r: ExportRoute, format: ExportSettings['format']): string {
  if (format === 'gif') return 'GIF (two-pass palette)'
  if (r.video === 'webcodecs') return r.hardware ? 'GPU (WebCodecs)' : 'WebCodecs (software)'
  return ENCODER_NAMES[r.encoder]
}

/**
 * Fallback chain for "Auto": WebCodecs on the GPU (frames never leave the GPU
 * process; only compressed chunks cross IPC), then ffmpeg's GPU encoders (raw
 * frames over IPC), then x264. "Software" means x264.
 *
 * WebCodecs' software encoder (OpenH264) is about 2.5x faster than raw frames +
 * x264 on a CPU-only machine, but leaves faint ghosts of anything that fades out
 * over a flat background until the next keyframe, so it is not used by default
 * (only through the test override, to exercise the WebCodecs path on Linux).
 */
export function exportRoutes(settings: ExportSettings, caps: ExportCapabilities): ExportRoute[] {
  const x264: ExportRoute = { video: 'ffmpeg', encoder: 'libx264' }
  if (settings.format === 'gif') return [x264]
  const forced = caps.overrides.videoEncoder
  if (forced === 'webcodecs-software') return [{ video: 'webcodecs', hardware: false }, x264]
  if (settings.encoder === 'software') return [x264]
  const routes: ExportRoute[] = []
  if (forced !== 'ffmpeg') routes.push({ video: 'webcodecs', hardware: true })
  for (const e of caps.hardwareEncoders) routes.push({ video: 'ffmpeg', encoder: e })
  routes.push(x264)
  return routes
}
