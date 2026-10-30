/**
 * Versions of an edit (E-12, docs/design/versions.md §2): what a version is, its name and the
 * line that sums it up, how two edits compare, and what opening one keeps of the edit now. Pure;
 * the files are written by src/main/versions.ts.
 */
import { formatTime } from '../engine/project'
import { planOf, videoDuration } from '../engine/freeze'
import type { Project } from '../types'
import { timelineGaps } from './clips'

/** Why Flown kept a version by itself (§2.4). */
export type AutoReason = 'polish' | 'fillers' | 'vertical' | 'square' | 'open'
export const AUTO_REASONS: readonly AutoReason[] = ['polish', 'fillers', 'vertical', 'square', 'open']

/** The counts a version's row and the comparison show. */
export interface VersionSummary {
  /** Video length in seconds: the edit plus the freeze holds, as the export makes it. */
  duration: number
  /** Cuts between clips. */
  cuts: number
  /** The start or the end of the recording is trimmed. */
  trimmed: boolean
  zooms: number
  /** Caption segments. */
  captions: number
  /** Text annotations and title cards. */
  texts: number
  /** Shapes and spotlights. */
  shapes: number
  /** Image overlays. */
  images: number
  chapters: number
  freezes: number
}

/** One kept version as the list shows it. */
export interface VersionMeta {
  /** 'v-<base36 ms>-<8 hex>', made by main. */
  id: string
  name: string
  /** Made by Flown before a risky action. */
  auto: boolean
  reason?: AutoReason
  /** ISO time it was kept. */
  createdAt: string
  /** The snapshot file's size. */
  bytes: number
  /** sha-256 (hex) of the snapshot's project JSON. */
  hash: string
  summary: VersionSummary
}

/** A version id: made by main, the only names a versions folder holds. */
export const VERSION_ID_RE = /^v-[0-9a-z]{6,12}-[0-9a-f]{8}$/

export const VERSION_LIMITS = Object.freeze({
  /** Named versions kept at most. */
  named: 50,
  /** Automatic versions kept: the oldest goes when another is made. */
  auto: 5,
  /** Longest name. */
  name: 80,
  /** Largest snapshot (JSON characters), as a copy (projectCopy.ts PROJECT_MAX). */
  bytes: 64 * 1024 * 1024,
  /** Index entries read at most. */
  index: 200
})

/** `raw` as a version name: trimmed, without control characters, at most 80 characters; `fallback` when empty. */
export function cleanVersionName(raw: unknown, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return [...text].slice(0, VERSION_LIMITS.name).join('').trim() || fallback
}

/** "Version 3": the name a version gets when the field is left empty. */
export const defaultVersionName = (named: number): string => `Version ${named + 1}`

/** The name of an automatic version (`about`: the name of the version being opened). */
export function autoVersionName(reason: AutoReason, about?: string): string {
  switch (reason) {
    case 'polish':
      return 'Before Polish in one click'
    case 'fillers':
      return 'Before removing fillers and retakes'
    case 'vertical':
      return 'Before making a vertical version'
    case 'square':
      return 'Before making a square version'
    case 'open':
      return cleanVersionName(`Before opening “${about ?? 'a version'}”`, 'Before opening a version')
  }
}

/** The counts of `p` (§2.2). */
export function versionSummary(p: Project): VersionSummary {
  const gaps = timelineGaps(p.clips, p.duration)
  return {
    duration: videoDuration(p.clips, planOf(p)),
    cuts: gaps.filter((g) => g.kind === 'cut').length,
    trimmed: gaps.some((g) => g.kind !== 'cut'),
    zooms: p.zooms.length,
    captions: p.transcript?.segments.length ?? 0,
    texts: p.annotations.length + (p.titles?.length ?? 0),
    shapes: (p.shapes?.length ?? 0) + (p.spotlights?.length ?? 0),
    images: p.overlays?.length ?? 0,
    chapters: p.chapters?.length ?? 0,
    freezes: p.freezes?.length ?? 0
  }
}

