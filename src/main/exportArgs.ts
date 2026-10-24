import { AUDIO_RATE, planSoundtrack, type SoundFiles } from '../shared/render/audioPlan'
import { vp9MetadataFilter } from '../shared/render/codec'
import type { ColorTags, ExportJob, FfmpegVideoEncoder, H264Encoder } from '../shared/api/export'
import type { OutputChapter } from '../shared/render/chapters'
import { encoderPixelFormat, gpuEncoderOptions } from './hwEncoders'

export { AUDIO_RATE, audioFilterGraph, clickPositions, clickTrackGraph, soundtrackGraph } from '../shared/render/audioPlan'

/**
 * How raw frames are converted and tagged: the BT.601 YUV matrix, limited range,
 * sRGB-like (BT.709) primaries and transfer, every field tagged so no player has to
 * guess. Players that honour the tags (Chromium, Media Foundation, VLC) reproduce
 * the canvas colours either way, but Chromium's software video path decodes the
 * BT.709 matrix up to 8 levels off in blue and BT.601 within 3, and Chromium's own
 * WebCodecs encoder also produces BT.601, so both export routes agree. VP9 (WebM)
 * uses the same conversion and tags (libvpx writes them into the bitstream too).
 */
export const EXPORT_COLOR: ColorTags = { primaries: 1, transfer: 1, matrix: 6, fullRange: false }

const PRIMARIES: Record<number, string> = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020' }
const TRANSFER: Record<number, string> = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1' }
const MATRIX: Record<number, string> = { 0: 'gbr', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020nc' }

/** Container colour tags (the `colr` box / WebM Colour element) for `c`. */
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

const X264_CRF: Record<ExportJob['quality'], number> = { high: 18, medium: 22, small: 27 }
const X264_PRESET: Record<ExportJob['quality'], string> = { high: 'veryfast', medium: 'veryfast', small: 'faster' }
const GPU_QP: Record<ExportJob['quality'], number> = { high: 19, medium: 23, small: 28 }
/** VP9 constant-quality levels (0-63). */
const VP9_CRF: Record<ExportJob['quality'], number> = { high: 27, medium: 33, small: 39 }
/** Bits per pixel per frame for bitrate-driven encoders. */
const BPP: Record<ExportJob['quality'], number> = { high: 0.12, medium: 0.07, small: 0.04 }

/** Target bitrate (bit/s) for encoders that need one: the size target's, else one from the quality. */
export function targetBitrate(job: Pick<ExportJob, 'width' | 'height' | 'fps' | 'quality' | 'bitrate'>): number {
  return job.bitrate?.video ?? Math.round(job.width * job.height * job.fps * BPP[job.quality])
}

/** Bit-rate limits for single-pass size targets: the average B, peaks up to 1.5 B over a 2 s buffer. */
const vbv = (b: number): string[] => ['-maxrate', String(Math.round(b * 1.5)), '-bufsize', String(Math.round(b * 2))]

/** Encoder settings for raw-frame H.264 exports (a size target switches every encoder to a bit rate). */
export function videoEncoderArgs(encoder: H264Encoder, job: ExportJob): string[] {
  const gop = ['-g', String(job.fps * 2)]
  const b = job.bitrate?.video
  switch (encoder) {
    case 'h264_nvenc':
      if (b) return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-b:v', String(b), ...vbv(b), '-profile:v', 'high', ...gop]
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(GPU_QP[job.quality]), '-b:v', '0', '-profile:v', 'high', ...gop]
    case 'h264_qsv':
      if (b) return ['-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', String(b), ...vbv(b), ...gop]
      return ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(GPU_QP[job.quality] + 1), ...gop]
    case 'h264_amf':
      if (b) return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'vbr_peak', '-b:v', String(b), ...vbv(b), ...gop]
      return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(GPU_QP[job.quality] - 1), '-qp_p', String(GPU_QP[job.quality] + 1), ...gop]
    case 'h264_mf':
      // A hardware Media Foundation encoder only, the one the probe found (see gpuEncoderOptions).
      return ['-c:v', 'h264_mf', ...gpuEncoderOptions('h264_mf'), '-b:v', String(targetBitrate(job)), ...(b ? vbv(b) : []), ...gop]
    default:
      // With a size target x264 runs two passes (see ffmpegPlan); the bit rate alone is then exact.
      if (b) return ['-c:v', 'libx264', '-preset', X264_PRESET[job.quality], '-b:v', String(b), ...gop]
      return ['-c:v', 'libx264', '-preset', X264_PRESET[job.quality], '-crf', String(X264_CRF[job.quality]), ...gop]
  }
}

