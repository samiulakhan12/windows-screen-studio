/**
 * ffmpeg arguments for the wave 12 codecs and for transparent videos (docs/design/output-and-languages.md
 * §5.4-5.7): HEVC and AV1 from raw frames or WebCodecs streams, CineForm, QuickTime Animation and
 * ProRes, VP9 with alpha, and their audio. Every encoder named here is on ALLOWED_ENCODERS (test 81),
 * and proPlan refuses any other.
 *
 * Every value comes from the fixed tables below and the numbers validateJob checked; no user text
 * reaches these arguments except paths (§18.4).
 */
import type { ColorTags, ExportJob, FfmpegVideoEncoder, RawPixelFormat } from '../shared/api/export'
import { codecOf, encoderAllowed, isIntermediate } from '../shared/render/proFormats'
import {
  audioCodecArgs,
  audioInputs,
  chapterArgs,
  colorTagArgs,
  EXPORT_COLOR,
  externalizeGraph,
  HEAD,
  inputCount,
  planSidecars,
  subtitleArgs,
  targetBitrate,
  vbv,
  vp9EncoderArgs,
  yuvFilter,
  type FfmpegPlan,
  type PlanPaths
} from './exportArgs'
import { encoderPixelFormat, gpuEncoderOptions } from './hwEncoders'

type Quality = ExportJob['quality']
type Pick3 = Readonly<Record<Quality, number>>

/* ---------- Starting values per encoder and quality (Studio · Web · Small file; §5.4) ---------- */

/** NVENC's constant-quality level: HEVC, then AV1 (starting values, calibrated on the reference PC, §0 decision 14). */
const HEVC_NVENC_CQ: Pick3 = { high: 22, medium: 26, small: 30 }
const AV1_NVENC_CQ: Pick3 = { high: 30, medium: 34, small: 38 }
/** Quick Sync's global quality. */
const HEVC_QSV_QUALITY: Pick3 = { high: 23, medium: 27, small: 31 }
const AV1_QSV_QUALITY: Pick3 = { high: 30, medium: 34, small: 38 }
/** AMF's I-frame and P-frame quantisers for HEVC (0-51). */
const HEVC_AMF_QP_I: Pick3 = { high: 20, medium: 24, small: 28 }
const HEVC_AMF_QP_P: Pick3 = { high: 22, medium: 26, small: 30 }
/**
 * AMF's AV1 I-frame quantiser on its 0-255 scale (P-frames 8 above): libaom's crf 30, 34 and 38 on the
 * 0-63 scale, times 4. Starting values for the calibration of §0 decision 14.
 */
const AV1_AMF_QP_I: Pick3 = { high: 120, medium: 136, small: 152 }
/** libaom's and x265's constant rate factors. */
const AOM_CRF: Pick3 = { high: 30, medium: 34, small: 38 }
const X265_CRF: Pick3 = { high: 21, medium: 25, small: 29 }
/** hevc_mf has no quality mode: it gets 0.7 × the H.264 bit rate of the quality (HEVC's size, §5.4). */
const HEVC_MF_RATE = 0.7

/** CineForm's quality per chip: Best, High, Medium (§2.1). */
const CINEFORM_QUALITY: Readonly<Record<Quality, string>> = { high: 'film1', medium: 'high', small: 'medium' }
/** ProRes 422's profile per chip: HQ, 422, LT. */
const PRORES_422_PROFILE: Readonly<Record<Quality, string>> = { high: '3', medium: '2', small: '1' }
/** ProRes 4444's profile. */
const PRORES_4444_PROFILE = '4'

/* ---------- Colour (§5.5) ---------- */

/** HEVC's VUI rewritten to `c` (the BT.601 matrix, limited range, BT.709 primaries and transfer by default). */
function hevcMetadata(c: ColorTags): string {
  const opts = [`colour_primaries=${c.primaries}`, `transfer_characteristics=${c.transfer}`]
  if (c.matrix !== null) opts.push(`matrix_coefficients=${c.matrix}`)
  if (c.fullRange !== null) opts.push(`video_full_range_flag=${c.fullRange ? 1 : 0}`)
  return `hevc_metadata=${opts.join(':')}`
}

/** AV1's sequence header colour description rewritten to `c`. */
function av1Metadata(c: ColorTags): string {
  const opts = [`color_primaries=${c.primaries}`, `transfer_characteristics=${c.transfer}`]
  if (c.matrix !== null) opts.push(`matrix_coefficients=${c.matrix}`)
  if (c.fullRange !== null) opts.push(`color_range=${c.fullRange ? 'pc' : 'tv'}`)
  return `av1_metadata=${opts.join(':')}`
}

