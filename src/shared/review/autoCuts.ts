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
import { MIN_CLIP, newClipId, normalizeClips } from '../engine/timeline'
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

/** The parts of [a, b] the clips play at `speed`. */
function playing(clips: readonly Clip[], a: number, b: number, speed: number): Piece[] {
  const out: Piece[] = []
  for (const c of clips) {
    const lo = Math.max(a, c.start)
    const hi = Math.min(b, c.end)
    if (c.speed === speed && hi > lo) out.push({ start: lo, end: hi, speed })
  }
  return out
}

/** `pieces` sorted, with those that touch or overlap joined (each keeps the speed of its first). */
function union(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = []
  for (const p of [...pieces].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && p.start <= last.end + EPS) last.end = Math.max(last.end, p.end)
    else out.push({ start: p.start, end: p.end, speed: p.speed })
  }
  return out
}

/** The time two sorted lists of pieces that do not overlap (union) both cover, at `speed`. */
function both(a: readonly Piece[], b: readonly Piece[], speed: number): Piece[] {
  const out: Piece[] = []
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    const lo = Math.max(a[i].start, b[j].start)
    const hi = Math.min(a[i].end, b[j].end)
    if (hi - lo > EPS) out.push({ start: lo, end: hi, speed })
    if (a[i].end < b[j].end) i++
    else j++
  }
  return out
}

/** Footage held (holds): its parts, sorted and not overlapping, and their lengths summed up to each. */
interface Held {
  parts: Piece[]
  sums: number[]
}

/** What holds worked out, by list, clips and speed; neither is ever changed in place. */
const heldMemo = new WeakMap<readonly AutoCut[], WeakMap<readonly Clip[], Map<number, Held>>>()

/**
 * The footage that a speed-up of `list` holds at `speed` (it played at `speed` before that one) and
 * plays at its own speed, or hands on to a later one in the same way: a later change on top, such
 * as a silence sped up 4× inside an idle part sped up 2×, and 8× inside that. Only a faster one
 * counts (a tool only speeds up), so a record at `speed` never holds footage for itself. Worked out
 * one speed at a time, the slowest first, each as one set of parts, so the cost grows with the
 * pieces of `list`, not with the ways a part is handed on; and once for a list and clips.
 */
function holds(list: readonly AutoCut[], clips: readonly Clip[], speed: number): Held {
  let byClips = heldMemo.get(list)
  if (!byClips) heldMemo.set(list, (byClips = new WeakMap()))
  let known = byClips.get(clips)
  if (!known) byClips.set(clips, (known = new Map()))
  const done = known.get(speed)
  if (done) return done
  // The pieces each speed-up plays faster than they were, by the speed they were at and its own.
  const from = new Map<number, Map<number, Piece[]>>()
  for (const r of list) {
    if (r.action === 'cut') continue
    for (const w of r.was) {
      if (!(r.action > w.speed) || w.speed < speed) continue
      let to = from.get(w.speed)
      if (!to) from.set(w.speed, (to = new Map()))
      const ws = to.get(r.action)
      if (ws) ws.push(w)
      else to.set(r.action, [w])
    }
  }
  const at = new Map<number, Piece[]>([[speed, [{ start: -Infinity, end: Infinity, speed }]]])
  const out: Piece[] = []
  while (at.size > 0) {
    const s = Math.min(...at.keys())
    const parts = union(at.get(s)!)
    at.delete(s)
    if (s !== speed) for (const p of both(parts, union(playing(clips, -Infinity, Infinity, s)), s)) out.push(p)
    for (const [t, ws] of from.get(s) ?? []) {
      const next = at.get(t) ?? []
      for (const p of both(parts, union(ws), t)) next.push(p)
      if (next.length) at.set(t, next)
    }
  }
  const parts = union(out)
  const sums = [0]
  for (const p of parts) sums.push(sums[sums.length - 1] + p.end - p.start)
  const held: Held = { parts, sums }
  known.set(speed, held)
  return held
}

