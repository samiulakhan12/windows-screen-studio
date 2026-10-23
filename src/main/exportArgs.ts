import { atempoChain } from '../shared/engine/timeline'
import type { Clip } from '../shared/types'
import type { ColorTags, ExportJob, H264Encoder } from '../shared/api/export'
import { encoderPixelFormat } from './hwEncoders'

/** Rec. 709 limited range: what players assume for HD video and what we convert to. */
export const BT709: ColorTags = { primaries: 1, transfer: 1, matrix: 1, fullRange: false }

const PRIMARIES: Record<number, string> = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020' }
const TRANSFER: Record<number, string> = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1' }
const MATRIX: Record<number, string> = { 0: 'gbr', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020nc' }

/** Seconds as a compact decimal string for filter arguments. */
const sec = (v: number): string => String(Math.max(0, +v.toFixed(6)))

/** Container colour tags (the `colr` box) for `c`. */
export function colorTagArgs(c: ColorTags): string[] {
  const args = ['-color_primaries', PRIMARIES[c.primaries] ?? 'bt709', '-color_trc', TRANSFER[c.transfer] ?? 'bt709']
  if (c.matrix !== null) args.push('-colorspace', MATRIX[c.matrix] ?? 'bt709')
  if (c.fullRange !== null) args.push('-color_range', c.fullRange ? 'pc' : 'tv')
  return args
}

/** Rewrites the H.264 VUI so every decoder sees the right colour description. */
export function colorBitstreamFilter(c: ColorTags): string {
  const opts = [`colour_primaries=${c.primaries}`, `transfer_characteristics=${c.transfer}`]
  if (c.matrix !== null) opts.push(`matrix_coefficients=${c.matrix}`)
  if (c.fullRange !== null) opts.push(`video_full_range_flag=${c.fullRange ? 1 : 0}`)
  return `h264_metadata=${opts.join(':')}`
}

/**
 * Soundtrack for an edit: each kept clip of the source audio is cut out, sped up
 * or slowed down (pitch preserved), and the pieces are joined in order. Gaps in
 * the source audio (a late-starting or early-ending track) become silence, and the
 * result is exactly `duration` seconds long so it never cuts the last video frames.
 */
export function audioFilterGraph(clips: Clip[], volume: number, duration: number, input = '1:a'): string {
  const n = clips.length
  const parts: string[] = []
  const src = `[${input}]aresample=async=1:first_pts=0${n > 1 ? `,asplit=${n}${clips.map((_, i) => `[s${i}]`).join('')}` : '[s0]'}`
  parts.push(src)
  clips.forEach((c, i) => {
    const len = c.end - c.start
    const tempo = Math.abs(c.speed - 1) > 1e-6 ? `,${atempoChain(c.speed)}` : ''
    parts.push(`[s${i}]atrim=start=${sec(c.start)}:end=${sec(c.end)},asetpts=PTS-STARTPTS,apad=whole_dur=${sec(len)},atrim=end=${sec(len)}${tempo}[c${i}]`)
  })
  const joined = n > 1 ? `${clips.map((_, i) => `[c${i}]`).join('')}concat=n=${n}:v=0:a=1,` : '[c0]'
  const gain = Math.abs(volume - 1) > 1e-6 ? `volume=${+volume.toFixed(4)},` : ''
  parts.push(`${joined}${gain}apad=whole_dur=${sec(duration)},atrim=end=${sec(duration)}[aout]`)
  return parts.join(';')
}

const X264_CRF: Record<ExportJob['quality'], number> = { high: 18, medium: 22, small: 27 }
const X264_PRESET: Record<ExportJob['quality'], string> = { high: 'veryfast', medium: 'veryfast', small: 'faster' }
const GPU_QP: Record<ExportJob['quality'], number> = { high: 19, medium: 23, small: 28 }
/** Bits per pixel per frame for bitrate-driven encoders. */
const BPP: Record<ExportJob['quality'], number> = { high: 0.12, medium: 0.07, small: 0.04 }

/** Target bitrate (bit/s) for encoders that need one. */
export function targetBitrate(job: Pick<ExportJob, 'width' | 'height' | 'fps' | 'quality'>): number {
  return Math.round(job.width * job.height * job.fps * BPP[job.quality])
}

/** Encoder settings for raw-frame MP4 exports. */
export function videoEncoderArgs(encoder: H264Encoder, job: ExportJob): string[] {
  const gop = ['-g', String(job.fps * 2)]
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(GPU_QP[job.quality]), '-b:v', '0', '-profile:v', 'high', ...gop]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(GPU_QP[job.quality] + 1), ...gop]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(GPU_QP[job.quality] - 1), '-qp_p', String(GPU_QP[job.quality] + 1), ...gop]
    case 'h264_mf':
      return ['-c:v', 'h264_mf', '-b:v', String(targetBitrate(job)), ...gop]
    default:
      return ['-c:v', 'libx264', '-preset', X264_PRESET[job.quality], '-crf', String(X264_CRF[job.quality]), ...gop]
  }
}

