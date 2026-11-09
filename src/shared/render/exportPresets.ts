import type { AspectRatio, ExportCodec, ExportFormat, ExportSettings } from '../types'
import { canAlpha, codecOf, DEFAULT_CODEC, EXPORT_FPS, FORMAT_CODECS, nearestCodec } from './proFormats'

/**
 * Export options: the saved ExportSettings plus the parts a destination preset can set
 * for one export only. `aspect` overrides the project's aspect ratio for the exported
 * file (the project itself keeps its own); `maxWidth` limits the width (Slack GIFs).
 */
export interface ExportOptions extends ExportSettings {
  aspect?: AspectRatio
  maxWidth?: number
}

export type PresetIcon = 'youtube' | 'x' | 'linkedin' | 'instagram' | 'tiktok' | 'shorts' | 'square' | 'slack' | 'email' | 'portrait' | 'editing' | 'overlay'

/** A destination: everything it needs, plus the limits worth knowing before uploading. */
export interface ExportPreset {
  id: string
  label: string
  icon: PresetIcon
  format: ExportFormat
  resolution: ExportSettings['resolution']
  fps: ExportSettings['fps']
  quality: ExportSettings['quality']
  /** Aspect ratio of the exported file; undefined keeps the project's. */
  aspect?: AspectRatio
  /** Aim for this file size (MB = 1,000,000 bytes). */
  targetSizeMB?: number
  /** Widest the output may be, in pixels. */
  maxWidth?: number
  /** The platform's upload limits (shown as a note, never enforced). */
  limits?: { maxMB?: number; maxSeconds?: number }
  /** The codec when it is not the format's default (output-and-languages §2.2); absent: the default. */
  codec?: ExportCodec
  /** A see-through background (§6); absent: drawn. */
  alpha?: ExportSettings['alpha']
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'youtube-1080', label: 'YouTube 1080p60', icon: 'youtube', format: 'mp4', resolution: 1080, fps: 60, quality: 'high', aspect: '16:9' },
  { id: 'youtube-4k', label: 'YouTube 4K60', icon: 'youtube', format: 'mp4', resolution: 2160, fps: 60, quality: 'high', aspect: '16:9' },
  { id: 'x', label: 'X (Twitter)', icon: 'x', format: 'mp4', resolution: 1080, fps: 60, quality: 'medium', aspect: '16:9', limits: { maxMB: 512, maxSeconds: 140 } },
  { id: 'linkedin', label: 'LinkedIn', icon: 'linkedin', format: 'mp4', resolution: 1080, fps: 30, quality: 'medium', aspect: '16:9' },
  { id: 'reels', label: 'Instagram Reels', icon: 'instagram', format: 'mp4', resolution: 1080, fps: 30, quality: 'high', aspect: '9:16' },
  { id: 'tiktok', label: 'TikTok', icon: 'tiktok', format: 'mp4', resolution: 1080, fps: 30, quality: 'high', aspect: '9:16' },
  { id: 'shorts', label: 'YouTube Shorts', icon: 'shorts', format: 'mp4', resolution: 1080, fps: 60, quality: 'high', aspect: '9:16' },
  { id: 'square', label: 'Square post', icon: 'square', format: 'mp4', resolution: 1080, fps: 30, quality: 'medium', aspect: '1:1' },
  { id: 'slack-gif', label: 'Slack GIF', icon: 'slack', format: 'gif', resolution: 720, fps: 30, quality: 'medium', maxWidth: 720, targetSizeMB: 15 },
  { id: 'email', label: 'Email', icon: 'email', format: 'mp4', resolution: 720, fps: 30, quality: 'small', targetSizeMB: 25 }
]

export const presetById = (id: string | undefined): ExportPreset | undefined => EXPORT_PRESETS.find((p) => p.id === id)

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto' }

/** The options a preset gives, keeping the user's encoder choice. */
export function applyPreset(base: Pick<ExportOptions, 'encoder'>, preset: ExportPreset): ExportOptions {
  const o: ExportOptions = {
    format: preset.format,
    resolution: preset.resolution,
    fps: preset.fps,
    quality: preset.quality,
    encoder: base.encoder,
    preset: preset.id
  }
  if (preset.aspect) o.aspect = preset.aspect
  if (preset.targetSizeMB) o.targetSizeMB = preset.targetSizeMB
  if (preset.maxWidth) o.maxWidth = preset.maxWidth
  if (preset.codec) o.codec = preset.codec
  if (preset.alpha) o.alpha = preset.alpha
  return o
}

