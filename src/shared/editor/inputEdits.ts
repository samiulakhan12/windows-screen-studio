/**
 * Editing the recorded input (NW-03, docs/design/smarter-auto-zoom.md): stray-click detection,
 * ignoring and using clicks, the straightening option and path ranges, and the facts the editor
 * shows about them. Every operation takes the project and the RECORDED track (cursor.json as
 * loaded, never the effective one) and returns a new project, or `p` itself when nothing changes
 * (the edit store then adds no undo step). Ignoring or using clicks updates the automatic zooms
 * in the same new project, so one undo step restores both. Pure.
 */
import { autoZoomsInFrame } from '../engine/crop'
import { cursorAt } from '../engine/cursor'
import { NO_PATHS, pathModeAt, planCursorPath, type MoveReason } from '../engine/cursorPath'
import { clickKey, paintPathRange, type ClickRow } from '../engine/inputData'
import { effectiveTrack } from '../engine/inputTrack'
import { SCROLL, scrollBreaks } from '../engine/scroll'
import { rebaseAutoZooms, zoomSettingsOf } from '../engine/zoom'
import type { AutoZoomSettings, ClickEvent, CursorTrack, IgnoredClick, InputEdits, PathMode, PathRange, Project, ZoomSegment } from '../types'

export const STRAY = {
  /** 'start': clicks before this (seconds), usually the click that focuses the recorded app. */
  edge: 0.6,
  /** 'moving': the cursor is measured this long (seconds) before and after the click... */
  window: 0.08,
  /** ...and must travel at least this far (video heights) on both sides... */
  travel: 0.04,
  /** ...in nearly the same direction (cosine of the angle between the two moves at least this). */
  sameDirection: Math.SQRT1_2,
  /** A press held at least this long (seconds, ClickEvent.up) is deliberate, never 'moving'. */
  held: 0.25
} as const

/**
 * Clicks that are almost certainly not part of the demo, with why. Only clicks inside the
 * video (every button) are checked; each one is reported once, with the first reason that fits:
 *  - 'start': t < STRAY.edge;
 *  - 'end': t > duration - STRAY.edge and no input after it (no click, key, mark or scroll with
 *    a later t, no typing burst ending after it);
 *  - 'moving': the cursor travels at least STRAY.travel in the STRAY.window before the click
 *    and in the STRAY.window after it (cursorAt on the samples, distances in video heights with
 *    aspect = `aspect`), the two moves within 45 degrees of each other, and the press was not
 *    held (no finite `up` with up - t >= STRAY.held).
 * Sorted by time; entries carry `stray`. [] without valid cursor data.
 * CONTRACT: recording finalize stores the result as the new project's ignored clicks.
 */
export function findStrayClicks(track: CursorTrack, duration: number, aspect: number): IgnoredClick[] {
  if (!track.valid) return []
  const A = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  const clicks = track.clicks.filter(inVideo).sort((a, b) => a.t - b.t)
  // The latest instant anything was done (clicks of every kind, keys, marks, scrolls, typing).
  let lastInput = -Infinity
  for (const c of track.clicks) if (Number.isFinite(c.t)) lastInput = Math.max(lastInput, c.t)
  for (const k of track.keys ?? []) if (Number.isFinite(k.t)) lastInput = Math.max(lastInput, k.t)
  for (const m of track.marks ?? []) if (Number.isFinite(m.t)) lastInput = Math.max(lastInput, m.t)
  for (const e of track.scrolls ?? []) if (Number.isFinite(e.t)) lastInput = Math.max(lastInput, e.t)
  for (const b of track.typing ?? []) if (Number.isFinite(b.end)) lastInput = Math.max(lastInput, b.end, b.t)
  const out: IgnoredClick[] = []
  const seen = new Set<number>()
  for (const c of clicks) {
    const ms = clickKey(c.t)
    if (seen.has(ms)) continue
    const reason = strayReason(c, track, duration, A, lastInput)
    if (!reason) continue
    seen.add(ms)
    out.push({ ms, stray: reason })
  }
  return out
}

const inVideo = (c: ClickEvent): boolean => Number.isFinite(c.t) && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1

function strayReason(c: ClickEvent, track: CursorTrack, duration: number, A: number, lastInput: number): IgnoredClick['stray'] | null {
  if (c.t < STRAY.edge) return 'start'
  if (c.t > duration - STRAY.edge && !(lastInput > c.t)) return 'end'
  const held = typeof c.up === 'number' && Number.isFinite(c.up) && c.up - c.t >= STRAY.held
  if (held) return null
  const p0 = cursorAt(track.samples, c.t - STRAY.window)
  const p1 = cursorAt(track.samples, c.t)
  const p2 = cursorAt(track.samples, c.t + STRAY.window)
  if (!p0 || !p1 || !p2) return null
  const bx = (p1.x - p0.x) * A
  const by = p1.y - p0.y
  const ax = (p2.x - p1.x) * A
  const ay = p2.y - p1.y
  const before = Math.hypot(bx, by)
  const after = Math.hypot(ax, ay)
  const travel = STRAY.travel - 1e-12
  if (before < travel || after < travel) return null
  return (bx * ax + by * ay) / (before * after) >= STRAY.sameDirection - 1e-12 ? 'moving' : null
}

