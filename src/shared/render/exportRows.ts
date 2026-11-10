/**
 * The export dialog's settings rows as data (docs/design/output-and-languages.md §2.1): which chips
 * show, which are disabled and why (message keys), each row's hint, and the picks that switch other
 * settings in the same step. Pure.
 *
 * Settings that hold no new field give today's rows: the codec is the format's default, Background
 * is With background, and the old chips are neither hidden nor disabled.
 */
import type { FfmpegVideoEncoder } from '../api/export'
import { fmt } from '../i18n/fmt'
import { t, type MessageKey, type MessageValues } from '../i18n/t'
import type { ExportCodec, ExportFormat, ExportFps, ExportSettings } from '../types'
import { GIF_FPS, GIF_MAX_HEIGHT } from './exportPlan'
import { tweakOptions, withUsableCodec, type ExportOptions } from './exportPresets'
import { canAlpha, codecAllowed, codecOf, CODEC_POLICY, DEFAULT_CODEC, encodeSecondsEstimate, estimateBytes, EXPORT_FPS, FORMAT_CODECS, isIntermediate } from './proFormats'

/** What this PC can make, as the dialog knows it (the HEVC probe may still run). */
export interface CodecUiCaps {
  hevc: 'probing' | 'none' | FfmpegVideoEncoder[] | 'webcodecs'
  av1Gpu: boolean
  h264Gpu: boolean
}

/** A chip of a row: its value, and why it is disabled (a message key), or null. */
export interface RowChip<V> {
  value: V
  disabled: MessageKey | null
}

/** The rows the dialog shows for the current settings (null: the row is hidden). */
export interface RowsState {
  codec: { chips: RowChip<ExportCodec>[]; hint: MessageKey | null; notice: MessageKey | null } | null
  background: { chips: RowChip<'with' | 'background' | 'overlays'>[]; hint: MessageKey | null } | null
  fps: { chips: RowChip<ExportFps>[]; reason: MessageKey | null }
  quality: { labels: 'delivery' | 'intermediate'; hidden: boolean }
  targetSize: { disabled: MessageKey | null }
  encoder: { hidden: boolean; softwareDisabled: MessageKey | null }
}

/**
 * Codec names as technical lines and hints spell them, the same in every UI language (§9.7):
 * "HEVC video with AAC audio", "1080×1350 · 30 fps · HEVC · 2 min 14 s", "Back to H.264.".
 */
export const CODEC_NAMES: Readonly<Record<ExportCodec, string>> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  cineform: 'CineForm',
  animation: 'QuickTime Animation',
  'prores-422': 'ProRes 422',
  'prores-4444': 'ProRes 4444'
}

/** Whether the HEVC probe found something this PC can make HEVC with (still probing counts: nothing is changed before it ends). */
const hevcMade = (caps: CodecUiCaps): boolean => caps.hevc === 'probing' || caps.hevc === 'webcodecs' || (Array.isArray(caps.hevc) && caps.hevc.length > 0)

/** Whether this PC can make `codec`: HEVC as the probe found, the others as the owner's policy allows. */
export const usableHere =
  (caps: CodecUiCaps) =>
  (codec: ExportCodec): boolean =>
    codec === 'hevc' ? hevcMade(caps) : codecAllowed(codec)

/** The video formats, whose Codec row shows. */
const hasCodecs = (format: ExportFormat): boolean => FORMAT_CODECS[format].length > 0

/** H.264 cannot carry 4K at 120 fps (level 6.0, §5.6): 4K with H.264 is exported at 60 fps. */
const h264At4k = (o: ExportOptions): boolean => o.resolution === 2160 && FORMAT_CODECS[o.format].includes('h264') && codecOf(o) === 'h264'

/** Drops what does not apply after a pick: a target size where Target size is off, 120 fps for 4K with H.264, HEVC's Software. */
function settle(o: ExportOptions): ExportOptions {
  let next = o
  if (next.targetSizeMB !== undefined && targetOff(next)) next = tweakOptions(next, { targetSizeMB: undefined })
  if (next.fps === 120 && h264At4k(next)) next = tweakOptions(next, { fps: 60 })
  if (codecOf(next) === 'hevc' && next.encoder === 'software' && !CODEC_POLICY.hevcSoftware) next = tweakOptions(next, { encoder: 'auto' })
  return next
}

/** Why Target size is off for `o` (WAV, the editing formats, transparent videos), or null. */
function targetOff(o: ExportOptions): MessageKey | null {
  if (o.format === 'wav') return 'codecs.target.wav'
  if (hasCodecs(o.format) && isIntermediate(codecOf(o))) return 'codecs.target.editing'
  if (o.alpha && canAlpha(o.format, codecOf(o))) return 'codecs.target.transparent'
  return null
}

/**
 * `o` with a codec this PC can make, and the notice that says so when it changed (§2.1, §2.2): stored
 * settings or a preset asking for HEVC where the probe found no encoder export with the format's
 * default codec. A user preset says "This preset uses HEVC…", other settings "This PC cannot make
 * HEVC…"; both name {codec} and {fallback} (codecNotice). Nothing changes while the probe runs.
 */
