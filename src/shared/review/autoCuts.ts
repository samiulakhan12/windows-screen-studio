/**
 * The record of cuts and speed-ups Flown made by itself (Review mode, E-02,
 * docs/design/review-mode.md §2.1, §3, §4.1). A cut is a gap between clips, so it cannot carry a
 * flag; instead each automatic edit leaves a record of the source range it acted on and the kept
 * pieces that were there before, with their speeds. Remove puts exactly those back. Records are
 * written in the same store.update as the edit (one undo step), and a record whose change is no
 * longer in the clips (edited by hand since) is stale: never listed, dropped on the next write.
 * Pure.
 */
import type { AutoCut, AutoCutSource, Clip, Project } from '../types'
import { restoreRange, setRangeSpeed } from '../editor/clips'
import { finite, MAX_AUTO_CUTS, MAX_WAS_PIECES, wordsText } from './autoCutData'

/** How far (seconds) clips may differ from a record and still count as its change being there. */
const SLACK = 1e-3
const EPS = 1e-6

interface Piece {
  start: number
  end: number
  speed: number
}

/** A range an automatic edit acted on; `by` and `words` override the call's for its record. */
export interface AutoRange {
  start: number
  end: number
  by?: AutoCutSource
  words?: string
}

let counter = 0
const newCutId = (): string => `a${Date.now().toString(36)}${(counter++).toString(36)}`

/** Length of [a, b] covered by the clips that pass `which`. */
function covered(clips: readonly Clip[], a: number, b: number, which: (c: Clip) => boolean = () => true): number {
  let sum = 0
  for (const c of clips) if (which(c)) sum += Math.max(0, Math.min(b, c.end) - Math.max(a, c.start))
  return sum
}

/**
 * Whether a record's change is still in the clips: for a cut no clip plays any of its pieces; for a
 * speed-up every piece plays at the record's speed (within 1 ms).
 */
export function autoCutIntact(cut: AutoCut, clips: readonly Clip[]): boolean {
  if (cut.action === 'cut') return cut.was.every((p) => covered(clips, p.start, p.end) <= SLACK)
  return cut.was.every((p) => covered(clips, p.start, p.end, (c) => c.speed === cut.action) >= p.end - p.start - SLACK)
}

/** Whether the footage a record changed is back as it was: every piece kept at its old speed (within 1 ms). */
export function footageBack(cut: AutoCut, clips: readonly Clip[]): boolean {
  return cut.was.every((p) => covered(clips, p.start, p.end, (c) => c.speed === p.speed) >= p.end - p.start - SLACK)
}

/** The records whose change is still in the project's clips (what Review lists), in stored order. */
export function liveAutoCuts(project: Pick<Project, 'autoCuts' | 'clips'>): AutoCut[] {
  return (project.autoCuts ?? []).filter((c) => autoCutIntact(c, project.clips))
}

/** Kept time of `before` that `after` no longer keeps, with its old speed. */
function cutPieces(before: readonly Clip[], after: readonly Clip[]): Piece[] {
  const out: Piece[] = []
  for (const c of before) {
    let at = c.start
    for (const k of [...after].sort((x, y) => x.start - y.start)) {
      if (k.end <= at || k.start >= c.end) continue
      if (k.start - at > EPS) out.push({ start: at, end: k.start, speed: c.speed })
      at = Math.max(at, k.end)
    }
    if (c.end - at > EPS) out.push({ start: at, end: c.end, speed: c.speed })
  }
  return out
}

/** Kept time of `before` that plays at `speed` in `after` but did not before, with its old speed. */
function speedPieces(before: readonly Clip[], after: readonly Clip[], speed: number): Piece[] {
  const out: Piece[] = []
  for (const c of before) {
    if (c.speed === speed) continue
    for (const k of after) {
      if (k.speed !== speed) continue
      const a = Math.max(c.start, k.start)
      const b = Math.min(c.end, k.end)
      if (b - a > EPS) out.push({ start: a, end: b, speed: c.speed })
    }
  }
  return joinPieces(out)
}

/** Touching pieces at the same speed joined; sorted. */
function joinPieces(pieces: Piece[]): Piece[] {
  const out: Piece[] = []
  for (const p of [...pieces].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.end - p.start) <= EPS && last.speed === p.speed) last.end = Math.max(last.end, p.end)
    else out.push({ ...p })
  }
  return out
}

/**
 * The project with `nextClips` and a record of what that automatic edit changed (§4.1): the kept
 * time it cut (or sped up to `action`), split among the ranges it was asked to act on, each piece
 * going to the first range it touches (so a sliver cutRange took next to a range belongs to that
 * range's record). A range that changed nothing (a refused cut, a part already that fast) gets no
 * record. Stale records are dropped. `project` itself when the clips are the same object.
 */
export function recordAutoCuts(
  project: Project,
  nextClips: Clip[],
  ranges: readonly AutoRange[],
  action: AutoCut['action'],
  by: AutoCutSource,
  newId: () => string = newCutId
): Project {
  if (nextClips === project.clips) return project
  let changed = action === 'cut' ? cutPieces(project.clips, nextClips) : speedPieces(project.clips, nextClips, action)
  const sorted = ranges.filter((r) => finite(r.start) && finite(r.end) && r.end > r.start).sort((a, b) => a.start - b.start)
  const fresh: AutoCut[] = []
  for (const r of sorted) {
    const mine = changed.filter((p) => p.start <= r.end + EPS && p.end >= r.start - EPS)
    if (mine.length === 0) continue
    changed = changed.filter((p) => !mine.includes(p))
    const was = joinPieces(mine).slice(0, MAX_WAS_PIECES)
    const words = wordsText(r.words)
    fresh.push({
      id: newId(),
      by: r.by ?? by,
      action,
      start: Math.min(r.start, was[0].start),
      end: Math.max(r.end, was[was.length - 1].end),
      was,
      ...(words ? { words } : {})
    })
  }
  const live = (project.autoCuts ?? []).filter((c) => autoCutIntact(c, nextClips))
  const all = [...live, ...fresh]
  const autoCuts = all.length > MAX_AUTO_CUTS ? all.slice(all.length - MAX_AUTO_CUTS) : all
  return withAutoCuts({ ...project, clips: nextClips }, autoCuts)
}

/** `project` with `list` as its records: no key when the list is empty. */
export function withAutoCuts(project: Project, list: AutoCut[]): Project {
  if (list.length) return { ...project, autoCuts: list }
  if (!('autoCuts' in project)) return project
  const { autoCuts: _gone, ...rest } = project
  void _gone
  return rest
}

/**
 * The clips with a record's change taken back (§2.4): a cut's pieces restored (restoreRange) and
 * set back to their speeds; a speed-up's pieces set back to their speeds where they still play at
 * the record's speed (parts re-timed by hand since are left alone). Pieces from the latest back.
 */
export function undoAutoCut(clips: Clip[], cut: AutoCut, duration: number): Clip[] {
  let out = clips
  for (const p of [...cut.was].sort((a, b) => b.start - a.start)) {
    if (cut.action === 'cut') {
      out = restoreRange(out, p.start, p.end, duration)
      out = setRangeSpeed(out, p.start, p.end, p.speed)
      continue
    }
    const fast = out
      .filter((c) => c.speed === cut.action && Math.min(p.end, c.end) - Math.max(p.start, c.start) > EPS)
      .map((c) => ({ start: Math.max(p.start, c.start), end: Math.min(p.end, c.end) }))
    for (const r of fast) out = setRangeSpeed(out, r.start, r.end, p.speed)
  }
  return out
}
