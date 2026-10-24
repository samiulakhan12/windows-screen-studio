import type { AspectRatio, ExportFormat, ExportSettings } from '../types'

/**
 * Export options: the saved ExportSettings plus the parts a destination preset can set
 * for one export only. `aspect` overrides the project's aspect ratio for the exported
 * file (the project itself keeps its own); `maxWidth` limits the width (Slack GIFs).
 */
export interface ExportOptions extends ExportSettings {
  aspect?: AspectRatio
  maxWidth?: number
}

export type PresetIcon = 'youtube' | 'x' | 'linkedin' | 'instagram' | 'tiktok' | 'shorts' | 'square' | 'slack' | 'email'

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
    o.maxWidth === p.maxWidth
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

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)
const FORMATS: readonly ExportFormat[] = ['mp4', 'gif', 'webm', 'mov', 'm4a']
const ASPECTS: readonly AspectRatio[] = ['auto', '16:9', '9:16', '1:1', '4:3']
export const TARGET_MB_RANGE = { min: 1, max: 4000 }

/** Options read back from storage: anything unknown or out of range is dropped. */
export function normalizeOptions(raw: unknown): ExportOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ExportOptions>
  const o: ExportOptions = {
    format: pick(r.format, FORMATS, DEFAULT_EXPORT_OPTIONS.format),
    resolution: pick(r.resolution, [720, 1080, 1440, 2160] as const, DEFAULT_EXPORT_OPTIONS.resolution),
    fps: pick(r.fps, [30, 60] as const, DEFAULT_EXPORT_OPTIONS.fps),
    quality: pick(r.quality, ['high', 'medium', 'small'] as const, DEFAULT_EXPORT_OPTIONS.quality),
    encoder: pick(r.encoder, ['auto', 'software'] as const, DEFAULT_EXPORT_OPTIONS.encoder)
  }
  if (ASPECTS.includes(r.aspect as AspectRatio)) o.aspect = r.aspect
  if (typeof r.targetSizeMB === 'number' && r.targetSizeMB >= TARGET_MB_RANGE.min && r.targetSizeMB <= TARGET_MB_RANGE.max) o.targetSizeMB = r.targetSizeMB
  if (typeof r.maxWidth === 'number' && r.maxWidth >= 64 && r.maxWidth <= 8192) o.maxWidth = Math.round(r.maxWidth)
  if (typeof r.preset === 'string' && presetById(r.preset)) o.preset = r.preset
  return tweakOptions(o, {})
}

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = { mp4: 'mp4', gif: 'gif', webm: 'webm', mov: 'mov', m4a: 'm4a' }

export const FORMAT_LABELS: Record<ExportFormat, string> = { mp4: 'MP4', gif: 'GIF', webm: 'WebM', mov: 'MOV', m4a: 'M4A' }

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
    const size = current.format === 'm4a' ? 'Audio' : RESOLUTION_LABELS[current.resolution]
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