/** The editing formats' YUV tags: BT.709 matrix, primaries and transfer, limited range (1-1-1, §5.5). */
const INTERMEDIATE_YUV_TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv']
/** Their RGB tags (CineForm with alpha, Animation): no matrix. */
const INTERMEDIATE_RGB_TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709']

/* ---------- What each encoder makes ---------- */

const HEVC_ENCODERS: readonly FfmpegVideoEncoder[] = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf', 'libx265']
const AV1_ENCODERS: readonly FfmpegVideoEncoder[] = ['av1_nvenc', 'av1_qsv', 'av1_amf', 'libaom-av1']

/** The codec each encoder of this module makes. */
function encoderCodec(encoder: FfmpegVideoEncoder): 'hevc' | 'av1' | 'vp9' | 'cineform' | 'animation' | 'prores' | null {
  if (HEVC_ENCODERS.includes(encoder)) return 'hevc'
  if (AV1_ENCODERS.includes(encoder)) return 'av1'
  if (encoder === 'libvpx-vp9') return 'vp9'
  if (encoder === 'cfhd') return 'cineform'
  if (encoder === 'qtrle') return 'animation'
  if (encoder === 'prores_ks') return 'prores'
  return null
}

const RGB_WITH_ALPHA: readonly RawPixelFormat[] = ['rgba', 'bgra']

/** Refuses a job this module cannot plan (validateJob refuses them first; this is the second line). */
function invalid(): never {
  throw new Error('Invalid export settings')
}

/**
 * The video filter from the frames ffmpeg receives to what `encoder` takes (§5.4): BT.601 limited YUV
 * for HEVC and AV1 (as H.264 today; NV12 for Quick Sync, AMF and Media Foundation), YUV with alpha for
 * VP9, BT.709 10-bit 4:2:2 for CineForm and ProRes 422, 12-bit RGB with alpha for transparent
 * CineForm, ARGB or RGB for Animation, 4:4:4 (with alpha when transparent) for ProRes 4444.
 */
function videoFilter(job: ExportJob, encoder: FfmpegVideoEncoder, input: RawPixelFormat): string {
  // Frames the renderer already converted to I420 are BT.601 limited: say so to the conversion to BT.709.
  const yuvIn = input === 'yuv420p' ? 'in_color_matrix=bt601:in_range=tv:' : ''
  const to709 = (pix: string): string => `scale=${yuvIn}out_color_matrix=bt709:out_range=tv,format=${pix}`
  switch (encoderCodec(encoder)) {
    case 'hevc':
    case 'av1':
      return yuvFilter(encoderPixelFormat(encoder as Parameters<typeof encoderPixelFormat>[0]))
    case 'vp9':
      return yuvFilter(job.alpha ? 'yuva420p' : 'yuv420p')
    case 'cineform':
      return job.alpha ? 'format=gbrap12le' : to709('yuv422p10le')
    case 'animation':
      return job.alpha ? 'format=argb' : input === 'yuv420p' ? `scale=${yuvIn}out_range=pc,format=rgb24` : 'format=rgb24'
    case 'prores':
      if (job.codec === 'prores-4444') return to709(job.alpha ? 'yuva444p10le' : 'yuv444p10le')
      return to709('yuv422p10le')
    default:
      return invalid()
  }
}

