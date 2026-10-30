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
import { setRangeSpeed } from '../editor/clips'
import { newClipId, normalizeClips } from '../engine/timeline'
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
 * speed-up every part of its pieces still kept plays at the record's speed, and some is kept (within 1 ms).
 */
export function autoCutIntact(cut: AutoCut, clips: readonly Clip[]): boolean {
  if (cut.action === 'cut') return cut.was.every((p) => covered(clips, p.start, p.end) <= SLACK)
  // A speed-up stays while every part of it still kept plays at its speed (a part cut since is fine).
  let kept = 0
  for (const p of cut.was) {
    const k = covered(clips, p.start, p.end)
    if (covered(clips, p.start, p.end, (c) => c.speed === cut.action) < k - SLACK) return false
    kept += k
  }
  return kept > SLACK
}

/** Whether the footage a record changed is back as it was: every piece kept at its old speed (within 1 ms). */
export function footageBack(cut: AutoCut, clips: readonly Clip[]): boolean {
  // A speed-up: the parts still kept (a part cut since cannot come back by undoing the speed).
  if (cut.action !== 'cut') return cut.was.every((p) => covered(clips, p.start, p.end, (c) => c.speed === p.speed) >= covered(clips, p.start, p.end) - SLACK)
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
 * `pieces` split at the ranges' ends and handed out (one list per range): a part inside a range goes
 * to the first range holding it, a part outside every range (a sliver cutRange took next to one)
 * to the nearest range. So two touching ranges (two fillers whose cuts meet) keep a record each.
 */
function assign(pieces: readonly Piece[], ranges: readonly AutoRange[]): Piece[][] {
  const out: Piece[][] = ranges.map(() => [])
  const bounds = ranges.flatMap((r) => [r.start, r.end])
  for (const p of pieces) {
    const cuts = [p.start, ...bounds.filter((t) => t > p.start + EPS && t < p.end - EPS).sort((x, y) => x - y), p.end]
    for (let i = 0; i + 1 < cuts.length; i++) {
      const sub = { start: cuts[i], end: cuts[i + 1], speed: p.speed }
      const mid = (sub.start + sub.end) / 2
      let at = ranges.findIndex((r) => mid >= r.start - EPS && mid <= r.end + EPS)
      if (at < 0) {
        const gap = (r: AutoRange): number => Math.max(r.start - sub.end, sub.start - r.end, 0)
        at = ranges.reduce((best, r, k) => (gap(r) < gap(ranges[best]) ? k : best), 0)
      }
      out[at].push(sub)
    }
  }
  return out
}

/**
 * The project with `nextClips` and a record of what that automatic edit changed (§4.1): the kept
 * time it cut (or sped up to `action`), split among the ranges it was asked to act on (assign: a
 * sliver cutRange took next to a range belongs to that range's record). A range that changed
 * nothing (a refused cut, a part already that fast) gets no record; one with more than
 * MAX_WAS_PIECES pieces gets several. Stale records are dropped. `project` itself when the clips
 * are the same object.
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
  const changed = action === 'cut' ? cutPieces(project.clips, nextClips) : speedPieces(project.clips, nextClips, action)
  const sorted = ranges.filter((r) => finite(r.start) && finite(r.end) && r.end > r.start).sort((a, b) => a.start - b.start)
  const fresh: AutoCut[] = []
  const shares = sorted.length ? assign(changed, sorted) : []
  sorted.forEach((r, k) => {
    const mine = joinPieces(shares[k])
    const words = wordsText(r.words)
    for (let i = 0; i < mine.length; i += MAX_WAS_PIECES) {
      const was = mine.slice(i, i + MAX_WAS_PIECES)
      fresh.push({
        id: newId(),
        by: r.by ?? by,
        action,
        start: i === 0 ? Math.min(r.start, was[0].start) : was[0].start,
        end: i + MAX_WAS_PIECES >= mine.length ? Math.max(r.end, was[was.length - 1].end) : was[was.length - 1].end,
        was,
        ...(words ? { words } : {})
      })
    }
  })
  const live = (project.autoCuts ?? []).filter((c) => autoCutIntact(c, nextClips))
  const all = [...live, ...fresh]
  const autoCuts = all.length > MAX_AUTO_CUTS ? all.slice(all.length - MAX_AUTO_CUTS) : all
  return withAutoCuts({ ...project, clips: nextClips }, autoCuts)
}

/**
 * The edit store's settle step for records (docs/design/review-mode.md §2.1): after any edit that
 * changes the clips, records whose change is no longer there are dropped in the same undo step, so
 * a later hand cut over the same footage cannot bring one back. `next` itself when nothing goes.
 */
export function settleAutoCuts(next: Project, prev: Project): Project {
  const list = next.autoCuts
  if (!list?.length || (next.clips === prev.clips && list === prev.autoCuts)) return next
  const live = list.filter((c) => autoCutIntact(c, next.clips))
  return live.length === list.length ? next : withAutoCuts(next, live)
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
 * The clips with a record's change taken back (§2.4). A cut: each piece put back as a clip at its
 * own speed where nothing plays it now, with no snapping (a piece shorter than MIN_CLIP joins the
 * clip it was part of), joined to touching clips at the same speed as restoreRange joins. A
 * speed-up: its pieces set back to their speeds where they still play at the record's speed
 * (parts re-timed by hand since are left alone), latest first.
 */
export function undoAutoCut(clips: Clip[], cut: AutoCut, duration: number): Clip[] {
  if (cut.action === 'cut') {
    const back: Clip[] = []
    for (const p of cut.was) {
      let at = p.start
      for (const c of [...clips].sort((x, y) => x.start - y.start)) {
        if (c.end <= at + EPS || c.start >= p.end - EPS) continue
        if (c.start - at > EPS) back.push({ id: newClipId(), start: at, end: c.start, speed: p.speed })
        at = Math.max(at, c.end)
      }
      if (p.end - at > EPS) back.push({ id: newClipId(), start: at, end: p.end, speed: p.speed })
    }
    if (back.length === 0) return clips
    const fresh = new Set(back)
    // A piece put back joins touching clips at its speed on both sides; the joined clip keeps the
    // id of the first clip that was there (restoreRange's rule).
    const out: { clip: Clip; joins: boolean; oldId: boolean }[] = []
    for (const c of [...clips, ...back].sort((x, y) => x.start - y.start)) {
      const last = out[out.length - 1]
      const isFresh = fresh.has(c)
      if (last && Math.abs(last.clip.end - c.start) <= EPS && last.clip.speed === c.speed && (last.joins || isFresh)) {
        out[out.length - 1] = { clip: { ...last.clip, id: last.oldId ? last.clip.id : c.id, end: c.end }, joins: isFresh, oldId: last.oldId || !isFresh }
      } else out.push({ clip: c, joins: isFresh, oldId: !isFresh })
    }
    return normalizeClips(out.map((o) => o.clip), duration)
  }
  let out = clips
  for (const p of [...cut.was].sort((a, b) => b.start - a.start)) {
    const fast = out
      .filter((c) => c.speed === cut.action && Math.min(p.end, c.end) - Math.max(p.start, c.start) > EPS)
      .map((c) => ({ start: Math.max(p.start, c.start), end: Math.min(p.end, c.end) }))
    for (const r of fast) out = setRangeSpeed(out, r.start, r.end, p.speed)
  }
  return out
}
