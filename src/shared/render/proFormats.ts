/**
 * Codecs per format, the owner's codec policy, and the encoder allow-list
 * (docs/design/output-and-languages.md §0, §5.1-5.2, §5.6, §5.10). Pure.
 *
 * The tables (FORMAT_CODECS to ALLOWED_ENCODERS) are the contracts' (§21.0): they are a security and
 * compatibility boundary, frozen with tests 2, 5 and 6. The functions below them are part P1's.
 */
import type { ExportCodec, ExportFormat, ExportFps } from '../types'
import type { ExportOptions } from './exportPresets'

/** The codecs each format can carry, its default first (§5.2). GIF and the audio formats carry none. */
export const FORMAT_CODECS: Readonly<Record<ExportFormat, readonly ExportCodec[]>> = {
  mp4: ['h264', 'hevc', 'av1'],
  mov: ['h264', 'hevc', 'cineform', 'animation', 'prores-422', 'prores-4444'],
  webm: ['vp9', 'av1'],
  gif: [],
  m4a: [],
  wav: []
}

/** What each video format meant before wave 12: H.264 for MP4 and MOV, VP9 for WebM. */
export const DEFAULT_CODEC: Readonly<Partial<Record<ExportFormat, ExportCodec>>> = { mp4: 'h264', mov: 'h264', webm: 'vp9' }

/** Codecs that can carry transparency (straight alpha, §6). */
export const ALPHA_CODECS: readonly ExportCodec[] = ['vp9', 'cineform', 'animation', 'prores-4444']

/**
 * The owner's decisions of 9 November 2026 (§0): HEVC through the graphics card only (no libx265),
 * no ProRes, CineForm for editing. Read at call time, so a test may switch a value and switch it back.
 */
export const CODEC_POLICY: { hevcSoftware: boolean; prores: boolean; cineform: boolean } = { hevcSoftware: false, prores: false, cineform: true }

/** Whether the policy lets Flown make `codec` at all (HEVC is allowed: the policy only keeps it off the processor). */
export function codecAllowed(codec: ExportCodec): boolean {
  if (codec === 'prores-422' || codec === 'prores-4444') return CODEC_POLICY.prores
  if (codec === 'cineform') return CODEC_POLICY.cineform
  return true
}

/** The codec an export uses: its own, else its format's default. GIF and the audio formats have none and give 'h264', the routes' default. */
export function codecOf(o: Pick<ExportOptions, 'format' | 'codec'>): ExportCodec {
  return o.codec ?? DEFAULT_CODEC[o.format] ?? 'h264'
}

/** Whether `format` with `codec` can be transparent here (the policy included). */
export function canAlpha(format: ExportFormat, codec: ExportCodec): boolean {
  return FORMAT_CODECS[format].includes(codec) && ALPHA_CODECS.includes(codec) && codecAllowed(codec)
}

/** The editing formats: sized by quality only, always encoded on the processor. */
export function isIntermediate(codec: ExportCodec): boolean {
  return codec === 'cineform' || codec === 'animation' || codec === 'prores-422' || codec === 'prores-4444'
}

/**
 * The codec `format` exports with when it is asked for `codec` (§4.3 rule 2): `codec` itself when the
 * format carries it and the policy allows it; else, for ProRes, CineForm, then Lossless (QuickTime
 * Animation); else the format's default.
 */
export function nearestCodec(codec: ExportCodec, format: ExportFormat): ExportCodec {
  const carries = (c: ExportCodec): boolean => FORMAT_CODECS[format].includes(c) && codecAllowed(c)
  if (carries(codec)) return codec
  const chain: ExportCodec[] = codec === 'prores-422' || codec === 'prores-4444' ? ['cineform', 'animation'] : codec === 'cineform' ? ['animation'] : []
  for (const c of chain) if (carries(c)) return c
  return DEFAULT_CODEC[format] ?? 'h264'
}

/** The export frame rates, in the order the Frame rate row shows them (§2.1). */
export const EXPORT_FPS: readonly ExportFps[] = [24, 25, 30, 60, 120]

/**
 * Every `-c:v` and `-c:a` value Flown may pass to ffmpeg (§5.1): fixed tables only, so no other
 * encoder in the shipped binary can be reached. libx265 and prores_ks join only when the owner turns
 * their policy on. Test 81 checks every value the argument builders can emit against this list.
 */
export const ALLOWED_ENCODERS: readonly string[] = [
  // Video: H.264 and VP9 as before, the copy of WebCodecs streams, the lossless intermediates of GIF
  // and of two-pass size targets.
  'libx264',
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
  'h264_mf',
  'libvpx-vp9',
  'copy',
  'ffv1',
  // Wave 12: HEVC on the graphics card, AV1, CineForm and QuickTime Animation.
  'hevc_nvenc',
  'hevc_qsv',
  'hevc_amf',
  'hevc_mf',
  'av1_nvenc',
  'av1_qsv',
  'av1_amf',
  'libaom-av1',
  'cfhd',
  'qtrle',
  ...(CODEC_POLICY.hevcSoftware ? ['libx265'] : []),
  ...(CODEC_POLICY.prores ? ['prores_ks'] : []),
  // Audio: AAC and Opus as before, FLAC for the music loop cache, MP3 and 16-bit PCM for speech
  // uploads, 32-bit float PCM for stems, WAV and the intermediates, 24-bit PCM for the timelines' copies.
  'aac',
  'libopus',
  'flac',
  'libmp3lame',
  'pcm_s16le',
  'pcm_f32le',
  'pcm_s24le'
]

/* ---------- Part P1 (§21.1): the contracts' stubs keep today's behaviour ---------- */

/** Frame rate that rate-driven bit rates scale with: `fps` up to 60, `60 + (fps - 60) / 2` above (§5.6). Part P1. */
export function rateFps(fps: number): number {
  return fps
}

/** Motion-blur sub-frames per frame: 10 up to 60 fps, 5 at 120 (§5.6). Part P1; the stub is today's EXPORT_BLUR_SAMPLES. */
export function blurSamplesFor(fps: number): number {
  void fps
  return 10
}

/** An upper estimate of the file size in bytes (§5.10), stems included. Part P1. */
export function estimateBytes(o: ExportOptions, size: { width: number; height: number }, seconds: number, stems?: number): number {
  void o
  void size
  void seconds
  void stems
  return 0
}

/** Rough seconds an AV1 export takes on the processor (§5.10). Part P1. */
export function encodeSecondsEstimate(o: ExportOptions, size: { width: number; height: number }, seconds: number): number {
  void o
  void size
  void seconds
  return 0
}

/** Megabytes a minute at 1080p60 of each editing format and of one stem (§5.10), the base of estimateBytes. Part P1. */
export const MB_PER_MINUTE_1080P60: Readonly<Record<'cineform' | 'cineform-alpha' | 'animation' | 'prores-422' | 'prores-4444' | 'stem', number>> = {
  cineform: 1500,
  'cineform-alpha': 3600,
  animation: 2500,
  'prores-422': 3300,
  'prores-4444': 5000,
  stem: 23.04
}