/**
 * Ignores the clicks of `change.ignore` (entries as stored: the user's have no `stray`) and uses
 * the clicks whose keys are in `change.use` again. An entry for a click already ignored replaces
 * it. When auto zoom is on (zoomSettingsOf(p).auto.enabled), the automatic zooms are updated in
 * the same project with rebaseAutoZooms(p.zooms, before, after, newly ignored keys), where before
 * and after are autoZoomsInFrame(effectiveTrack(recorded, p / next), p / next, auto). Arrays
 * the change does not touch (inputEdits.paths, ...) keep their identity; an empty ignoredClicks
 * list and an empty inputEdits are removed. `p` itself when no click changes state.
 */
export function setClicksIgnored(p: Project, recorded: CursorTrack, change: { ignore?: readonly IgnoredClick[]; use?: readonly number[] }): Project {
  const current = p.inputEdits?.ignoredClicks ?? []
  const byMs = new Map(current.map((e) => [e.ms, e]))
  // Only recorded clicks can be ignored; `use` also clears entries that name no click.
  const recordedKeys = new Set(recorded.clicks.filter((c) => Number.isFinite(c.t)).map((c) => clickKey(c.t)))
  for (const e of change.ignore ?? []) {
    if (!Number.isFinite(e.ms)) continue
    const ms = Math.round(e.ms)
    if (!recordedKeys.has(ms)) continue
    byMs.set(ms, e.stray ? { ms, stray: e.stray } : { ms })
  }
  for (const ms of change.use ?? []) if (Number.isFinite(ms)) byMs.delete(Math.round(ms))
  const before = new Set(current.map((e) => e.ms))
  const changed = byMs.size !== before.size || [...byMs.keys()].some((ms) => !before.has(ms))
  if (!changed) return p
  const list = [...byMs.values()].sort((a, b) => a.ms - b.ms)
  const { ignoredClicks: _old, ...rest } = p.inputEdits ?? {}
  const inputEdits: InputEdits = list.length ? { ...rest, ignoredClicks: list } : rest
  const next = withInputEdits(p, inputEdits)
  const auto = zoomSettingsOf(p).auto
  if (!auto.enabled) return next
  const was = autoZoomsInFrame(effectiveTrack(recorded, p), p, auto)
  const now = autoZoomsInFrame(effectiveTrack(recorded, next), next, auto)
  const newly = list.filter((e) => !before.has(e.ms)).map((e) => e.ms)
  const zooms = rebaseAutoZooms(p.zooms, was, now, newly)
  return zooms === p.zooms ? next : { ...next, zooms }
}

/** `p` with `edits` as its input edits; an empty object removes the key. */
function withInputEdits(p: Project, edits: InputEdits): Project {
  const { inputEdits: _old, ...rest } = p
  if (Object.keys(edits).length === 0) return rest as Project
  return { ...p, inputEdits: edits }
}

/** Runs findStrayClicks (aspect p.width / p.height) and ignores what it finds that is still used ("Find stray clicks"). */
export function ignoreStrayClicks(p: Project, recorded: CursorTrack): { project: Project; added: IgnoredClick[] } {
  const ignored = new Set((p.inputEdits?.ignoredClicks ?? []).map((e) => e.ms))
  const added = findStrayClicks(recorded, p.duration, p.width / p.height).filter((e) => !ignored.has(e.ms))
  if (added.length === 0) return { project: p, added }
  return { project: setClicksIgnored(p, recorded, { ignore: added }), added }
}

/** Uses every ignored click again (setClicksIgnored with every key). */
export function useAllClicks(p: Project, recorded: CursorTrack): Project {
  const keys = (p.inputEdits?.ignoredClicks ?? []).map((e) => e.ms)
  return keys.length ? setClicksIgnored(p, recorded, { use: keys }) : p
}

/**
 * The click "at the playhead" (source seconds `t`): the click an automatic zoom under the
 * playhead was made for (a click anchor, anchor.until undefined, whose clickKey matches a row),
 * else the row nearest to `t` within 1 s (the later one on a tie), else null. Ignored rows count.
 */
export function clickAtPlayhead(rows: readonly ClickRow[], zooms: readonly ZoomSegment[], t: number): ClickRow | null {
  for (const z of zooms) {
    const a = z.anchor
    if (!z.auto || !a || typeof a.until === 'number' || !(t >= z.start && t <= z.end)) continue
    const ms = clickKey(a.t)
    const row = rows.find((r) => r.ms === ms)
    if (row) return row
  }
  let best: ClickRow | null = null
  let bestGap = Infinity
  for (const r of rows) {
    const gap = Math.abs(r.click.t - t)
    if (gap > 1 + 1e-9) continue
    // The later one on a tie.
    if (gap < bestGap - 1e-12 || (Math.abs(gap - bestGap) <= 1e-12 && best && r.click.t > best.click.t)) {
      best = r
      bestGap = gap
    }
  }
  return best
}