const COUNTS: readonly { key: Exclude<keyof VersionSummary, 'duration' | 'trimmed'>; one: string; many: string; label: string }[] = [
  { key: 'cuts', one: 'cut', many: 'cuts', label: 'Cuts' },
  { key: 'zooms', one: 'zoom', many: 'zooms', label: 'Zooms' },
  { key: 'captions', one: 'caption', many: 'captions', label: 'Captions' },
  { key: 'texts', one: 'text', many: 'texts', label: 'Text and titles' },
  { key: 'shapes', one: 'shape', many: 'shapes', label: 'Shapes and spotlights' },
  { key: 'images', one: 'image', many: 'images', label: 'Images' },
  { key: 'chapters', one: 'chapter', many: 'chapters', label: 'Chapters' },
  { key: 'freezes', one: 'freeze frame', many: 'freeze frames', label: 'Freeze frames' }
]

/** "2:13 · 3 cuts · 5 zooms · 42 captions": the length (whole seconds), then the counts that are not zero, five parts at most. */
export function summaryLine(s: VersionSummary): string {
  const parts = [formatTime(s.duration, false)]
  for (const c of COUNTS) {
    const n = s[c.key]
    if (n > 0) parts.push(`${n} ${n === 1 ? c.one : c.many}`)
  }
  return parts.slice(0, 5).join(' · ')
}

/** One line of a comparison: what it counts, in the version and now. */
export interface SummaryChange {
  label: string
  version: string
  now: string
}

/** The counts that differ between a version and the edit now (the length first). */
export function compareSummaries(version: VersionSummary, now: VersionSummary): SummaryChange[] {
  const out: SummaryChange[] = []
  // Compared as the list shows them: a length that rounds to the same time is the same.
  if (formatTime(version.duration) !== formatTime(now.duration)) out.push({ label: 'Length', version: formatTime(version.duration), now: formatTime(now.duration) })
  for (const c of COUNTS) if (version[c.key] !== now[c.key]) out.push({ label: c.label, version: String(version[c.key]), now: String(now[c.key]) })
  if (version.trimmed !== now.trimmed) out.push({ label: 'Start or end trimmed', version: version.trimmed ? 'Yes' : 'No', now: now.trimmed ? 'Yes' : 'No' })
  return out
}

/** Parts of the edit the counts do not show, by the name the comparison uses. */
const AREAS: readonly { name: string; keys: readonly (keyof Project)[] }[] = [
  { name: 'style', keys: ['style', 'tilt'] },
  { name: 'cursor', keys: ['cursor', 'inputEdits'] },
  { name: 'camera', keys: ['webcam', 'layouts', 'director'] },
  { name: 'sound', keys: ['audio'] },
  { name: 'effects', keys: ['effects'] },
  { name: 'zoom settings', keys: ['zoomSettings', 'autoZoom'] },
  { name: 'captions look', keys: ['captions'] },
  { name: 'crop', keys: ['crop'] },
  { name: 'vertical framing', keys: ['reframe'] },
  { name: 'brand', keys: ['brand', 'fonts'] },
  { name: 'watermark', keys: ['watermark'] }
]

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * The other parts of the edit that differ ("style", "camera"…), and "caption text" when the captions
 * count the same but say something else; empty when only the counts (or nothing) differ.
 */
export function changedAreas(version: Project, now: Project): string[] {
  const out = AREAS.filter((a) => a.keys.some((k) => !same(version[k], now[k]))).map((a) => a.name)
  const vs = version.transcript?.segments ?? []
  const ns = now.transcript?.segments ?? []
  if (vs.length === ns.length && vs.length > 0 && !same(vs, ns)) out.push('caption text')
  return out
}

/** Fields of the recording, not of the edit: opening a version keeps them as they are now (§2.4). */
export const RECORDING_FIELDS = [
  'id',
  'createdAt',
  'name',
  'duration',
  'width',
  'height',
  'hasWebcam',
  'hasAudio',
  'webcamOffset',
  'capture',
  'audioStems',
  'source',
  'copyOf',
  'script',
  'version'
] as const satisfies readonly (keyof Project)[]