/**
 * VP9 (libvpx) settings. Without a size target: constant quality in libvpx's realtime
 * mode (an order of magnitude faster than "good", with row multithreading). A size
 * target runs two passes in "good" mode (realtime overshoots small targets by up to 40%).
 */
export function vp9EncoderArgs(job: Pick<ExportJob, 'width' | 'fps' | 'quality' | 'bitrate'>, pass?: 1 | 2): string[] {
  const tiles = job.width >= 2560 ? 3 : job.width >= 1280 ? 2 : 1
  const common = ['-c:v', 'libvpx-vp9', '-row-mt', '1', '-tile-columns', String(tiles), '-frame-parallel', '0', '-g', String(job.fps * 2)]
  const b = job.bitrate?.video
  // Tight under/overshoot limits: libvpx's defaults let short clips land 10-15% under the target.
  if (b) return [...common, '-deadline', 'good', '-cpu-used', pass === 1 ? '4' : '5', '-b:v', String(b), '-undershoot-pct', '2', '-overshoot-pct', '5']
  return [...common, '-deadline', 'realtime', '-cpu-used', '7', '-crf', String(VP9_CRF[job.quality]), '-b:v', '0']
}

const encoderArgs = (encoder: FfmpegVideoEncoder, job: ExportJob, pass?: 1 | 2): string[] =>
  encoder === 'libvpx-vp9' ? vp9EncoderArgs(job, pass) : videoEncoderArgs(encoder, job)

const pixelFormatFor = (encoder: FfmpegVideoEncoder): string => (encoder === 'libvpx-vp9' ? 'yuv420p' : encoderPixelFormat(encoder))

/** Canvas RGB -> the encoder's YUV, BT.601 limited range (see EXPORT_COLOR). */
const yuvFilter = (pix: string): string => `scale=out_color_matrix=bt601:out_range=tv,format=${pix}`

export interface ExportIo {
  /** File with the source audio (the screen proxy), or null for a silent export. */
  audioInput: string | null
  /** The stem files the job's soundtrack mixes (mic.m4a, system.m4a). */
  stems?: SoundFiles['stems']
  /** The background music file. */
  music?: string | null
  /** The job's chapters as an ffmetadata file (chapterMetadata), written before ffmpeg starts. */
  chapters?: string | null
  /** Where ffmpeg writes (a temporary file next to the target). */
  output: string
}

const HEAD = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats']

/* ---------- chapters ---------- */