/** True when `o` still has exactly the values its preset sets (the encoder is the user's own). */
export function matchesPreset(o: ExportOptions, preset: ExportPreset): boolean {
  const p = applyPreset(o, preset)
  return (
    o.format === p.format &&
    o.resolution === p.resolution &&
    (o.format === 'gif' || o.fps === p.fps) &&
    o.quality === p.quality &&
    o.aspect === p.aspect &&
    o.targetSizeMB === p.targetSizeMB &&
    o.maxWidth === p.maxWidth &&
    // Absent equals absent, so every destination of before wave 12 matches as it did.
    o.codec === p.codec &&
    o.alpha === p.alpha
  )
}

/**
 * Applies a user tweak. The preset id stays while the result still matches it, so the
 * gallery keeps the card selected; any real change makes the settings "Custom".
 */
export function tweakOptions(o: ExportOptions, patch: Partial<ExportOptions>): ExportOptions {
  const next: ExportOptions = { ...o, ...patch }
  for (const k of Object.keys(next) as (keyof ExportOptions)[]) if (next[k] === undefined) delete next[k]
  const preset = presetById(next.preset)
  if (!preset || !matchesPreset(next, preset)) delete next.preset
  return next
}

/*
 * The readers of stored settings, frozen by the contracts of wave 12 (output-and-languages §4.3,
 * §21.0): stored values without a new field are read and written back byte for byte (test 2).
 */

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)
const FORMATS: readonly ExportFormat[] = ['mp4', 'gif', 'webm', 'mov', 'm4a', 'wav']
/** The aspects an export may ask for: the projects' shapes and '4:5', which only exports use. */
const ASPECTS: readonly AspectRatio[] = ['auto', '16:9', '9:16', '1:1', '4:3', '4:5']
const CODECS: readonly ExportCodec[] = ['h264', 'hevc', 'av1', 'vp9', 'cineform', 'animation', 'prores-422', 'prores-4444']
export const TARGET_MB_RANGE = { min: 1, max: 4000 }
/** A user preset's id: 'user:' and 12 lower-case hex digits; built-in ids have no colon. */
export const USER_PRESET_ID = /^user:[0-9a-f]{12}$/

/**
 * Options read back from storage or a preset: anything unknown or out of range is dropped (§4.3).
 * The five old keys are read as before, in the same order; the new ones (codec, alpha, userPreset)
 * follow them, so an old object's key order never changes. A codec the format does not carry is
 * dropped, and one the owner's policy forbids becomes its nearest allowed codec, reported to
 * `onCodecChange` (the preset readers count them).
 */
export function normalizeOptions(raw: unknown, onCodecChange?: (from: ExportCodec, to: ExportCodec) => void): ExportOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ExportOptions>
  const o: ExportOptions = {
    format: pick(r.format, FORMATS, DEFAULT_EXPORT_OPTIONS.format),
    resolution: pick(r.resolution, [720, 1080, 1440, 2160] as const, DEFAULT_EXPORT_OPTIONS.resolution),
    fps: pick(r.fps, EXPORT_FPS, DEFAULT_EXPORT_OPTIONS.fps),
    quality: pick(r.quality, ['high', 'medium', 'small'] as const, DEFAULT_EXPORT_OPTIONS.quality),
    encoder: pick(r.encoder, ['auto', 'software'] as const, DEFAULT_EXPORT_OPTIONS.encoder)
  }
  if (ASPECTS.includes(r.aspect as AspectRatio)) o.aspect = r.aspect
  if (typeof r.targetSizeMB === 'number' && r.targetSizeMB >= TARGET_MB_RANGE.min && r.targetSizeMB <= TARGET_MB_RANGE.max) o.targetSizeMB = r.targetSizeMB
  if (typeof r.maxWidth === 'number' && r.maxWidth >= 64 && r.maxWidth <= 8192) o.maxWidth = Math.round(r.maxWidth)
  if (typeof r.preset === 'string' && presetById(r.preset)) o.preset = r.preset
  const asked = r.codec
  if (CODECS.includes(asked as ExportCodec) && FORMAT_CODECS[o.format].includes(asked as ExportCodec)) {
    const codec = nearestCodec(asked as ExportCodec, o.format)
    if (codec !== asked) onCodecChange?.(asked as ExportCodec, codec)
    // Picking the default again stores nothing.
    if (codec !== DEFAULT_CODEC[o.format]) o.codec = codec
  }
  if ((r.alpha === 'background' || r.alpha === 'overlays') && canAlpha(o.format, codecOf(o))) o.alpha = r.alpha
  if (typeof r.userPreset === 'string' && USER_PRESET_ID.test(r.userPreset)) o.userPreset = r.userPreset
  return tweakOptions(o, {})
}

