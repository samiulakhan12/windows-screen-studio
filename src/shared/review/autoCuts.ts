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

const length = (pieces: readonly Piece[]): number => pieces.reduce((n, p) => n + p.end - p.start, 0)

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
  /** Its parts and the clips at its speed, joined (withoutKeptInside); worked out when first asked. */
  plays?: Piece[]
}

/** What holds worked out, by list, clips and speed (with the record left out); neither is ever changed in place. */
const heldMemo = new WeakMap<readonly AutoCut[], WeakMap<readonly Clip[], Map<string, Held>>>()

/**
 * The footage that a speed-up of `list` other than `skip` holds at `speed` (it played at `speed`
 * before that one) and plays at its own speed, or hands on to a later one in the same way: a later
 * change on top, such as a silence sped up 4× inside an idle part sped up 2×, and 8× inside that.
 * Only a faster one counts (a tool only speeds up). Worked out one speed at a time, the slowest
 * first, each as one set of parts, so the cost grows with the pieces of `list`, not with the ways
 * a part is handed on; and once for a list and clips.
 */
function holds(list: readonly AutoCut[], clips: readonly Clip[], speed: number, skip?: AutoCut): Held {
  // `skip` can only be followed when it is faster than `speed`.
  const id = skip && skip.action !== 'cut' && skip.action > speed ? skip.id : ''
  let byClips = heldMemo.get(list)
  if (!byClips) heldMemo.set(list, (byClips = new WeakMap()))
  let known = byClips.get(clips)
  if (!known) byClips.set(clips, (known = new Map()))
  const key = `${speed} ${id}`
  const done = known.get(key)
  if (done) return done
  // The pieces each speed-up plays faster than they were, by the speed they were at and its own.
  const from = new Map<number, Map<number, Piece[]>>()
  for (const r of list) {
    if (r.action === 'cut' || r.id === id) continue
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
  known.set(key, held)
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
    if (fast < k - SLACK && fast + heldLength(holds(list, clips, cut.action, cut), p.start, p.end) < k - SLACK) return false
    own += fast
  }
  return own > SLACK
}

/**
 * Whether the footage a record changed is back as it was: every piece kept at its old speed (within
 * 1 ms). For a speed-up, a part a speed-up of `list` holds at that speed counts as back (it is under
 * that one).
 */
export function footageBack(cut: AutoCut, clips: readonly Clip[], list: readonly AutoCut[] = []): boolean {
  // A speed-up: the parts still kept (a part cut since cannot come back by undoing the speed).
  if (cut.action !== 'cut') {
    return cut.was.every(
      (p) => covered(clips, p.start, p.end, (c) => c.speed === p.speed) + heldLength(holds(list, clips, p.speed, cut), p.start, p.end) >= covered(clips, p.start, p.end) - SLACK
    )
  }
  return cut.was.every((p) => covered(clips, p.start, p.end, (c) => c.speed === p.speed) >= p.end - p.start - SLACK)
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
  if (s.action === 'cut') return pieces
  let hit = false
  const out: Piece[] = []
  for (const p of pieces) {
    if (p.speed !== s.action) {
      out.push(p)
      continue
    }
    const cuts = [p.start, ...s.was.flatMap((w) => [w.start, w.end]).filter((t) => t > p.start + EPS && t < p.end - EPS).sort((x, y) => x - y), p.end]
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
  const g = union(gone)
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
 * not bring back footage inside it. The time a tool's own new records claim is not by hand. `next`
 * itself when nothing goes.
 */
export function settleAutoCuts(next: Project, prev: Project): Project {
  const list = next.autoCuts
  if (!list?.length || (next.clips === prev.clips && list === prev.autoCuts)) return next
  const old = new Set((prev.autoCuts ?? []).map((c) => c.id))
  const byHand = next.clips === prev.clips ? [] : without(cutPieces(prev.clips, next.clips), list.filter((c) => !old.has(c.id)).flatMap((c) => c.was))
  const absorbed = (c: AutoCut): boolean => c.action === 'cut' && old.has(c.id) && byHand.length > 0 && sameGap(c, byHand, next.clips)
  const live = intactOf(list.filter((c) => !absorbed(c)), next.clips)
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
 * The speed-up `cut` without the parts that a speed-up of `reviewed` (the panel's list, no longer
 * recorded) plays at its own speed, or hands on to a later one of `list`, and holds at a speed other
 * than `cut`'s: one kept inside a third one inside `cut` (an 8× kept inside a 4× inside a 2×). Such
 * a part is the user's, as withSpeedUpKept makes it for a record. With `itsSpeed`, the parts it holds
 * at `cut`'s speed instead. `cut` itself when no part is.
 */
export function withoutKeptInside(cut: AutoCut, clips: readonly Clip[], reviewed: readonly AutoCut[], list: readonly AutoCut[], itsSpeed = false): AutoCut {
  if (cut.action === 'cut') return cut
  // Their pieces by their speed, each kind taken at once.
  const by = new Map<number, Piece[]>()
  for (const r of reviewed) {
    if (r.id === cut.id || r.action === 'cut') continue
    for (const w of r.was) {
      if ((w.speed === cut.action) !== itsSpeed) continue
      const ws = by.get(r.action)
      if (ws) ws.push(w)
      else by.set(r.action, [w])
    }
  }
  const yours: Piece[] = []
  for (const [speed, ws] of by) {
    const held = holds(list, clips, speed, cut)
    const plays = (held.plays ??= union([...playing(clips, -Infinity, Infinity, speed), ...held.parts]))
    for (const p of both(union(ws), plays, speed)) yours.push(p)
  }
  const was = without(cut.was, yours)
  return length(cut.was) - length(was) > EPS ? { ...cut, was } : cut
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