/** `version` with the recording's fields of `current` (present or absent as they are now). */
export function restoreVersion(current: Project, version: Project): Project {
  const out: Record<string, unknown> = { ...version }
  for (const k of RECORDING_FIELDS) {
    if (k in current && current[k] !== undefined) out[k] = current[k]
    else delete out[k]
  }
  return out as unknown as Project
}

/** Project files `p` names (background, cursor, logo, music, images, fonts), each with what it is. */
export function namedFiles(p: Project): { file: string; what: string }[] {
  const out: { file: string; what: string }[] = []
  const add = (file: unknown, what: string): void => {
    if (typeof file === 'string' && file && !out.some((x) => x.file === file)) out.push({ file, what })
  }
  if (p.style.background.type === 'image') add(p.style.background.path, 'background image')
  if (p.cursor.style === 'custom') add(p.cursor.customImage, 'cursor image')
  if (p.watermark?.kind === 'image') add(p.watermark.path, 'logo')
  add(p.audio.music?.path, 'music')
  for (const o of p.overlays ?? []) add(o.file, 'image')
  for (const f of p.fonts ?? []) add(f.file, 'font')
  return out
}

/** "Its music file is no longer in the project folder." for the files of `missing` (namedFiles' `what`). */
export function missingFilesNotice(missing: readonly string[]): string {
  if (missing.length === 0) return ''
  const kinds = [...new Set(missing)]
  if (kinds.length === 1 && missing.length === 1) return `Its ${kinds[0]} file is no longer in the project folder.`
  return `${missing.length} of its files (${kinds.join(', ')}) are no longer in the project folder.`
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const count = (v: unknown): number => (finite(v) && v >= 0 ? Math.floor(v) : 0)

/** A summary read back from a file: every count a whole number, anything else zero. */
export function sanitizeSummary(raw: unknown): VersionSummary {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    duration: finite(s.duration) && s.duration >= 0 ? s.duration : 0,
    cuts: count(s.cuts),
    trimmed: s.trimmed === true,
    zooms: count(s.zooms),
    captions: count(s.captions),
    texts: count(s.texts),
    shapes: count(s.shapes),
    images: count(s.images),
    chapters: count(s.chapters),
    freezes: count(s.freezes)
  }
}

/** A meta read back from a file, checked; null when it is not one. */
export function sanitizeMeta(raw: unknown): VersionMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || !VERSION_ID_RE.test(m.id)) return null
  if (typeof m.createdAt !== 'string' || !Number.isFinite(Date.parse(m.createdAt))) return null
  if (typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/.test(m.hash)) return null
  const auto = m.auto === true
  const reason = typeof m.reason === 'string' && (AUTO_REASONS as readonly string[]).includes(m.reason) ? (m.reason as AutoReason) : undefined
  return {
    id: m.id,
    name: cleanVersionName(m.name, 'Version'),
    auto,
    ...(auto && reason ? { reason } : {}),
    createdAt: m.createdAt,
    bytes: count(m.bytes),
    hash: m.hash,
    summary: sanitizeSummary(m.summary)
  }
}

/**
 * Which versions go when one more `auto` version is kept: the oldest automatic ones until the limit
 * is kept, never one of `keep` (the version just kept, the one being opened).
 */
export function prunedAutos(list: readonly VersionMeta[], keep: ReadonlySet<string> = new Set()): string[] {
  const autos = list.filter((v) => v.auto)
  const excess = autos.length - VERSION_LIMITS.auto
  if (excess <= 0) return []
  const oldestFirst = autos.filter((v) => !keep.has(v.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return oldestFirst.slice(0, excess).map((v) => v.id)
}

/** "Today 14:02", "Yesterday 09:15", "12 Mar 14:02", "12 Mar 2025 14:02". */
export function versionTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(now) - day(d)) / 86_400_000)
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Yesterday ${time}`
  const month = d.toLocaleString('en-GB', { month: 'short' })
  return `${d.getDate()} ${month}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`} ${time}`
}