/** The batch choices (`export-batch`) as stored: destinations, shapes, and the user presets when any (§4.3). */
export interface BatchChoice {
  presets: string[]
  aspects: AspectRatio[]
  /** Ids of ticked user presets; absent when none. Whether each still exists is the dialog's question. */
  userPresets?: string[]
}

/** The batch aspects a stored choice may hold: today's, and '4:5'. */
const BATCH_ASPECTS_READ: readonly AspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '4:5']

/** Stored batch choices with anything unknown dropped; an old object reads back as it was stored. */
export function readBatchChoice(raw: unknown): BatchChoice {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { presets?: unknown; aspects?: unknown; userPresets?: unknown }
  const presets = Array.isArray(r.presets) ? r.presets.filter((p): p is string => typeof p === 'string' && !!presetById(p)) : []
  const aspects = Array.isArray(r.aspects) ? r.aspects.filter((a): a is AspectRatio => BATCH_ASPECTS_READ.includes(a as AspectRatio)) : []
  const out: BatchChoice = { presets, aspects }
  if (Array.isArray(r.userPresets)) {
    const ids = [...new Set(r.userPresets.filter((id): id is string => typeof id === 'string' && USER_PRESET_ID.test(id)))]
    if (ids.length) out.userPresets = ids
  }
  return out
}

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = { mp4: 'mp4', gif: 'gif', webm: 'webm', mov: 'mov', m4a: 'm4a', wav: 'wav' }

export const FORMAT_LABELS: Record<ExportFormat, string> = { mp4: 'MP4', gif: 'GIF', webm: 'WebM', mov: 'MOV', m4a: 'M4A', wav: 'WAV' }

/** A file name Windows accepts: no reserved characters, no trailing dots or spaces. */
export function safeFileName(name: string, fallback = 'Recording'): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
  const stem = clean || fallback
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? `${stem}-` : stem
}

/** One file of a batch export. */
export interface BatchItem {
  /** Stable id (a preset id, or 'aspect:<ratio>'). */
  key: string
  label: string
  /** What the file name says after the project name. */
  fileLabel: string
  options: ExportOptions
}

/** Aspect ratios the current settings can additionally be exported in, in a batch. */
export const BATCH_ASPECTS: readonly Exclude<AspectRatio, 'auto'>[] = ['16:9', '9:16', '1:1', '4:3']

export const aspectFileLabel = (a: AspectRatio): string => (a === 'auto' ? 'Original' : a.replace(':', 'x'))

export const RESOLUTION_LABELS: Record<ExportSettings['resolution'], string> = { 720: '720p', 1080: '1080p', 1440: '1440p', 2160: '4K' }

/**
 * The files of a batch: the ticked presets in gallery order, then the current settings in
 * each ticked aspect ratio. Every preset uses the user's encoder choice.
 */
export function batchItems(presetIds: readonly string[], aspects: readonly AspectRatio[], current: ExportOptions): BatchItem[] {
  const items: BatchItem[] = []
  for (const p of EXPORT_PRESETS) if (presetIds.includes(p.id)) items.push({ key: p.id, label: p.label, fileLabel: p.label, options: applyPreset(current, p) })
  for (const a of BATCH_ASPECTS) {
    if (!aspects.includes(a)) continue
    const options: ExportOptions = { ...current, aspect: a }
    delete options.preset
    const size = current.format === 'm4a' || current.format === 'wav' ? 'Audio' : RESOLUTION_LABELS[current.resolution]
    items.push({ key: `aspect:${a}`, label: `${FORMAT_LABELS[current.format]} ${size} · ${a}`, fileLabel: `${size} ${aspectFileLabel(a)}`, options })
  }
  return items
}

/**
 * File names for a batch, `<name> - <label>.<ext>`, unique within the batch (case-insensitive,
 * as on Windows): a repeated name gets " 2", " 3", ...
 */
export function batchFileNames(projectName: string, items: readonly Pick<BatchItem, 'fileLabel' | 'options'>[]): string[] {
  const base = safeFileName(projectName)
  const seen = new Set<string>()
  return items.map((it) => {
    const stem = safeFileName(`${base} - ${it.fileLabel}`)
    const ext = FORMAT_EXTENSIONS[it.options.format]
    let name = `${stem}.${ext}`
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${stem} ${n}.${ext}`
    seen.add(name.toLowerCase())
    return name
  })
}
