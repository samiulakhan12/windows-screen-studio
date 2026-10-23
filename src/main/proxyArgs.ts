import type { NormRect } from '../shared/types'
import type { H264Encoder } from './hwEncoders'

export interface ProxyOptions {
  /** H.264 encoder; libx264 when omitted. */
  encoder?: H264Encoder
  /** Constant output frame rate (default 60). */
  fps?: number
  /** Fixed output size. Frames of another size (a resized window) are fitted without stretching. */
  size?: { width: number; height: number } | null
  /** Normalised crop applied first (region recordings). */
  crop?: NormRect | null
  /** Separate audio file (native capture) whose timeline starts `offset` seconds after the video's. */
  audio?: { input: string; offset: number } | null
  /** Write machine-readable progress to stdout (see proxyRunner). */
  progress?: boolean
}

/** Rounds a normalised coordinate so TypeScript and ffmpeg's evaluator compute identical pixels. */
const q = (v: number): number => Number(Math.min(1, Math.max(0, v)).toFixed(6))

const evenFloor = (v: number): number => 2 * Math.floor(v / 2)

/** Pixel rectangle (even values, inside the frame) that a normalised region covers. */
export function regionPixels(region: NormRect, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const w = Math.max(2, evenFloor(q(region.w) * width))
  const h = Math.max(2, evenFloor(q(region.h) * height))
  const x = Math.min(evenFloor(q(region.x) * width), evenFloor(width - w))
  const y = Math.min(evenFloor(q(region.y) * height), evenFloor(height - h))
  return { x: Math.max(0, x), y: Math.max(0, y), width: w, height: h }
}

/**
 * Crop expressed against the decoded frame size, mirroring regionPixels(), so the
 * crop is exact for whatever size the encoder actually produced.
 */
export function cropFilter(region: NormRect): string {
  const e = (v: number, dim: 'iw' | 'ih'): string => `2*trunc(${dim}*${q(v)}/2)`
  const w = `max(2\\,${e(region.w, 'iw')})`
  const h = `max(2\\,${e(region.h, 'ih')})`
  const x = `min(${e(region.x, 'iw')}\\,2*trunc((iw-out_w)/2))`
  const y = `min(${e(region.y, 'ih')}\\,2*trunc((ih-out_h)/2))`
  return `crop=w=${w}:h=${h}:x=${x}:y=${y}:exact=1`
}

function encoderArgs(encoder: H264Encoder, bitrate: number): string[] {
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p3', '-rc', 'vbr', '-cq', '19', '-b:v', '0']
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'faster', '-global_quality', '19']
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '20']
    case 'h264_mf':
      return ['-c:v', 'h264_mf', '-b:v', String(bitrate)]
    default:
      return ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '17']
  }
}

/** Hardware encoders want NV12 input; the software path keeps planar 4:2:0. */
const pixelFormat = (encoder: H264Encoder): string =>
  encoder === 'h264_qsv' || encoder === 'h264_amf' || encoder === 'h264_mf' ? 'nv12' : 'yuv420p'

/** Re-encodes a recording into a seekable, constant-rate H.264 MP4 with short GOPs. */
export function proxyArgs(input: string, output: string, withAudio: boolean, options: ProxyOptions = {}): string[] {
  const encoder = options.encoder ?? 'libx264'
  const fps = options.fps ?? 60
  const filters: string[] = []
  if (options.crop) filters.push(cropFilter(options.crop))
  const size = options.size
  if (size) {
    const { width: W, height: H } = size
    filters.push(
      `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1'
    )
  } else {
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  }
  filters.push(`format=${pixelFormat(encoder)}`)
  const bitrate = Math.round(Math.min(40e6, Math.max(4e6, (size ? size.width * size.height : 1920 * 1080) * fps * 0.15)))

  const audio = options.audio ?? null
  const audioInput = audio
    ? [...(audio.offset < 0 ? ['-ss', (-audio.offset).toFixed(3)] : []), '-i', audio.input]
    : []
  const audioOut = !!audio || withAudio
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-i', input,
    ...audioInput,
    '-map', '0:v:0',
    ...(audio ? ['-map', '1:a:0?'] : withAudio ? ['-map', '0:a:0?'] : []),
    '-vf', filters.join(','),
    // WebM uses a 1 ms timebase; without an explicit rate ffmpeg would emit 1000 fps.
    '-fps_mode', 'cfr',
    '-r', String(fps),
    ...encoderArgs(encoder, bitrate),
    '-g', '15',
    ...(audio && audio.offset > 0 ? ['-af', `adelay=${Math.round(audio.offset * 1000)}:all=1`] : []),
    ...(audioOut ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    ...(options.progress ? ['-progress', 'pipe:1', '-nostats'] : []),
    '-movflags', '+faststart',
    output
  ]
}