/** The encoder's own settings for `job` (a size target switches the delivery codecs to a bit rate; `pass` for two-pass encodes). */
function encoderSettings(job: ExportJob, encoder: FfmpegVideoEncoder, pass?: 1 | 2): string[] {
  const q = job.quality
  const gop = ['-g', String(job.fps * 2)]
  // A size target's rate; the editing formats and VP9 with alpha are sized by quality and never read it (§5.7).
  const b = job.bitrate?.video
  switch (encoder) {
    case 'hevc_nvenc':
      if (b) return ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-b:v', String(b), ...vbv(b), '-spatial-aq', '1', '-profile:v', 'main', ...gop]
      return ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(HEVC_NVENC_CQ[q]), '-b:v', '0', '-spatial-aq', '1', '-profile:v', 'main', ...gop]
    case 'hevc_qsv':
      if (b) return ['-c:v', 'hevc_qsv', '-preset', 'medium', '-b:v', String(b), ...vbv(b), ...gop]
      return ['-c:v', 'hevc_qsv', '-preset', 'medium', '-global_quality', String(HEVC_QSV_QUALITY[q]), ...gop]
    case 'hevc_amf':
      if (b) return ['-c:v', 'hevc_amf', '-quality', 'balanced', '-rc', 'vbr_peak', '-b:v', String(b), ...vbv(b), ...gop]
      return ['-c:v', 'hevc_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(HEVC_AMF_QP_I[q]), '-qp_p', String(HEVC_AMF_QP_P[q]), ...gop]
    case 'hevc_mf':
      // A hardware Media Foundation encoder only, the one the probe found (gpuEncoderOptions: -hw_encoding 1).
      if (b) return ['-c:v', 'hevc_mf', ...gpuEncoderOptions('hevc_mf'), '-b:v', String(b), ...vbv(b), ...gop]
      return ['-c:v', 'hevc_mf', ...gpuEncoderOptions('hevc_mf'), '-b:v', String(Math.round(HEVC_MF_RATE * targetBitrate({ ...job, bitrate: undefined }))), ...gop]
    case 'libx265':
      // Only while CODEC_POLICY.hevcSoftware is on (proPlan refuses it otherwise). A size target runs two passes.
      if (b) return ['-c:v', 'libx265', '-preset', 'fast', '-b:v', String(b), ...gop, '-x265-params', 'log-level=error']
      return ['-c:v', 'libx265', '-preset', 'fast', '-crf', String(X265_CRF[q]), ...gop, '-x265-params', 'log-level=error']
    case 'av1_nvenc':
      if (b) return ['-c:v', 'av1_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-b:v', String(b), ...vbv(b), '-spatial-aq', '1', ...gop]
      return ['-c:v', 'av1_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(AV1_NVENC_CQ[q]), '-b:v', '0', '-spatial-aq', '1', ...gop]
    case 'av1_qsv':
      if (b) return ['-c:v', 'av1_qsv', '-preset', 'medium', '-b:v', String(b), ...vbv(b), ...gop]
      return ['-c:v', 'av1_qsv', '-preset', 'medium', '-global_quality', String(AV1_QSV_QUALITY[q]), ...gop]
    case 'av1_amf':
      if (b) return ['-c:v', 'av1_amf', '-quality', 'balanced', '-rc', 'vbr_peak', '-b:v', String(b), ...vbv(b), ...gop]
      return ['-c:v', 'av1_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(AV1_AMF_QP_I[q]), '-qp_p', String(AV1_AMF_QP_I[q] + 8), ...gop]
    case 'libaom-av1': {
      const common = ['-c:v', 'libaom-av1', '-usage', 'good', '-cpu-used', '6', '-row-mt', '1', '-tiles', '2x2']
      // A size target runs two passes over the lossless intermediate; the bit rate alone is then exact.
      if (b) return [...common, '-b:v', String(b), ...gop]
      return [...common, '-crf', String(AOM_CRF[q]), '-b:v', '0', ...gop]
    }
    case 'libvpx-vp9':
      // VP9 with alpha: today's settings, at the quality's constant level (size targets are off for alpha).
      return vp9EncoderArgs({ ...job, bitrate: undefined }, pass)
    case 'cfhd':
      return ['-c:v', 'cfhd', '-quality', CINEFORM_QUALITY[q]]
    case 'qtrle':
      return ['-c:v', 'qtrle']
    case 'prores_ks':
      // ProRes only while CODEC_POLICY.prores is on (proPlan refuses it otherwise). Never `-vendor apl0`:
      // FFmpeg's encoder is not Apple's, and the file must not claim it is (§0 decision 2, test 23).
      if (job.codec === 'prores-4444') return ['-c:v', 'prores_ks', '-profile:v', PRORES_4444_PROFILE, '-alpha_bits', job.alpha ? '16' : '0']
      return ['-c:v', 'prores_ks', '-profile:v', PRORES_422_PROFILE[q]]
    default:
      return invalid()
  }
}

/** Colour signalling after `encoder` (§5.5): the bitstream's own description where it has one, and the container's tags. */
function encodedColorArgs(job: ExportJob, encoder: FfmpegVideoEncoder): string[] {
  switch (encoderCodec(encoder)) {
    case 'hevc':
      return ['-bsf:v', hevcMetadata(EXPORT_COLOR), ...colorTagArgs(EXPORT_COLOR), '-tag:v', 'hvc1']
    case 'av1':
      return ['-bsf:v', av1Metadata(EXPORT_COLOR), ...colorTagArgs(EXPORT_COLOR)]
    case 'vp9':
      return colorTagArgs(EXPORT_COLOR)
    case 'cineform':
      return job.alpha ? INTERMEDIATE_RGB_TAGS : INTERMEDIATE_YUV_TAGS
    case 'animation':
      return INTERMEDIATE_RGB_TAGS
    case 'prores':
      return INTERMEDIATE_YUV_TAGS
    default:
      return invalid()
  }
}

/**
 * Encoder arguments of `encoder` for `job` (§5.4), from `-c:v` to the colour tags: the encoder's
 * settings for the job's quality or size target, `-g` = 2 × fps for the delivery codecs, then
 * hevc_metadata, the BT.601 tags and `-tag:v hvc1` for HEVC; av1_metadata and the tags for AV1;
 * BT.709 tags for the editing formats.
 */
export function proVideoArgs(job: ExportJob, encoder: FfmpegVideoEncoder): string[] {
  return [...encoderSettings(job, encoder), ...encodedColorArgs(job, encoder)]
}

/** Audio arguments: 32-bit float PCM at 48 kHz for the editing formats (§7.7), today's AAC or Opus otherwise. */
export function proAudioArgs(job: ExportJob): string[] {
  if (job.format === 'mov' && isIntermediate(codecOf(job))) return ['-c:a', 'pcm_f32le', '-ar', '48000']
  return audioCodecArgs(job)
}

/**
 * Arguments that copy a WebCodecs HEVC or AV1 stream and tag it (§5.4, §5.5): the colours as the
 * encoder reported them, exactly as WebCodecs H.264 and VP9 are tagged today (EXPORT_COLOR when not
 * given), and `-tag:v hvc1` for HEVC (QuickTime and Apple devices need it).
 */
export function copyProArgs(kind: 'hevc' | 'av1', color: ColorTags = EXPORT_COLOR): string[] {
  if (kind === 'hevc') return ['-c:v', 'copy', '-bsf:v', hevcMetadata(color), ...colorTagArgs(color), '-tag:v', 'hvc1']
  return ['-c:v', 'copy', '-bsf:v', av1Metadata(color), ...colorTagArgs(color)]
}

/**
 * Muxer settings (§5.4): MP4 and MOV with HEVC or AV1 keep `+faststart+write_colr` as today; the
 * editing formats only `+write_colr` (faststart would rewrite a file of several GB at the end, for no
 * gain in editing software); WebM as today.
 */
function proContainerArgs(job: ExportJob, output: string): string[] {
  if (job.format === 'webm') return ['-f', 'webm', output]
  const flags = isIntermediate(codecOf(job)) ? '+write_colr' : '+faststart+write_colr'
  return ['-movflags', flags, '-f', job.format === 'mov' ? 'mov' : 'mp4', output]
}

/** The encoder a job's raw frames go to, checked against its codec and the allow-list. */
function rawEncoder(job: ExportJob): FfmpegVideoEncoder {
  if (job.video.kind !== 'raw') return invalid()
  const encoder = job.video.encoder
  const made = encoderCodec(encoder)
  const codec = codecOf(job)
  const expected = codec === 'prores-422' || codec === 'prores-4444' ? 'prores' : codec
  if (!encoderAllowed(encoder) || made !== expected) return invalid()
  if (job.alpha && !RGB_WITH_ALPHA.includes(job.video.pixelFormat)) return invalid()
  return encoder
}

/**
 * Every ffmpeg process of a job with a non-default codec or a transparent background (§5). One
 * process as a rule: the frames (raw, or a WebCodecs HEVC or AV1 stream) on stdin, the soundtrack,
 * chapters and subtitle streams as for the codecs of before. libaom (and libx265, with the policy on)
 * with a size target store the converted frames losslessly and run two passes over them, as x264 does.
 */
export function proPlan(job: ExportJob, given: PlanPaths): FfmpegPlan {
  if (job.format !== 'mp4' && job.format !== 'mov' && job.format !== 'webm') return invalid()
  const { tempStem } = given
  const script = `${tempStem}.graph.txt`
  const { paths, files: extra } = planSidecars(job, given)
  const v = job.video
  const encoder = v.kind === 'raw' ? rawEncoder(job) : null
  const twoPass = !!encoder && !!job.bitrate && !job.alpha && (encoder === 'libaom-av1' || encoder === 'libx265')
  if (!twoPass) {
    const { args, script: s } = externalizeGraph(proArgs(job, paths), script)
    const scripts = [...extra, ...(s ? [s] : [])]
    return { capture: args, passes: [], scripts, temps: scripts.map((f) => f.path) }
  }
  if (v.kind !== 'raw' || !encoder) return invalid()
  const intermediate = `${tempStem}.mkv`
  const log = `${tempStem}.pass`
  // The lossless intermediate of today's two-pass plan: BT.601 limited 4:2:0, the encoders' own input.
  const capture = [
    ...HEAD,
    '-f', 'rawvideo', '-pix_fmt', v.pixelFormat, '-s', `${job.width}x${job.height}`, '-framerate', String(job.fps), '-i', 'pipe:0',
    '-vf', yuvFilter('yuv420p'),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-f', 'matroska', intermediate
  ]
  const pass1 = [...HEAD, '-i', intermediate, '-map', '0:v:0', ...encoderSettings(job, encoder, 1), '-pass', '1', '-passlogfile', log, '-an', '-f', 'null', '-']
  const sound = audioInputs(job, paths, 1)
  const pass2 = [...HEAD, '-i', intermediate, ...sound.args]
  const chapters = chapterArgs(paths, inputCount(pass2))
  pass2.push(...chapters.input)
  const subtitles = subtitleArgs({ inputs: pass2 }, inputCount(pass2), paths.subtitles ?? [], job.format)
  if (sound.graph) pass2.push('-filter_complex', sound.graph)
  pass2.push('-map', '0:v:0', ...encoderSettings(job, encoder, 2), '-pass', '2', '-passlogfile', log, ...encodedColorArgs(job, encoder))
  if (sound.graph) pass2.push('-map', '[aout]', ...proAudioArgs(job))
  pass2.push(...subtitles, ...chapters.map, ...proContainerArgs(job, paths.output))
  const { args, script: s } = externalizeGraph(pass2, script)
  const logs = [`${log}-0.log`, `${log}-0.log.temp`, `${log}-0.log.mbtree`, `${log}-0.log.mbtree.temp`]
  const scripts = [...extra, ...(s ? [s] : [])]
  return { capture, passes: [pass1, args], scripts, temps: [intermediate, ...logs, ...scripts.map((f) => f.path)] }
}

/** The one-process arguments of a job with a new codec or a transparent background (the shape of exportArgs). */
function proArgs(job: ExportJob, io: PlanPaths): string[] {
  const args = [...HEAD]
  const v = job.video
  if (v.kind === 'raw') args.push('-f', 'rawvideo', '-pix_fmt', v.pixelFormat, '-s', `${job.width}x${job.height}`, '-framerate', String(job.fps), '-i', 'pipe:0')
  // Input -r: number the packets i/fps, as for WebCodecs H.264 (an Annex B stream carries no timing ffmpeg trusts).
  else if (v.kind === 'hevc' && codecOf(job) === 'hevc') args.push('-f', 'hevc', '-r', String(job.fps), '-i', 'pipe:0')
  // IVF carries a 1/fps time base and a frame number per frame (fourcc 'AV01').
  else if (v.kind === 'av1' && codecOf(job) === 'av1') args.push('-f', 'ivf', '-i', 'pipe:0')
  else return invalid()
  const sound = audioInputs(job, io, 1)
  args.push(...sound.args)
  const chapters = chapterArgs(io, inputCount(args))
  args.push(...chapters.input)
  const subtitles = subtitleArgs({ inputs: args }, inputCount(args), io.subtitles ?? [], job.format)

  const graphs: string[] = []
  if (v.kind === 'raw') graphs.push(`[0:v]${videoFilter(job, rawEncoder(job), v.pixelFormat)}[vout]`)
  if (sound.graph) graphs.push(sound.graph)
  if (graphs.length) args.push('-filter_complex', graphs.join(';'))

  if (v.kind === 'raw') args.push('-map', '[vout]', ...proVideoArgs(job, rawEncoder(job)))
  else args.push('-map', '0:v:0', ...copyProArgs(v.kind, v.color))
  if (sound.graph) args.push('-map', '[aout]', ...proAudioArgs(job))
  args.push(...subtitles, ...chapters.map, ...proContainerArgs(job, io.output))
  return args
}
