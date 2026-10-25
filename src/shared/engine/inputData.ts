/**
 * The data side of NW-03 "smarter auto zoom" (docs/design/smarter-auto-zoom.md): how a recorded
 * click is named in the project's input edits, which clicks the edit lists, and the sanitisers
 * that read input edits (project.json) and scroll data (cursor.json) from disk. Pure.
 *
 * CONTRACT (frozen): recording (main), the engine and the editor all rely on these exact rules.
 * cursor.json is never rewritten after finalize, so a click's time, and with it its key, never
 * changes for the life of a project.
 */
import type { ClickEvent, CursorTrack, IgnoredClick, InputEdits, PathMode, PathRange, ScrollEvent, StrayReason } from '../types'

/** Names a recorded click: its time in whole milliseconds (two clicks in the same millisecond share it). */
export const clickKey = (t: number): number => Math.round(t * 1000)

export const STRAY_REASONS: readonly StrayReason[] = ['start', 'end', 'moving']
export const PATH_MODES: readonly PathMode[] = ['straight', 'recorded']

/** Shortest painted path range kept (seconds); shorter pieces are dropped. */
export const MIN_PATH_RANGE = 0.01

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Inside the recorded video: clicks elsewhere never drive zooms, effects or sounds. */
const inVideo = (c: ClickEvent): boolean => Number.isFinite(c.t) && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1

/**
 * `ranges` with `r` painted over them: the parts of existing ranges under `r` are cut away (a
 * range may be split in two), `r` is added unless its mode is null (which clears that stretch),
 * ranges of the same mode that touch are joined, and pieces shorter than MIN_PATH_RANGE are
 * dropped. `ranges` must be sorted and non-overlapping (as stored); so is the result, always a
 * new array of new objects (the input is never changed).
 */
export function paintPathRange(ranges: readonly PathRange[], r: { start: number; end: number; mode: PathMode | null }): PathRange[] {
  const start = Math.min(r.start, r.end)
  const end = Math.max(r.start, r.end)
  const pieces: PathRange[] = []
  for (const q of ranges) {
    if (q.end <= start || q.start >= end) {
      pieces.push({ ...q })
      continue
    }
    if (q.start < start) pieces.push({ ...q, end: start })
    if (q.end > end) pieces.push({ ...q, start: end })
  }
  if (r.mode) pieces.push({ start, end, mode: r.mode })
  pieces.sort((a, b) => a.start - b.start)
  const out: PathRange[] = []
  for (const q of pieces) {
    if (q.end - q.start < MIN_PATH_RANGE) continue
    const last = out[out.length - 1]
    if (last && last.mode === q.mode && q.start - last.end <= 1e-9) last.end = Math.max(last.end, q.end)
    else out.push(q)
  }
  return out
}

/**
 * The input edits of a stored project, cleaned: ignored clicks with a whole, non-negative `ms`
 * up to a second past the end (an unknown `stray` reason is dropped; for a duplicate `ms` the
 * user's own entry wins over detection's), sorted; `straighten` kept only when true; path ranges
 * with a known mode, clamped into [0, duration] and painted in the stored order (a later range
 * wins where they overlap). Empty parts are left out, and undefined comes back when nothing is
 * left, so a project without edits never gains an `inputEdits` key. Idempotent.
 */
export function readInputEdits(raw: unknown, duration: number): InputEdits | undefined {
  if (!isObject(raw)) return undefined
  const end = Number.isFinite(duration) && duration > 0 ? duration : 0
  const out: InputEdits = {}
  if (Array.isArray(raw.ignoredClicks)) {
    const maxMs = clickKey(end + 1)
    const byMs = new Map<number, IgnoredClick>()
    for (const v of raw.ignoredClicks) {
      if (!isObject(v) || !finite(v.ms)) continue
      const ms = Math.round(v.ms)
      if (ms < 0 || ms > maxMs) continue
      const entry: IgnoredClick = STRAY_REASONS.includes(v.stray as StrayReason) ? { ms, stray: v.stray as StrayReason } : { ms }
      const had = byMs.get(ms)
      if (!had || (had.stray && !entry.stray)) byMs.set(ms, entry)
    }
    const list = [...byMs.values()].sort((a, b) => a.ms - b.ms)
    if (list.length) out.ignoredClicks = list
  }
  if (raw.straighten === true) out.straighten = true
  if (Array.isArray(raw.paths)) {
    let paths: PathRange[] = []
    for (const v of raw.paths) {
      if (!isObject(v) || !finite(v.start) || !finite(v.end) || !PATH_MODES.includes(v.mode as PathMode)) continue
      const start = clamp(Math.min(v.start, v.end), 0, end)
      const stop = clamp(Math.max(v.start, v.end), 0, end)
      if (stop - start < MIN_PATH_RANGE) continue
      paths = paintPathRange(paths, { start, end: stop, mode: v.mode as PathMode })
    }
    if (paths.length) out.paths = paths
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The scroll events of a stored cursor track: entries with a finite time and position, a
 * non-finite dx/dy read as 0, sorted by time. Undefined (no `scrolls` key) when the stored value
 * is not a list: the track was recorded before scrolling was captured.
 */
export function readScrolls(raw: unknown): ScrollEvent[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((v): v is Record<string, number> => isObject(v) && finite(v.t) && finite(v.x) && finite(v.y))
    .map((v) => ({ t: v.t, x: v.x, y: v.y, dx: finite(v.dx) ? v.dx : 0, dy: finite(v.dy) ? v.dy : 0 }))
    .sort((a, b) => a.t - b.t)
}

/** A recorded click as the editor lists it. */
export interface ClickRow {
  click: ClickEvent
  /** clickKey(click.t): what InputEdits.ignoredClicks and the click selection refer to. */
  ms: number
  /** Its entry in InputEdits.ignoredClicks, or null while the click is used. */
  ignored: IgnoredClick | null
}

const NO_IGNORED: IgnoredClick[] = []
const rowCache = new WeakMap<ClickEvent[], WeakMap<IgnoredClick[], ClickRow[]>>()

/**
 * Every recorded click inside the video (every button: they all show effects and play sounds),
 * sorted by time, each with its ignore state. Empty without valid cursor data. Cached per
 * (track.clicks, edits.ignoredClicks) arrays, so the same inputs give the same array.
 */
export function clickRows(track: CursorTrack, edits: InputEdits | undefined): ClickRow[] {
  if (!track.valid) return []
  const ignoredList = edits?.ignoredClicks ?? NO_IGNORED
  let byIgnored = rowCache.get(track.clicks)
  if (!byIgnored) {
    byIgnored = new WeakMap()
    rowCache.set(track.clicks, byIgnored)
  }
  let rows = byIgnored.get(ignoredList)
  if (!rows) {
    const byMs = new Map(ignoredList.map((e) => [e.ms, e]))
    rows = track.clicks
      .filter(inVideo)
      .map((click) => {
        const ms = clickKey(click.t)
        return { click, ms, ignored: byMs.get(ms) ?? null }
      })
      .sort((a, b) => a.click.t - b.click.t)
    byIgnored.set(ignoredList, rows)
  }
  return rows
}

/** The keys of the ignored clicks (empty without edits). */
export function ignoredKeys(edits: InputEdits | undefined): ReadonlySet<number> {
  return new Set((edits?.ignoredClicks ?? NO_IGNORED).map((e) => e.ms))
}