/** A value in an ffmetadata file: '=', ';', '#', '\\' and line breaks are escaped with a backslash. */
const metadataValue = (v: string): string => v.replace(/[=;#\\\n]/g, (c) => `\\${c}`).replace(/\r/g, '')

/**
 * The chapters of a `duration`-second export as an ffmetadata file: one [CHAPTER] per chapter in
 * milliseconds, each ending where the next starts and the last at the end of the video. Chapters
 * that would be empty (at or past the end, or in the same millisecond as the next) are left out;
 * null when none is left.
 */
export function chapterMetadata(chapters: readonly OutputChapter[], duration: number): string | null {
  const end = Math.round(duration * 1000)
  const starts = chapters.map((c) => Math.max(0, Math.round(c.start * 1000)))
  const entries: string[] = []
  chapters.forEach((c, i) => {
    const start = starts[i]
    const stop = Math.min(end, i + 1 < chapters.length ? starts[i + 1] : end)
    if (!(stop > start)) return
    const title = metadataValue(c.title.replace(/\s+/g, ' ').trim())
    entries.push(['[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${stop}`, `title=${title}`].join('\n'))
  })
  return entries.length ? [';FFMETADATA1', ...entries, ''].join('\n') : null
}

/** Input arguments of the chapters file (after `inputs` other inputs) and its mapping onto the output. */
function chapterArgs(io: ExportIo, inputs: number): { input: string[]; map: string[] } {
  if (!io.chapters) return { input: [], map: [] }
  return { input: ['-f', 'ffmetadata', '-i', io.chapters], map: ['-map_chapters', String(inputs)] }
}

/** Number of inputs in an ffmpeg argument list so far. */
const inputCount = (args: readonly string[]): number => args.filter((a) => a === '-i').length

/** Audio inputs (recording, music, clicks) after `first` other inputs, and the graph that mixes them into [aout]. */
function audioInputs(job: ExportJob, io: ExportIo, first: number): { args: string[]; graph: string | null } {
  return planSoundtrack(job, { mix: io.audioInput, stems: io.stems, music: io.music }, first)
}

/** Audio codec settings of `job`'s container. */
function audioCodecArgs(job: ExportJob): string[] {
  const opus = job.format === 'webm'
  const rate = job.bitrate?.audio || (opus ? 128_000 : 192_000)
  return ['-c:a', opus ? 'libopus' : 'aac', '-b:a', `${Math.round(rate / 1000)}k`, '-ar', String(AUDIO_RATE)]
}

/** Muxer settings: faststart MP4/MOV/M4A (with colour boxes), WebM. */
function containerArgs(job: ExportJob, output: string): string[] {
  switch (job.format) {
    case 'webm':
      return ['-f', 'webm', output]
    case 'mov':
      return ['-movflags', '+faststart+write_colr', '-f', 'mov', output]
    case 'm4a':
      return ['-movflags', '+faststart', '-f', 'ipod', output]
    default:
      return ['-movflags', '+faststart+write_colr', '-f', 'mp4', output]
  }
}

/** Codec, bitstream filter and container colour tags for a video that arrives already encoded. */
function copyVideoArgs(job: ExportJob): string[] {
  if (job.video.kind === 'h264') return ['-c:v', 'copy', '-bsf:v', colorBitstreamFilter(job.video.color), ...colorTagArgs(job.video.color)]
  if (job.video.kind === 'vp9') {
    const bsf = vp9MetadataFilter(job.video.color)
    return ['-c:v', 'copy', ...(bsf ? ['-bsf:v', bsf] : []), ...colorTagArgs(job.video.color)]
  }
  return []
}

/** Colour signalling after an ffmpeg encode of converted raw frames. */
const encodedColorArgs = (encoder: FfmpegVideoEncoder): string[] =>
  encoder === 'libvpx-vp9' ? colorTagArgs(EXPORT_COLOR) : ['-bsf:v', colorBitstreamFilter(EXPORT_COLOR), ...colorTagArgs(EXPORT_COLOR)]

/**
 * One-process export (MP4, MOV, WebM, M4A): video arrives on stdin (raw frames, an H.264
 * stream, or IVF-framed VP9), audio is cut from the proxy and mixed with the click sounds.
 * Audio-only (M4A) jobs read nothing from stdin.
 */
export function exportArgs(job: ExportJob, io: ExportIo): string[] {
  if (job.format === 'gif') throw new Error('exportArgs builds video and audio exports; GIFs use gifCaptureArgs/gifEncodeArgs')
  const args = [...HEAD]
  const v = job.video
  const hasVideo = v.kind !== 'none'
  if (v.kind === 'raw') args.push('-f', 'rawvideo', '-pix_fmt', v.pixelFormat, '-s', `${job.width}x${job.height}`, '-framerate', String(job.fps), '-i', 'pipe:0')
  // Input -r: number the packets i/fps. The raw H.264 demuxer's own guesses follow the
  // encoder's VUI timing fields, which WebCodecs encoders fill inconsistently.
  else if (v.kind === 'h264') args.push('-f', 'h264', '-r', String(job.fps), '-i', 'pipe:0')
  // IVF carries a 1/fps time base and a frame number per frame.
  else if (v.kind === 'vp9') args.push('-f', 'ivf', '-i', 'pipe:0')
  else args.push('-nostdin')
  const sound = audioInputs(job, io, hasVideo ? 1 : 0)
  args.push(...sound.args)
  const chapters = chapterArgs(io, inputCount(args))
  args.push(...chapters.input)

  const graphs: string[] = []
  if (v.kind === 'raw') graphs.push(`[0:v]${yuvFilter(pixelFormatFor(v.encoder))}[vout]`)
  if (sound.graph) graphs.push(sound.graph)
  if (graphs.length) args.push('-filter_complex', graphs.join(';'))

  if (v.kind === 'raw') args.push('-map', '[vout]', ...encoderArgs(v.encoder, job), ...encodedColorArgs(v.encoder))
  else if (hasVideo) args.push('-map', '0:v:0', ...copyVideoArgs(job))
  if (sound.graph) args.push('-map', '[aout]', ...audioCodecArgs(job))
  if (!hasVideo && !sound.graph) throw new Error('This recording has no sound to export.')
  args.push(...chapters.map, ...containerArgs(job, io.output))
  return args
}

/** Whether `job` is encoded in two passes over an intermediate (software encoders with a size target). */
export const isTwoPass = (job: ExportJob): boolean =>
  !!job.bitrate && job.format !== 'gif' && job.video.kind === 'raw' && (job.video.encoder === 'libx264' || job.video.encoder === 'libvpx-vp9')

/* ---------- GIF ---------- */

/**
 * GIF pass 1, while frames are rendered: frames are stored losslessly in
 * `intermediate`. Building the palette in the same ffmpeg process would hold every
 * frame in memory until the end (3.3 GB for a 60 s 720p GIF), so the palette is a
 * separate streaming pass over the intermediate.
 */
export function gifCaptureArgs(job: ExportJob, intermediate: string): string[] {
  const pix = job.video.kind === 'raw' ? job.video.pixelFormat : 'rgba'
  return [
    ...HEAD,
    '-f', 'rawvideo', '-pix_fmt', pix, '-s', `${job.width}x${job.height}`, '-framerate', String(job.fps),
    '-i', 'pipe:0',
    '-c:v', 'ffv1', '-pix_fmt', 'bgr0', '-f', 'matroska', intermediate
  ]
}

/** How a GIF is made smaller to fit a size limit: frame rate, scale (of the rendered size) and palette size. */
export interface GifFit {
  fps: number
  scale: number
  colors: number
}

/** Filters that apply a reduced fit to the rendered frames ('' when nothing is reduced). */
export function gifFitFilters(fit: GifFit | undefined, size: { width: number; height: number; fps: number }): string {
  if (!fit) return ''
  const parts: string[] = []
  if (fit.fps < size.fps) parts.push(`fps=${fit.fps}`)
  if (fit.scale < 1) {
    const s = gifFitSize(fit, size)
    parts.push(`scale=${s.width}:${s.height}:flags=lanczos`)
  }
  return parts.join(',')
}

/** Output size of a reduced GIF (even sides). */
export function gifFitSize(fit: GifFit, size: { width: number; height: number }): { width: number; height: number } {
  const even = (v: number): number => Math.max(2, Math.round((v * fit.scale) / 2) * 2)
  return fit.scale < 1 ? { width: even(size.width), height: even(size.height) } : { width: size.width, height: size.height }
}

/** GIF pass 2: a palette from a colour histogram (bounded memory). */
export function gifPaletteArgs(intermediate: string, palette: string, fit?: GifFit, size?: { width: number; height: number; fps: number }): string[] {
  const pre = size ? gifFitFilters(fit, size) : ''
  const colors = fit && fit.colors < 256 ? `max_colors=${fit.colors}:` : ''
  return [...HEAD, '-i', intermediate, '-vf', `${pre ? `${pre},` : ''}palettegen=${colors}stats_mode=diff`, '-update', '1', '-f', 'image2', palette]
}

/** GIF pass 3: maps every frame onto the palette, streaming. */
export function gifEncodeArgs(intermediate: string, palette: string, output: string, fit?: GifFit, size?: { width: number; height: number; fps: number }): string[] {
  const pre = size ? gifFitFilters(fit, size) : ''
  const use = 'paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle'
  return [
    ...HEAD,
    '-i', intermediate,
    '-i', palette,
    '-filter_complex', pre ? `[0:v]${pre}[g];[g][1:v]${use}` : `[0:v][1:v]${use}`,
    '-loop', '0',
    '-f', 'gif',
    output
  ]
}

/** Smallest a GIF is made to fit a size limit. */
const GIF_MIN_FPS = 8
const GIF_MIN_WIDTH = 320
const GIF_MIN_COLORS = 32

/**
 * The next, smaller GIF setting after a pass came out at `bytes` for a limit of
 * `maxBytes`: first a lower frame rate (down to 10 fps), then a smaller size (down to
 * 320 px wide), then fewer colours, then the frame rate down to 8 fps. Sizes are
 * estimated (bytes ~ frames x pixels) with some headroom, and re-measured by the caller.
 * Null when it is already as small as it gets.
 */
export function nextGifFit(fit: GifFit, size: { width: number; fps: number }, bytes: number, maxBytes: number): GifFit | null {
  let need = Math.min(0.92, (maxBytes / bytes) * 0.9)
  let { fps, scale, colors } = fit
  if (fps > 10) {
    const f = Math.max(10, Math.floor(fps * Math.max(need, 0.66)))
    need /= f / fps
    fps = f
  }
  const minScale = Math.min(1, GIF_MIN_WIDTH / size.width)
  if (need < 0.97 && scale > minScale) {
    const s = Math.max(minScale, Math.round(scale * Math.sqrt(need) * 100) / 100)
    need /= (s / scale) ** 2
    scale = s
  }
  if (need < 0.97 && colors > GIF_MIN_COLORS) {
    colors = Math.max(GIF_MIN_COLORS, colors / 2)
    need /= 0.85
  }
  if (need < 0.97 && fps > GIF_MIN_FPS) fps = Math.max(GIF_MIN_FPS, Math.floor(fps * need))
  if (fps === fit.fps && scale === fit.scale && colors === fit.colors) return null
  return { fps, scale, colors }
}

/** Short description of a reduced GIF for the result line ("10 fps · 600×338 · 128 colours"). */
export function describeGifFit(fit: GifFit, size: { width: number; height: number }): string {
  const s = gifFitSize(fit, size)
  return [`${fit.fps} fps`, `${s.width}×${s.height}`, ...(fit.colors < 256 ? [`${fit.colors} colours`] : [])].join(' · ')
}

/* ---------- The whole job ---------- */

/** Longest filter graph passed on the command line (Windows limits a command line to 32767 characters). */
export const GRAPH_INLINE_MAX = 6000

export interface FfmpegPlan {
  /** The process that receives the frames (for audio-only jobs: the only process). */
  capture: string[]
  /** Processes run in order after the capture has finished. */
  passes: string[][]
  /** Files to write before the first process starts (long filter graphs). */
  scripts: { path: string; content: string }[]
  /** Temporary files the plan may create (deleted afterwards and after a cancel or crash). */
  temps: string[]
  /** GIF: the passes the size-limit loop re-runs with a smaller setting. */
  gif?: { intermediate: string; palette: string }
}

export interface PlanPaths extends ExportIo {
  /** Prefix for intermediate files in the temp folder. */
  tempStem: string
}

/** Moves a long -filter_complex into a script file (also accepted by ffmpeg 6.1, the Windows build). */
export function externalizeGraph(args: string[], scriptPath: string): { args: string[]; script: { path: string; content: string } | null } {
  const i = args.indexOf('-filter_complex')
  if (i < 0 || args[i + 1].length <= GRAPH_INLINE_MAX) return { args, script: null }
  const out = [...args]
  out.splice(i, 2, '-filter_complex_script', scriptPath)
  return { args: out, script: { path: scriptPath, content: args[i + 1] } }
}

/**
 * Every ffmpeg process of an export. Plain exports are one process. GIFs store the frames
 * losslessly, then build a palette and the GIF from them. A size target on the software
 * encoders stores the converted frames losslessly (x264 qp 0, fast), then runs the encoder's
 * two passes over them, so the file lands on the size without guessing.
 */
export function ffmpegPlan(job: ExportJob, given: PlanPaths): FfmpegPlan {
  const { tempStem } = given
  if (job.format === 'gif') {
    const gif = { intermediate: `${tempStem}.mkv`, palette: `${tempStem}.png` }
    return {
      capture: gifCaptureArgs(job, gif.intermediate),
      passes: [gifPaletteArgs(gif.intermediate, gif.palette), gifEncodeArgs(gif.intermediate, gif.palette, given.output)],
      scripts: [],
      temps: [gif.intermediate, gif.palette],
      gif
    }
  }
  const script = `${tempStem}.graph.txt`
  // Chapters go in through an ffmetadata file written next to the graph script.
  const metadata = job.chapters?.length ? chapterMetadata(job.chapters, job.frames / job.fps) : null
  const chapterFile = metadata ? { path: `${tempStem}.chapters.txt`, content: metadata } : null
  const paths: PlanPaths = { ...given, chapters: chapterFile?.path ?? null }
  const extra = chapterFile ? [chapterFile] : []
  if (!isTwoPass(job) || job.video.kind !== 'raw') {
    const { args, script: s } = externalizeGraph(exportArgs(job, paths), script)
    const scripts = [...extra, ...(s ? [s] : [])]
    return { capture: args, passes: [], scripts, temps: scripts.map((f) => f.path) }
  }
  const encoder = job.video.encoder
  const intermediate = `${tempStem}.mkv`
  const log = `${tempStem}.pass`
  const capture = [
    ...HEAD,
    '-f', 'rawvideo', '-pix_fmt', job.video.pixelFormat, '-s', `${job.width}x${job.height}`, '-framerate', String(job.fps), '-i', 'pipe:0',
    '-vf', yuvFilter('yuv420p'),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-f', 'matroska', intermediate
  ]
  const pass1 = [...HEAD, '-i', intermediate, '-map', '0:v:0', ...encoderArgs(encoder, job, 1), '-pass', '1', '-passlogfile', log, '-an', '-f', 'null', '-']
  const sound = audioInputs(job, paths, 1)
  const pass2 = [...HEAD, '-i', intermediate, ...sound.args]
  const chapters = chapterArgs(paths, inputCount(pass2))
  pass2.push(...chapters.input)
  if (sound.graph) pass2.push('-filter_complex', sound.graph)
  pass2.push('-map', '0:v:0', ...encoderArgs(encoder, job, 2), '-pass', '2', '-passlogfile', log, ...encodedColorArgs(encoder))
  if (sound.graph) pass2.push('-map', '[aout]', ...audioCodecArgs(job))
  pass2.push(...chapters.map, ...containerArgs(job, paths.output))
  const { args, script: s } = externalizeGraph(pass2, script)
  const logs = [`${log}-0.log`, `${log}-0.log.temp`, `${log}-0.log.mbtree`, `${log}-0.log.mbtree.temp`]
  const scripts = [...extra, ...(s ? [s] : [])]
  return { capture, passes: [pass1, args], scripts, temps: [intermediate, ...logs, ...scripts.map((f) => f.path)] }
}