export function usableCodec(o: ExportOptions, caps: CodecUiCaps): { options: ExportOptions; notice: MessageKey | null } {
  const options = withUsableCodec(o, usableHere(caps))
  if (codecOf(options) === codecOf(o)) return { options, notice: null }
  return { options, notice: o.userPreset ? 'presets.notice.cannotMake' : 'codecs.notice.cannotMake' }
}

/** The values of usableCodec's notice: the codec asked for and the one this export uses. */
export function codecNotice(o: ExportOptions, options: ExportOptions): { codec: string; fallback: string } {
  return { codec: CODEC_NAMES[codecOf(o)], fallback: CODEC_NAMES[codecOf(options)] }
}

/** The hint under the Codec row for `o` (replacing the Encoder row's hint for the new codecs), or null for H.264 and VP9. */
function codecHint(o: ExportOptions, caps: CodecUiCaps): MessageKey | null {
  switch (codecOf(o)) {
    case 'hevc':
      return caps.hevc === 'probing' ? null : 'codecs.hint.hevcGpu'
    case 'av1':
      return o.encoder === 'auto' && caps.av1Gpu ? 'codecs.hint.av1Gpu' : 'codecs.hint.av1Cpu'
    case 'cineform':
      return 'codecs.hint.cineform'
    case 'animation':
      return 'codecs.hint.animation'
    case 'prores-422':
    case 'prores-4444':
      return 'codecs.hint.prores'
    default:
      return null
  }
}

/** "NVENC, QSV" for probed GPU encoders, as the H.264 hint names them; "WebCodecs" for Chromium's own. */
export function encoderNames(encoders: readonly string[] | 'webcodecs'): string {
  if (encoders === 'webcodecs') return 'WebCodecs'
  return encoders.map((e) => e.replace(/^(h264|hevc|av1)_/, '').toUpperCase()).join(', ')
}

/**
 * The values of the Codec row's hint (§2.1): {names} the GPU encoders found (for AV1 WebCodecs when
 * Chromium makes it on the graphics card, its first route, as for HEVC; else the AV1 probe's, null
 * while it runs), {size} the estimate for the whole video (estimateBytes), {time} AV1's time on the
 * processor (encodeSecondsEstimate), {length} the video's length.
 */
export function codecHintValues(
  o: ExportOptions,
  caps: CodecUiCaps,
  ctx: { size: { width: number; height: number }; seconds: number },
  av1: { webCodecs: boolean; probe: readonly string[] | null }
): MessageValues {
  const hevc = caps.hevc === 'webcodecs' ? 'webcodecs' : Array.isArray(caps.hevc) ? caps.hevc : []
  return {
    names: encoderNames(codecOf(o) === 'hevc' ? hevc : av1.webCodecs ? 'webcodecs' : (av1.probe ?? [])),
    size: fmt.bytes(estimateBytes(o, ctx.size, ctx.seconds)),
    time: fmt.duration(encodeSecondsEstimate(o, ctx.size, ctx.seconds)),
    length: fmt.duration(ctx.seconds)
  }
}

/**
 * The rows for `o` (§2.1), as this PC exports it (usableCodec): the Codec row for MP4, MOV and WebM
 * with the HEVC chip disabled while the probe runs and absent when it found nothing; Background for
 * MOV and WebM only; the five frame rates with 120 fps off for 4K with H.264; the intermediates'
 * quality chips and their Target size and Encoder rows. `ctx.seeThrough` says whether anything of
 * a Transparent frame is see-through (P2's seeThrough).
 */
export function settingsRows(o: ExportOptions, caps: CodecUiCaps, ctx: { seeThrough: boolean; size: { width: number; height: number }; seconds: number }): RowsState {
  const { options, notice } = usableCodec(o, caps)
  const { format } = options
  const codec = codecOf(options)
  const video = hasCodecs(format)
  const audioOnly = format === 'm4a' || format === 'wav'
  const editing = video && isIntermediate(codec)
  const alpha = !!options.alpha && canAlpha(format, codec)
  const codecRow: RowsState['codec'] = video
    ? {
        chips: FORMAT_CODECS[format]
          .filter((c) => codecAllowed(c) && (c !== 'hevc' || hevcMade(caps)))
          .map((c) => ({ value: c, disabled: c === 'hevc' && caps.hevc === 'probing' ? ('codecs.hevc.probing' as const) : null })),
        hint: codecHint(options, caps),
        notice
      }
    : null
  const backgroundRow: RowsState['background'] =
    format === 'mov' || format === 'webm'
      ? {
          chips: (['with', 'background', 'overlays'] as const).map((value) => ({ value, disabled: null })),
          hint: alpha ? (options.alpha === 'background' && !ctx.seeThrough ? 'alpha.hint.fills' : 'alpha.hint.plays') : null
        }
      : null
  const no120 = h264At4k(options)
  return {
    codec: codecRow,
    background: backgroundRow,
    fps: { chips: EXPORT_FPS.map((value) => ({ value, disabled: value === 120 && no120 ? ('codecs.fps.no4k120' as const) : null })), reason: no120 ? 'codecs.fps.no4k120' : null },
    quality: { labels: editing && codec !== 'animation' ? 'intermediate' : 'delivery', hidden: format === 'gif' || audioOnly || (video && codec === 'animation') },
    targetSize: { disabled: targetOff(options) },
    encoder: {
      hidden: format === 'gif' || audioOnly || editing || alpha,
      softwareDisabled: video && codec === 'hevc' && !CODEC_POLICY.hevcSoftware ? 'codecs.encoder.hevcSoftware' : null
    }
  }
}

