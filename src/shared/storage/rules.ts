/**
 * The storage manager's rules (F-26, docs/design/hands-off.md §2.7): when a recording was last
 * used, and what the clean-up rules the user set would move to the Recycle Bin. Pure; the scan and
 * the Recycle Bin are in src/main/storage.ts.
 */

export const DAY_MS = 24 * 3600_000

/** Choices for "Clear caches of recordings not used for". */
export const CACHE_DAY_CHOICES = [14, 30, 60, 90] as const
/** Choices for "Remove recordings not used for". */
export const REMOVE_DAY_CHOICES = [30, 60, 90, 180, 365] as const

export interface StorageRules {
  /** Clear the caches of recordings not used for this many days; null: off. */
  cacheDays: number | null
  /** Run the cache rule by itself (at most daily, after start-up). */
  autoCaches: boolean
  /** Offer to remove recordings not used for this many days; null: off. Always confirmed. */
  removeDays: number | null
}

export const DEFAULT_RULES: StorageRules = { cacheDays: 30, autoCaches: false, removeDays: null }

/** Stored or sent rules with anything unknown replaced by the default. */
export function sanitizeRules(raw: unknown): StorageRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pick = (v: unknown, choices: readonly number[], fallback: number | null): number | null =>
    v === null ? null : typeof v === 'number' && choices.includes(v) ? v : fallback
  return {
    cacheDays: 'cacheDays' in r ? pick(r.cacheDays, CACHE_DAY_CHOICES, DEFAULT_RULES.cacheDays) : DEFAULT_RULES.cacheDays,
    autoCaches: r.autoCaches === true,
    removeDays: 'removeDays' in r ? pick(r.removeDays, REMOVE_DAY_CHOICES, DEFAULT_RULES.removeDays) : DEFAULT_RULES.removeDays
  }
}

/**
 * A file of a recording that also has a name (a hard link) in another recording's folder: the media
 * Duplicate links into a copy. It takes its bytes once, and moving it away frees them only when every
 * name goes.
 */
export interface SharedFile {
  /** The file on its drive ("<dev>:<ino>"). */
  id: string
  bytes: number
  /** Names the file has in the recordings the library lists (one in the Recycle Bin holds nothing). */
  links: number
  /** Of which in this recording's folder. */
  here: number
}

/** A recording folder as the scan found it. */
export interface RecordingUsage {
  /** The folder's name (a project id). */
  id: string
  name: string
  /** ISO time it was recorded. */
  createdAt: string
  /** Epoch ms it was last edited, opened or exported. */
  lastUsed: number
  bytes: number
  /** Of which in .cache (rebuilt when needed). */
  cacheBytes: number
  /** False for an unfinished recording (no project.json, or a recording.json manifest): never cleaned. */
  finished: boolean
  /** The folder was larger than the scan counts: sizes are "at least". */
  capped: boolean
  /** Files counted in `bytes` that also have a name in another recording's folder (absent: none). */
  shared?: SharedFile[]
  /** Of `bytes`, in versions/: kept versions of the edit, never a cache (absent: none; docs/design/versions.md §2.6). */
  versionBytes?: number
}

/** The latest of the times given (ms or ISO), ignoring missing ones; 0 when none. */
export function lastUsed(times: readonly (number | string | null | undefined)[]): number {
  let best = 0
  for (const t of times) {
    const ms = typeof t === 'string' ? Date.parse(t) : t
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > best) best = ms
  }
  return best
}

export type CleanupAction = 'caches' | 'remove'

export interface CleanupItem {
  id: string
  name: string
  action: CleanupAction
  /** Bytes it frees by itself (a file shared with another recording stays). */
  bytes: number
  lastUsed: number
  createdAt: string
  /** A removed recording's shared files: freed when every recording holding them goes too (freedBytes). */
  shared?: SharedFile[]
}

/** Bytes of `files` together. */
export function sharedBytes(files: readonly SharedFile[] = []): number {
  return files.reduce((n, f) => n + f.bytes, 0)
}

/** Bytes the recordings take on the drive: a file shared between them counts once. */
export function totalBytes(recordings: readonly RecordingUsage[]): number {
  const seen = new Set<string>()
  let bytes = 0
  for (const r of recordings) {
    bytes += r.bytes
    for (const f of r.shared ?? []) {
      if (seen.has(f.id)) bytes -= f.bytes
      else seen.add(f.id)
    }
  }
  return bytes
}

/** Bytes moving `items` to the Recycle Bin frees: a shared file's only when all its names go with them. */
export function freedBytes(items: readonly CleanupItem[]): number {
  let bytes = 0
  const names = new Map<string, SharedFile>()
  for (const i of items) {
    bytes += i.bytes
    for (const f of i.shared ?? []) {
      const known = names.get(f.id)
      names.set(f.id, known ? { ...known, here: known.here + f.here } : f)
    }
  }
  for (const f of names.values()) if (f.here >= f.links) bytes += f.bytes
  return bytes
}

/**
 * What the rules would move to the Recycle Bin now: recordings not used (nor recorded) for
 * removeDays, then the caches of others not used for cacheDays. Unfinished recordings and the
 * ones open in the editor (`open`) are never in it. Largest first within each action, by the bytes
 * each frees by itself.
 */
export function cleanupPlan(recordings: readonly RecordingUsage[], rules: StorageRules, now: number, open: ReadonlySet<string> = new Set()): CleanupItem[] {
  const eligible = recordings.filter((r) => r.finished && !open.has(r.id))
  const older = (days: number | null, t: number): boolean => days !== null && t > 0 && now - t >= days * DAY_MS
  const item = (r: RecordingUsage, action: CleanupAction, bytes: number): CleanupItem => ({ id: r.id, name: r.name, action, bytes, lastUsed: r.lastUsed, createdAt: r.createdAt })
  // A removed recording frees its own files; the ones it shares with a recording that stays are kept.
  const removal = (r: RecordingUsage): CleanupItem => ({ ...item(r, 'remove', r.bytes - sharedBytes(r.shared)), ...(r.shared?.length ? { shared: r.shared } : {}) })
  const removed = eligible.filter((r) => older(rules.removeDays, r.lastUsed) && older(rules.removeDays, Date.parse(r.createdAt) || r.lastUsed))
  const gone = new Set(removed.map((r) => r.id))
  const caches = eligible.filter((r) => !gone.has(r.id) && r.cacheBytes > 0 && older(rules.cacheDays, r.lastUsed))
  const bySize = (a: CleanupItem, b: CleanupItem): number => b.bytes - a.bytes
  return [...removed.map(removal).sort(bySize), ...caches.map((r) => item(r, 'caches', r.cacheBytes)).sort(bySize)]
}

/** "1.2 GB", "340 MB", "12 KB" */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes <= 0) return '0 KB'
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

/** "today", "yesterday", "12 days ago" */
export function usedAgo(t: number, now: number): string {
  if (t <= 0) return 'never'
  const days = Math.floor((now - t) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}