export interface ExportIo {
  /** File with the source audio (the screen proxy), or null for a silent export. */
  audioInput: string | null
  /** Where ffmpeg writes (a temporary file next to the target). */
  output: string
}

/** MP4 export: video arrives on stdin (raw RGBA or an H.264 stream), audio is cut from the proxy. */
export function exportArgs(job: ExportJob, io: ExportIo): string[] {
  if (job.format !== 'mp4') throw new Error('exportArgs builds MP4 exports; GIFs use gifCaptureArgs/gifEncodeArgs')
  const duration = job.frames / job.fps
  const raw = job.video.kind === 'raw'
  const color = job.video.kind === 'h264' ? job.video.color : BT709
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
    ...(raw
      ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${job.width}x${job.height}`, '-framerate', String(job.fps)]
      : // Input -r: number the packets i/fps. The raw H.264 demuxer's own guesses follow the
        // encoder's VUI timing fields, which WebCodecs encoders fill inconsistently.
        ['-f', 'h264', '-r', String(job.fps)]),
    '-i', 'pipe:0'
  ]
  const audio = job.audio && io.audioInput && job.audio.clips.length > 0 ? job.audio : null
  if (audio) args.push('-vn', '-i', io.audioInput!)

  const graphs: string[] = []
  if (job.video.kind === 'raw') {
    const pix = encoderPixelFormat(job.video.encoder)
    // RGBA -> Rec. 709 limited range, the matrix every player assumes for HD.
    graphs.push(`[0:v]scale=out_color_matrix=bt709:out_range=tv,format=${pix}[vout]`)
  }
  if (audio) graphs.push(audioFilterGraph(audio.clips, audio.volume, duration))
  if (graphs.length) args.push('-filter_complex', graphs.join(';'))

  args.push('-map', raw ? '[vout]' : '0:v:0')
  if (job.video.kind === 'raw') args.push(...videoEncoderArgs(job.video.encoder, job))
  else args.push('-c:v', 'copy')
  args.push('-bsf:v', colorBitstreamFilter(color), ...colorTagArgs(color))
  if (audio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k')
  args.push('-movflags', '+faststart+write_colr', '-f', 'mp4', io.output)
  return args
}

/**
 * GIF pass 1, while frames are rendered: builds the palette (a bounded colour
 * histogram) and stores the frames losslessly in `intermediate`, so memory stays
 * flat however long the GIF is.
 */
export function gifCaptureArgs(job: ExportJob, intermediate: string, palette: string): string[] {
  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${job.width}x${job.height}`, '-framerate', String(job.fps),
    '-i', 'pipe:0',
    '-filter_complex', '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p]',
    '-map', '[p]', '-update', '1', '-f', 'image2', palette,
    '-map', '[b]', '-c:v', 'ffv1', '-pix_fmt', 'bgr0', '-f', 'matroska', intermediate
  ]
}

/** GIF pass 2: maps every frame onto the palette, streaming. */
export function gifEncodeArgs(intermediate: string, palette: string, output: string): string[] {
  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
    '-i', intermediate,
    '-i', palette,
    '-filter_complex', '[0:v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0',
    '-f', 'gif',
    output
  ]
}