/** Picks a codec (Background back to With background when it cannot carry transparency; §2.1). */
export function pickCodec(o: ExportOptions, codec: ExportCodec): ExportOptions {
  if (!FORMAT_CODECS[o.format].includes(codec) || !codecAllowed(codec)) return o
  let next = tweakOptions(o, { codec: codec === DEFAULT_CODEC[o.format] ? undefined : codec })
  if (next.alpha && !canAlpha(next.format, codec)) next = tweakOptions(next, { alpha: undefined })
  return settle(next)
}

/** The codec a transparent background switches to in `format`: CineForm (Lossless with the policy off) in MOV, VP9 in WebM. */
const alphaCodecFor = (format: ExportFormat): ExportCodec | null => (format === 'webm' ? 'vp9' : format === 'mov' ? (CODEC_POLICY.cineform ? 'cineform' : 'animation') : null)

/**
 * Picks a background (undefined: With background). Transparent and Overlays only switch a codec that
 * cannot carry transparency in the same step (MOV: H.264 or HEVC → CineForm; WebM: AV1 → VP9) and give
 * back the codec they replaced; With background puts that codec back (§2.1). MP4 has no Background row.
 */
export function pickBackground(o: ExportOptions, alpha: ExportSettings['alpha'] | undefined, replaced: ExportCodec | null): { options: ExportOptions; replaced: ExportCodec | null } {
  const { format } = o
  const target = alphaCodecFor(format)
  if (!target) return { options: o, replaced }
  if (alpha) {
    const current = codecOf(o)
    if (canAlpha(format, current)) return { options: settle(tweakOptions(o, { alpha })), replaced }
    return { options: settle(tweakOptions(o, { alpha, codec: target === DEFAULT_CODEC[format] ? undefined : target })), replaced: current }
  }
  let next = tweakOptions(o, { alpha: undefined })
  if (replaced && FORMAT_CODECS[format].includes(replaced) && codecAllowed(replaced)) next = tweakOptions(next, { codec: replaced === DEFAULT_CODEC[format] ? undefined : replaced })
  return { options: settle(next), replaced: null }
}

/** Picks a frame rate; 120 fps is not picked for 4K with H.264 (its chip is disabled). */
export function pickFps(o: ExportOptions, fps: ExportFps): ExportOptions {
  if (fps === 120 && h264At4k(o)) return o
  return tweakOptions(o, { fps })
}

/** Picks a resolution (as the Resolution row always has, its width limit cleared); 4K at 120 fps with H.264 → 60 fps. */
export function pickResolution(o: ExportOptions, r: ExportSettings['resolution']): ExportOptions {
  const next = tweakOptions(o, { resolution: r, maxWidth: undefined })
  return next.fps === 120 && h264At4k(next) ? tweakOptions(next, { fps: 60 }) : next
}

/**
 * Picks a format, as the Format row always has (its width limit cleared, GIFs at most 1080p), and
 * drops what the format cannot carry: a codec it has not (back to its default), a transparent
 * background its codec cannot keep, a target size where Target size is off.
 */
export function pickFormat(o: ExportOptions, format: ExportFormat): ExportOptions {
  let next = tweakOptions(o, { format, maxWidth: undefined, ...(format === 'gif' && o.resolution > GIF_MAX_HEIGHT ? { resolution: 1080 as const } : {}) })
  if (next.codec && (!FORMAT_CODECS[format].includes(next.codec) || next.codec === DEFAULT_CODEC[format])) next = tweakOptions(next, { codec: undefined })
  if (next.alpha && !canAlpha(format, codecOf(next))) next = tweakOptions(next, { alpha: undefined })
  return settle(next)
}

/**
 * The size line under the preview: "1080×1920 · 30 fps · 2 min 14 s" as before, and with the codec
 * when it is not the format's default, "1080×1350 · 30 fps · HEVC · 2 min 14 s". A technical line:
 * Latin digits in every language (§11.3).
 */
export function sizeLine(o: ExportOptions, size: { width: number; height: number }, seconds: number): string {
  const values = { size: `${size.width}×${size.height}`, fps: String(o.format === 'gif' ? GIF_FPS : o.fps), length: fmt.duration(seconds) }
  const codec = codecOf(o)
  const standard = DEFAULT_CODEC[o.format]
  return standard && codec !== standard ? t('codecs.sizeLine.withCodec', { ...values, codec: CODEC_NAMES[codec] }) : t('presets.sizeLine.plain', values)
}