/** Index of the first of `parts` (sorted, not overlapping) that ends after `t`. */
function firstAfter(parts: readonly Piece[], t: number): number {
  let lo = 0
  let hi = parts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (parts[mid].end > t) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Length of [a, b] that `held` covers. */
function heldLength({ parts, sums }: Held, a: number, b: number): number {
  const i = firstAfter(parts, a)
  let j = firstAfter(parts, b)
  if (j < parts.length && parts[j].start < b) j++
  if (j <= i) return 0
  return sums[j] - sums[i] - Math.max(0, a - parts[i].start) - Math.max(0, parts[j - 1].end - b)
}

/**
 * Whether a record's change is still in the clips: for a cut no clip plays any of its pieces; for a
 * speed-up every part of its pieces still kept plays at the record's speed, or is held at it by a
 * later speed-up of `list`, and some plays at its speed (within 1 ms).
 */
export function autoCutIntact(cut: AutoCut, clips: readonly Clip[], list: readonly AutoCut[] = []): boolean {
  if (cut.action === 'cut') return cut.was.every((p) => covered(clips, p.start, p.end) <= SLACK)
  // A speed-up stays while every part of it still kept plays at its speed (a part cut since is fine,
  // and so is a part re-timed by a later automatic change that remembers it at this speed).
  let own = 0
  for (const p of cut.was) {
    const k = covered(clips, p.start, p.end)
    const fast = covered(clips, p.start, p.end, (c) => c.speed === cut.action)
    if (fast < k - SLACK && fast + heldLength(holds(list, clips, cut.action), p.start, p.end) < k - SLACK) return false
    own += fast
  }
  return own > SLACK
}

/**
 * Whether a record's change is gone from the clips (within 1 ms): all of a cut's footage plays
 * again, at any speed; none of a speed-up's footage plays at the record's speed (it plays at
 * another speed, or is cut). Review's reading of a record that went with no choice made in the
 * panel (§2.3).
 */
export function changeGone(cut: AutoCut, clips: readonly Clip[]): boolean {
  if (cut.action === 'cut') return cut.was.every((p) => covered(clips, p.start, p.end) >= p.end - p.start - SLACK)
  return cut.was.reduce((n, p) => n + covered(clips, p.start, p.end, (c) => c.speed === cut.action), 0) <= SLACK
}

/** The records of `list` whose change is still in `clips`, each judged among the others still there. */
function intactOf(list: readonly AutoCut[], clips: readonly Clip[]): AutoCut[] {
  let live = [...list]
  for (;;) {
    const next = live.filter((c) => autoCutIntact(c, clips, live))
    if (next.length === live.length) return next
    live = next
  }
}

/**
 * The records of `list` whose change is still in `clips` (intactOf), each speed-up that goes leaving
 * the others as Keep or Remove of it would, by how its row then reads (changeGone, §2.3). First
 * those whose change is gone (none of it plays at its speed), as Remove: a record holding footage
 * at its speed takes the speed from before it (withoutSpeedUps, the fastest first). Then those that
 * still play at their speed somewhere, as Keep: an earlier speed-up one holds footage of gives that
 * part up (withSpeedUpsKept), while a record inside it keeps holding its speed. So removing a record
 * left never puts footage back at the speed of one gone, inside a speed-up still listed. The rest
 * are judged again until none goes.
 */
function settledOf(list: readonly AutoCut[], clips: readonly Clip[]): AutoCut[] {
  let live = [...list]
  for (;;) {
    const next = intactOf(live, clips)
    if (next.length === live.length) return next
    const stays = new Set(next)
    const gone = live.filter((c) => c.action !== 'cut' && !stays.has(c))
    const kept = new Set(gone.filter((c) => !changeGone(c, clips)).map((c) => c.id))
    // Those that go as kept stay in the list through the first step, so a speed-up removed around
    // one hands it the speed from before it too, as it would in the panel.
    let out = live.filter((c) => stays.has(c) || kept.has(c.id))
    out = withoutSpeedUps(out, gone.filter((c) => !kept.has(c.id)))
    out = withSpeedUpsKept(out, out.filter((c) => kept.has(c.id)))
    live = out.filter((c) => !kept.has(c.id))
  }
}

/** The records whose change is still in the project's clips (what Review lists), in stored order. */
export function liveAutoCuts(project: Pick<Project, 'autoCuts' | 'clips'>): AutoCut[] {
  return intactOf(project.autoCuts ?? [], project.clips)
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
 * `pieces` as they were before the speed-up `s`: a part inside one of its pieces that plays at its
 * speed gets that piece's speed from before. `pieces` itself when no part does.
 */
function beforeSpeedUp(pieces: Piece[], s: AutoCut): Piece[] {
  if (s.action === 'cut' || !pieces.some((p) => p.speed === s.action)) return pieces
  const bounds = s.was.flatMap((w) => [w.start, w.end]).sort((x, y) => x - y)
  let hit = false
  const out: Piece[] = []
  for (const p of pieces) {
    if (p.speed !== s.action) {
      out.push(p)
      continue
    }
    const cuts = [p.start, ...bounds.filter((t) => t > p.start + EPS && t < p.end - EPS), p.end]
    for (let i = 0; i + 1 < cuts.length; i++) {
      const mid = (cuts[i] + cuts[i + 1]) / 2
      const w = s.was.find((x) => mid >= x.start && mid <= x.end)
      if (w && w.speed !== p.speed) hit = true
      out.push({ start: cuts[i], end: cuts[i + 1], speed: w ? w.speed : p.speed })
    }
  }
  return hit ? joinPieces(out) : pieces
}

/**
 * The records `list` with the speed-up `s` gone from under them (taken back, or taken over by a
 * later automatic change): a piece one of them holds at `s`'s speed inside `s` now holds the speed
 * from before `s`, so its Remove puts the footage back as it was before both. Records that change
 * nothing are the same objects.
 */
export function withoutSpeedUp(list: AutoCut[], s: AutoCut): AutoCut[] {
  return list.map((c) => {
    if (c.id === s.id) return c
    const was = beforeSpeedUp(c.was, s)
    return was === c.was ? c : { ...c, was }
  })
}

/**
 * The records `list` with the speed-ups `ss` gone from under them (settledOf), as withoutSpeedUp
 * for each: the fastest first, so a part an 8× hands back at 4× inside a 4× gone too goes on back
 * to the 4×'s speed from before (a speed-up inside another is faster than it), and among those at
 * one speed the latest first. What those at one speed held before them is joined into one set of
 * parts (speedsBefore) and each record is gone through once for each speed, so the cost grows with
 * the pieces, not with the speed-ups gone times the records left. `ss` themselves and records that
 * change nothing are the same objects.
 */
function withoutSpeedUps(list: AutoCut[], ss: readonly AutoCut[]): AutoCut[] {
  const skip = new Set(ss.map((s) => s.id))
  const speeds = [...new Set(ss.flatMap((s) => (s.action === 'cut' ? [] : [s.action])))].sort((a, b) => b - a)
  let out = list
  for (const speed of speeds) {
    if (!out.some((c) => !skip.has(c.id) && c.was.some((p) => p.speed === speed))) continue
    const parts = speedsBefore(ss.filter((s) => s.action === speed).reverse(), speed)
    if (parts.length === 0) continue
    out = out.map((c) => {
      if (skip.has(c.id)) return c
      const was = withSpeedsBefore(c.was, parts, speed)
      return was === c.was ? c : { ...c, was }
    })
  }
  return out
}

/**
 * Where the speed-ups `ss` (all at `speed`, the first to decide first) set footage to `speed`, with
 * the speed it had before: as beforeSpeedUp for each in turn, a time held by none of them, or held
 * at `speed` itself by the first of a record's pieces holding it, is left to the next one. Sorted,
 * not overlapping.
 */
function speedsBefore(ss: readonly AutoCut[], speed: number): Piece[] {
  return firstHeld(ss.flatMap((s) => firstHeld(s.was).filter((p) => p.speed !== speed)))
}

/**
 * The time `pieces` cover, each part with the speed of the first piece (in their order) holding it:
 * sorted, not overlapping, touching parts at one speed joined.
 */
function firstHeld(pieces: readonly Piece[]): Piece[] {
  const sorted = pieces.every((p, i) => i === 0 || p.start >= pieces[i - 1].end)
  if (sorted) return joinPieces(pieces.map((p) => ({ start: p.start, end: p.end, speed: p.speed })))
  const ts = [...new Set(pieces.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b)
  const at = new Map(ts.map((t, i) => [t, i]))
  const speedOf: (number | undefined)[] = new Array(Math.max(0, ts.length - 1))
  // The next span between two ends not held yet, at or after each (a span once held is skipped).
  const free = Int32Array.from({ length: ts.length }, (_, i) => i)
  const nextFree = (i: number): number => {
    while (free[i] !== i) i = free[i] = free[free[i]]
    return i
  }
  for (const p of pieces) {
    const end = at.get(p.end)!
    for (let i = nextFree(at.get(p.start)!); i < end; i = nextFree(i + 1)) {
      speedOf[i] = p.speed
      free[i] = i + 1
    }
  }
  const out: Piece[] = []
  speedOf.forEach((speed, i) => {
    if (speed !== undefined) out.push({ start: ts[i], end: ts[i + 1], speed })
  })
  return joinPieces(out)
}

/**
 * `pieces` as they were before the speed-ups whose parts are `parts` (speedsBefore): a part that
 * plays at `speed` inside one of them gets its speed from before, as beforeSpeedUp does. `pieces`
 * itself when no part does.
 */
function withSpeedsBefore(pieces: Piece[], parts: readonly Piece[], speed: number): Piece[] {
  if (!pieces.some((p) => p.speed === speed)) return pieces
  let hit = false
  const out: Piece[] = []
  for (const p of pieces) {
    const first = p.speed === speed ? firstAfter(parts, p.start) : parts.length
    if (first >= parts.length || parts[first].start >= p.end) {
      out.push(p)
      continue
    }
    const cuts = [p.start]
    for (let k = first; k < parts.length && parts[k].start < p.end - EPS; k++) {
      for (const t of [parts[k].start, parts[k].end]) if (t > p.start + EPS && t < p.end - EPS && t !== cuts[cuts.length - 1]) cuts.push(t)
    }
    cuts.push(p.end)
    for (let i = 0; i + 1 < cuts.length; i++) {
      const mid = (cuts[i] + cuts[i + 1]) / 2
      const k = firstAfter(parts, mid)
      const w = k < parts.length && parts[k].start <= mid ? parts[k] : undefined
      if (w && w.speed !== p.speed) hit = true
      out.push({ start: cuts[i], end: cuts[i + 1], speed: w ? w.speed : p.speed })
    }
  }
  return hit ? joinPieces(out) : pieces
}

/**
 * The project with `nextClips` and a record of what that automatic edit changed (§4.1): the kept
 * time it cut (or sped up to `action`), split among the ranges it was asked to act on (assign: a
 * sliver cutRange took next to a range belongs to that range's record). A range that changed
 * nothing (a refused cut, a part already that fast) gets no record; one with more than
 * MAX_WAS_PIECES pieces gets several. An earlier automatic speed-up this edit cuts or re-times
 * stays whole while some of it still plays at its speed: the new record holds the part it takes at
 * that speed, as a cut inside it does. When none does, it is dropped and the new record holds that
 * part at its speed from before the speed-up. Stale records are dropped. `project` itself when the
 * clips are the same object.
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
  let live = project.autoCuts ?? []
  const over = live.filter((c) => c.action !== 'cut' && autoCutIntact(c, project.clips, live) && !autoCutIntact(c, nextClips, live))
  let changed = action === 'cut' ? cutPieces(project.clips, nextClips) : speedPieces(project.clips, nextClips, action)
  // The latest first: a speed-up inside an earlier one holds its footage at that one's speed.
  for (const s of [...over].reverse()) {
    if (autoCutIntact({ ...s, was: without(s.was, changed) }, nextClips, live)) continue
    changed = beforeSpeedUp(changed, s)
    live = withoutSpeedUp(live, s)
  }
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
  const all = intactOf([...live, ...fresh], nextClips)
  const autoCuts = all.length > MAX_AUTO_CUTS ? all.slice(all.length - MAX_AUTO_CUTS) : all
  return withAutoCuts({ ...project, clips: nextClips }, autoCuts)
}

/** `pieces` without the time of `gone`, each split where `gone` covers it (in their order). */
function without(pieces: readonly Piece[], gone: readonly Piece[]): Piece[] {
  return outside(pieces, union(gone))
}

/** `pieces` without the time of `g` (sorted, not overlapping: union), each split where `g` covers it. */
function outside(pieces: readonly Piece[], g: readonly Piece[]): Piece[] {
  const out: Piece[] = []
  for (const p of pieces) {
    let at = p.start
    for (let i = firstAfter(g, p.start + EPS); i < g.length && g[i].start < p.end - EPS; i++) {
      if (g[i].start - at > EPS) out.push({ ...p, start: at, end: g[i].start })
      at = Math.max(at, g[i].end)
    }
    if (p.end - at > EPS) out.push({ ...p, start: at, end: p.end })
  }
  return out
}

/** Whether one of `pieces` lies in the same gap between `clips` as a part of a cut record. */
function sameGap(cut: AutoCut, pieces: readonly Piece[], clips: readonly Clip[]): boolean {
  return cut.was.some((w) => {
    let lo = -Infinity
    let hi = Infinity
    for (const c of clips) {
      if (c.end <= w.start + SLACK) lo = Math.max(lo, c.end)
      else if (c.start >= w.end - SLACK) hi = Math.min(hi, c.start)
    }
    return pieces.some((p) => p.start >= lo - EPS && p.end <= hi + EPS)
  })
}

/**
 * The edit store's settle step for records (docs/design/review-mode.md §2.1): after any edit that
 * changes the clips, records whose change is no longer there are dropped in the same undo step, so
 * a later hand cut over the same footage cannot bring one back. So is a cut the edit made longer by
 * hand (a trim, a cut or a deleted clip reaching its gap): it is the user's cut now, and Remove must
 * not bring back footage inside it. The time a tool's own new records claim is not by hand. A
 * speed-up that goes leaves the records around it as its row then reads (settledOf). `next` itself
 * when nothing goes.
 */
export function settleAutoCuts(next: Project, prev: Project): Project {
  const list = next.autoCuts
  if (!list?.length || (next.clips === prev.clips && list === prev.autoCuts)) return next
  const old = new Set((prev.autoCuts ?? []).map((c) => c.id))
  const byHand = next.clips === prev.clips ? [] : without(cutPieces(prev.clips, next.clips), list.filter((c) => !old.has(c.id)).flatMap((c) => c.was))
  const absorbed = (c: AutoCut): boolean => c.action === 'cut' && old.has(c.id) && byHand.length > 0 && sameGap(c, byHand, next.clips)
  const live = settledOf(list.filter((c) => !absorbed(c)), next.clips)
  return live.length === list.length ? next : withAutoCuts(next, live)
}

/**
 * The records `list` with the speed-up `k` kept (§2.4): an earlier speed-up whose footage it holds
 * at that one's speed gives that part up, as if the user had re-timed it, and stays listed for the
 * rest; so does one that holds the part given up in turn (a 2× around a 4× around the 8× kept).
 * Records that change nothing are the same objects.
 */
export function withSpeedUpKept(list: AutoCut[], k: AutoCut): AutoCut[] {
  if (k.action === 'cut') return list
  let out = list
  let gone: readonly Piece[] = k.was
  // Outward one level at a time: the part a record gives up carries its speeds from before it.
  for (let n = 0; gone.length > 0 && n < list.length; n++) {
    const next: Piece[] = []
    const g = gone
    out = out.map((c) => {
      if (c.id === k.id || c.action === 'cut') return c
      const mine = g.filter((w) => w.speed === c.action && c.was.some((p) => Math.min(p.end, w.end) - Math.max(p.start, w.start) > EPS))
      if (!mine.length) return c
      const rest = without(c.was, mine)
      next.push(...without(c.was, rest))
      return { ...c, was: rest }
    })
    gone = next
  }
  return out
}

/**
 * The records `list` with the speed-ups `ks` kept (settledOf), as withSpeedUpKept for each at once:
 * an earlier speed-up of `list` whose footage one of them holds at its speed gives that part up, and
 * so does one that holds the part given up in turn. The parts are joined a speed at a time, so the
 * cost grows with the pieces, not with the records kept times the records left. `ks` themselves and
 * records that change nothing are the same objects.
 */
function withSpeedUpsKept(list: AutoCut[], ks: readonly AutoCut[]): AutoCut[] {
  const skip = new Set(ks.map((k) => k.id))
  let out = list
  let gone: Piece[] = ks.flatMap((k) => (k.action === 'cut' ? [] : k.was))
  // Outward one level at a time: the part a record gives up carries its speeds from before it.
  for (let n = 0; gone.length > 0 && n < list.length; n++) {
    const bySpeed = new Map<number, Piece[]>()
    for (const w of gone) {
      const ws = bySpeed.get(w.speed)
      if (ws) ws.push(w)
      else bySpeed.set(w.speed, [w])
    }
    const parts = new Map([...bySpeed].map(([speed, ws]) => [speed, union(ws)]))
    const next: Piece[] = []
    out = out.map((c) => {
      const g = c.action === 'cut' || skip.has(c.id) ? undefined : parts.get(c.action)
      if (!g) return c
      const rest = outside(c.was, g)
      const given = without(c.was, rest)
      if (given.length === 0) return c
      next.push(...given)
      return { ...c, was: rest }
    })
    gone = next
  }
  return out
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
  if (cut.action === 'cut') return putBack(clips, cut.was, duration)
  let out = clips
  for (const p of [...cut.was].sort((a, b) => b.start - a.start)) {
    const fast = out
      .filter((c) => c.speed === cut.action && Math.min(p.end, c.end) - Math.max(p.start, c.start) > EPS)
      .map((c) => ({ start: Math.max(p.start, c.start), end: Math.min(p.end, c.end) }))
    for (const r of fast) out = setRangeSpeed(out, r.start, r.end, p.speed)
  }
  return out
}

/**
 * The clips with `pieces` put back (a cut's Remove, §2.4): each as a clip at its own speed where
 * nothing plays it now, with no snapping, joined to touching clips at the same speed as
 * restoreRange joins. A piece shorter than MIN_CLIP that joins nothing cannot be a clip of its own
 * and stays out (normalizeClips). `clips` itself when nothing is to put back.
 */
function putBack(clips: Clip[], pieces: readonly Piece[], duration: number): Clip[] {
  const back: Clip[] = []
  for (const p of pieces) {
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

/**
 * The clips and records with the records `ids` of `list` taken back (Remove and Remove all, §2.4):
 * each as undoAutoCut, the latest in source time first, a speed-up leaving the records inside it
 * holding their footage at the speed from before it (withoutSpeedUp); the records taken back are
 * left out.
 *
 * A piece of a cut shorter than MIN_CLIP comes back only by joining a clip (alone it cannot be
 * one). Once all are back it is put back again, so it joins a neighbour at its speed that came back
 * with it. Touching pieces at different speeds, long enough together, come back as one clip at the
 * speed of the longest. One that touches no clip at its speed joins a clip it touches at another
 * speed (joinAcross: it plays again, at that speed). Neither is done when it changes a record left,
 * one holding that time. One with the footage on both sides still cut goes to a cut record left
 * that `heir` allows (one still to review) and whose footage touches it: that record holds it from
 * then on, so its Remove brings the piece back with its own footage. So Remove leaves no footage cut
 * that nothing in Review can bring back, except a piece between two cuts no row can take back (the
 * user's own, or kept), or between such a cut and a clip it cannot join without changing a record
 * left: alone it cannot be a clip, so it stays out.
 */
export function takeBack(
  clips: Clip[],
  list: readonly AutoCut[],
  ids: readonly string[],
  duration: number,
  heir: (c: AutoCut) => boolean
): { clips: Clip[]; list: AutoCut[] } {
  const gone = new Set(ids)
  let out = [...list]
  let at = clips
  const order = ids.flatMap((id) => list.filter((c) => c.id === id).slice(0, 1))
  for (const { id } of order.sort((a, b) => b.start - a.start)) {
    const c = out.find((x) => x.id === id)!
    at = undoAutoCut(at, c, duration)
    if (c.action !== 'cut') out = withoutSpeedUp(out, c)
  }
  const outOf = (pieces: readonly Piece[]): Piece[] =>
    outside(pieces, union(at.map((c) => ({ start: c.start, end: c.end, speed: c.speed })))).filter((p) => p.end - p.start > SLACK)
  let left = outOf(out.filter((c) => gone.has(c.id) && c.action === 'cut').flatMap((c) => c.was))
  if (left.length === 0) return { clips: at, list: out.filter((c) => !gone.has(c.id)) }
  at = putBack(at, left, duration)
  left = outOf(left).sort((a, b) => a.start - b.start)
  const rest = out.filter((c) => !gone.has(c.id))
  // A piece that comes back at another speed must leave every record left as it was: a speed-up
  // holding that time would no longer play it at its speed, a cut holding it would be undone.
  const leaves = (p: Piece, next: Clip[]): boolean => {
    const holding = rest.filter((c) => c.was.some((w) => Math.min(w.end, p.end) - Math.max(w.start, p.start) > EPS))
    return !holding.some((c) => autoCutIntact(c, at, rest) && !autoCutIntact(c, next, rest))
  }
  // Touching pieces at different speeds, each too short alone and long enough together (a cut
  // across a speed change), come back as one clip at the speed of the longest.
  const runs: Piece[][] = []
  for (const p of left) {
    const run = runs[runs.length - 1]
    if (run && Math.abs(run[run.length - 1].end - p.start) <= EPS) run.push(p)
    else runs.push([p])
  }
  left = runs.flatMap((run) => {
    const whole = { start: run[0].start, end: run[run.length - 1].end, speed: run.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a)).speed }
    if (run.length < 2 || whole.end - whole.start < MIN_CLIP - 1e-9) return run
    const next = putBack(at, [whole], duration)
    if (!leaves(whole, next)) return run
    at = next
    return []
  })
  for (let joined = true; joined && left.length; ) {
    joined = false
    left = left.filter((p) => {
      const next = joinAcross(at, p, duration)
      if (!next || !leaves(p, next)) return true
      at = next
      joined = true
      return false
    })
  }
  // Hand each piece still out to a cut to review whose footage touches it (or touches one handed
  // on before it), one at its speed first, so their Remove puts them back together.
  const touches = (w: Piece, p: Piece): boolean => Math.abs(w.end - p.start) <= EPS || Math.abs(p.end - w.start) <= EPS
  for (let handed = true; handed && left.length; ) {
    handed = false
    left = left.filter((p) => {
      const heirs = out.filter((c) => c.action === 'cut' && !gone.has(c.id) && c.was.some((w) => touches(w, p)) && heir(c) && autoCutIntact(c, at))
      const to = heirs.find((c) => c.was.some((w) => touches(w, p) && w.speed === p.speed)) ?? heirs[0]
      const was = to && joinPieces([...to.was, p])
      if (!to || !was || was.length > MAX_WAS_PIECES) return true
      out = out.map((c) => (c === to ? { ...c, start: Math.min(c.start, p.start), end: Math.max(c.end, p.end), was } : c))
      handed = true
      return false
    })
  }
  return { clips: at, list: out.filter((c) => !gone.has(c.id)) }
}

/**
 * The clips with `p` (a cut piece shorter than MIN_CLIP that touches no clip at its speed) joined to
 * a clip it touches at another speed: the one whose speed is nearest its own (the earlier on a tie),
 * or both into one when they play at one speed (restoreRange's join). The joined clip keeps its id.
 * null when it touches no clip.
 */
function joinAcross(clips: Clip[], p: Piece, duration: number): Clip[] | null {
  const before = clips.find((c) => Math.abs(c.end - p.start) <= EPS)
  const after = clips.find((c) => Math.abs(c.start - p.end) <= EPS)
  if (!before && !after) return null
  if (before && after && before.speed === after.speed) {
    return normalizeClips(clips.flatMap((c) => (c === after ? [] : c === before ? [{ ...c, end: after.end }] : [c])), duration)
  }
  const far = (c: Clip | undefined): number => (c ? Math.abs(Math.log(c.speed / p.speed)) : Infinity)
  const to = far(before) <= far(after) ? before! : after!
  return normalizeClips(clips.map((c) => (c !== to ? c : to === before ? { ...c, end: p.end } : { ...c, start: p.start })), duration)
}