/** What an automatic zoom was made for, from its anchor; null for zooms made or edited by hand. */
export type ZoomCause =
  | { kind: 'click'; click: ClickEvent; ms: number }
  | { kind: 'typing'; t: number }
  | { kind: 'mark'; t: number }
  /** Zooming back in where a long scroll stopped (`t`: the session's last wheel event). */
  | { kind: 'scroll'; t: number }
  | null

/**
 * Why `z` exists, from its anchor: anchor.until set -> typing; clickKey(anchor.t) equal to a
 * click of `track` -> click; a mark at anchor.t (within 1e-6) -> mark; anchor.t equal (within
 * 1e-6) to the landing time of a long scroll of scrollBreaks(track, settings) (session end +
 * SCROLL.rest + settings.leadIn) -> scroll. Null otherwise, and for every zoom with auto: false.
 * `track` is the effective track, so an ignored click is never a cause.
 */
export function zoomCause(z: ZoomSegment, track: CursorTrack, settings: AutoZoomSettings): ZoomCause {
  const a = z.anchor
  if (!z.auto || !a) return null
  if (typeof a.until === 'number') return { kind: 'typing', t: a.t }
  const ms = clickKey(a.t)
  const click = track.clicks.find((c) => Number.isFinite(c.t) && clickKey(c.t) === ms)
  if (click) return { kind: 'click', click, ms }
  if ((track.marks ?? []).some((m) => Math.abs(m.t - a.t) <= 1e-6)) return { kind: 'mark', t: a.t }
  const leadIn = Math.max(0, settings.leadIn)
  const scroll = scrollBreaks(track, settings).find((s) => Math.abs(s.end + SCROLL.rest + leadIn - a.t) <= 1e-6)
  if (scroll) return { kind: 'scroll', t: scroll.end }
  return null
}

/** Turns the automatic straightening option on or off (inputEdits.straighten; off removes the key). */
export function setStraighten(p: Project, on: boolean): Project {
  if ((p.inputEdits?.straighten === true) === on) return p
  const { straighten: _old, ...rest } = p.inputEdits ?? {}
  return withInputEdits(p, on ? { ...rest, straighten: true } : rest)
}

/**
 * Paints a path range over [start, end] (paintPathRange): 'straight', 'recorded', or null to
 * clear it back to the automatic option. `p` itself when the stored ranges do not change.
 */
export function setPathRange(p: Project, range: { start: number; end: number }, mode: PathMode | null): Project {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return p
  const end = Math.max(0, p.duration)
  const lo = Math.min(Math.max(Math.min(range.start, range.end), 0), end)
  const hi = Math.min(Math.max(Math.max(range.start, range.end), 0), end)
  const current = p.inputEdits?.paths ?? []
  const paths = paintPathRange(current, { start: lo, end: hi, mode })
  if (samePaths(current, paths)) return p
  const { paths: _old, ...rest } = p.inputEdits ?? {}
  return withInputEdits(p, paths.length ? { ...rest, paths } : rest)
}

const samePaths = (a: readonly PathRange[], b: readonly PathRange[]): boolean =>
  a.length === b.length && a.every((r, i) => r.start === b[i].start && r.end === b[i].end && r.mode === b[i].mode)

/** Counts for the editor's hints and notices. */
export interface PathSummary {
  /** Moves (with their midpoint in the range, when one is given). */
  moves: number
  straightened: number
  /** Moves kept as recorded, by the reason that applied (auto or manual, as decided). */
  kept: Partial<Record<MoveReason, number>>
}

/**
 * What straightening does in the whole recording, or in `range`: the moves (planCursorPath on
 * the recorded track with the project's options), how many are straightened, and why the others
 * keep their path. All zero when the cursor is in the video or there is no cursor data.
 */
export function pathSummary(recorded: CursorTrack, p: Project, range?: { start: number; end: number }): PathSummary {
  const out: PathSummary = { moves: 0, straightened: 0, kept: {} }
  if (!recorded.valid || p.capture.cursorInVideo) return out
  const paths = p.inputEdits?.paths ?? NO_PATHS
  const plan = planCursorPath(recorded, { aspect: p.width / p.height, straighten: p.inputEdits?.straighten === true, paths })
  const done = new Set(plan.straightened)
  const lo = range ? Math.min(range.start, range.end) : -Infinity
  const hi = range ? Math.max(range.start, range.end) : Infinity
  for (const m of plan.moves) {
    const mid = (m.t0 + m.t1) / 2
    if (!(mid >= lo && mid < hi)) continue
    out.moves++
    if (done.has(m)) {
      out.straightened++
      continue
    }
    const mode = pathModeAt(paths, mid)
    // A 'recorded' range keeps the path by choice; elsewhere the reason of the mode in force.
    const reason = mode === 'recorded' ? null : mode === 'straight' ? m.manual : m.auto
    if (reason) out.kept[reason] = (out.kept[reason] ?? 0) + 1
  }
  return out
}
