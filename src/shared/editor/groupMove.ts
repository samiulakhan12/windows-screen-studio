/**
 * Moving several items together (E-06, docs/design/multi-select.md §4.8, §4.9): the block limits
 * of a group, which deltas its freeze frames accept, the move itself (one project out, the same
 * project when nothing changes), the Starts at / ±1 s moves and the shared Length. Pure.
 *
 * Every member keeps its distance to the others: the group moves by one delta, limited by the
 * tightest member. A move writes each member's times from where it was at the press (`initial`),
 * so a drag's moves never drift.
 */
import { atEditEnd } from '../engine/freeze'
import { clipIndexAt } from '../engine/timeline'
import { dragZoomTimes, zoomDragBounds } from '../engine/zoom'
import type { Project } from '../types'
import { dragAnnotationTimes } from './annotations'
import { canMoveFreeze, moveFreeze } from './freezeEdit'
import { parseItemKey, type GroupKind, type ItemKey } from './multiSelect'
import { dragShapeTimes } from './shapes'
import { dragTitleTimes } from './titles'

/** Why a group move stops: the recording's start or end, a zoom in the way, a freeze frame's clip or frame, or a full group. */
export type StopReason = 'start' | 'end' | 'zoom' | 'freeze-clip' | 'freeze-in-cut' | 'freeze-taken' | 'full'

export interface GroupMovePlan {
  keys: readonly ItemKey[]
  /** Each member's times at the press (points: start === end). */
  initial: ReadonlyMap<ItemKey, { start: number; end: number }>
  /** Allowed delta (source seconds): min <= 0 <= max. */
  min: number
  max: number
  minWhy: StopReason | null
  maxWhy: StopReason | null
  /** The group's outer times. */
  span: { start: number; end: number }
  /** Selected freeze ids, in anchor order. */
  freezes: readonly string[]
}

/** Two zoom edges this close are touching (as zoomDragBounds). */
const TOUCH = 1e-6
/** A freeze's anchor stays at least this far before its clip's end (clip ends are exclusive; anchors are whole ms). */
const FREEZE_END_GAP = 0.001

type Timed = { id: string; start: number; end: number }

/** The list of `kind` as timed items (chapters and freezes are points). */
function listOf(p: Project, kind: GroupKind): readonly Timed[] {
  switch (kind) {
    case 'zoom':
      return p.zooms
    case 'annotation':
      return p.annotations
    case 'shape':
      return p.shapes ?? []
    case 'spotlight':
      return p.spotlights ?? []
    case 'title':
      return p.titles ?? []
    case 'chapter':
      return (p.chapters ?? []).map((c) => ({ id: c.id, start: c.t, end: c.t }))
    case 'freeze':
      return (p.freezes ?? []).map((f) => ({ id: f.id, start: f.at, end: f.at }))
  }
}

/** The members that exist, by kind: id → times. */
function membersOf(p: Project, keys: readonly ItemKey[]): Map<GroupKind, Map<string, Timed>> {
  const wanted = new Map<GroupKind, Set<string>>()
  for (const key of keys) {
    const k = parseItemKey(key)
    if (!k) continue
    let ids = wanted.get(k.kind)
    if (!ids) wanted.set(k.kind, (ids = new Set()))
    ids.add(k.id)
  }
  const out = new Map<GroupKind, Map<string, Timed>>()
  for (const [kind, ids] of wanted) {
    const found = new Map<string, Timed>()
    for (const x of listOf(p, kind)) if (ids.has(x.id)) found.set(x.id, { id: x.id, start: x.start, end: x.end })
    if (found.size) out.set(kind, found)
  }
  return out
}

/** Largest value in `sorted` (ascending) that is <= `t`, or null. */
function lastAtOrBelow(sorted: readonly number[], t: number): number | null {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? sorted[lo - 1] : null
}

/** Smallest value in `sorted` (ascending) that is >= `t`, or null. */
function firstAtOrAbove(sorted: readonly number[], t: number): number | null {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo < sorted.length ? sorted[lo] : null
}

/**
 * The block limits of moving `keys` together (§4.8): each member's allowed delta, widened to contain
 * 0 (data already out of bounds never jumps), intersected. Zooms stop at unselected zooms; a freeze
 * stays in its clip; a freeze whose frame is cut pins the group. Built once per press: O(n log n).
 */
export function groupMovePlan(p: Project, keys: readonly ItemKey[]): GroupMovePlan {
  const { duration, clips } = p
  const members = membersOf(p, keys)
  const initial = new Map<ItemKey, { start: number; end: number }>()
  let min = -Infinity
  let max = Infinity
  let minWhy: StopReason | null = null
  let maxWhy: StopReason | null = null
  let spanStart = Infinity
  let spanEnd = -Infinity
  const limit = (lo: number, loWhy: StopReason, hi: number, hiWhy: StopReason): void => {
    const l = Math.min(0, lo)
    const h = Math.max(0, hi)
    if (l > min) {
      min = l
      minWhy = loWhy
    }
    if (h < max) {
      max = h
      maxWhy = hiWhy
    }
  }

  // Zooms are bounded by the zooms that do not move: their ends and starts, sorted once.
  const zoomIds = members.get('zoom')
  let ends: number[] = []
  let starts: number[] = []
  if (zoomIds) {
    const still = p.zooms.filter((z) => !zoomIds.has(z.id))
    ends = still.map((z) => z.end).sort((a, b) => a - b)
    starts = still.map((z) => z.start).sort((a, b) => a - b)
  }

  const freezeIds: { id: string; at: number }[] = []
  for (const [kind, found] of members) {
    for (const x of found.values()) {
      const key = `${kind}:${x.id}` as ItemKey
      initial.set(key, { start: x.start, end: x.end })
      spanStart = Math.min(spanStart, x.start)
      spanEnd = Math.max(spanEnd, x.end)
      if (kind === 'zoom') {
        const prev = lastAtOrBelow(ends, x.start + TOUCH)
        const next = firstAtOrAbove(starts, x.end - TOUCH)
        limit((prev ?? 0) - x.start, prev === null ? 'start' : 'zoom', (next ?? duration) - x.end, next === null ? 'end' : 'zoom')
      } else if (kind === 'freeze') {
        freezeIds.push({ id: x.id, at: x.start })
        const at = x.start
        if (atEditEnd(clips, at)) {
          limit(clips[clips.length - 1].start - at, 'freeze-clip', 0, 'freeze-clip')
        } else {
          const i = clipIndexAt(clips, at)
          if (i < 0) limit(0, 'freeze-in-cut', 0, 'freeze-in-cut')
          else limit(clips[i].start - at, 'freeze-clip', clips[i].end - FREEZE_END_GAP - at, 'freeze-clip')
        }
      } else {
        limit(-x.start, 'start', duration - x.end, 'end')
      }
    }
  }

  if (initial.size === 0) return { keys, initial, min: 0, max: 0, minWhy: null, maxWhy: null, span: { start: 0, end: 0 }, freezes: [] }
  const span = { start: spanStart, end: spanEnd }
  if (span.start <= 0 && span.end >= duration) {
    min = 0
    max = 0
    minWhy = 'full'
    maxWhy = 'full'
  }
  return { keys, initial, min, max, minWhy, maxWhy, span, freezes: freezeIds.sort((a, b) => a.at - b.at).map((f) => f.id) }
}

/** The freeze members' (id, press anchor) in the order a move of `delta` applies them: latest first when moving later. */
function freezeOrder(plan: GroupMovePlan, delta: number): { id: string; at: number }[] {
  const list = plan.freezes.map((id) => ({ id, at: plan.initial.get(`freeze:${id}`)!.start }))
  return delta > 0 ? list.reverse() : list
}

/**
 * Whether every selected freeze can take the frame `delta` away (moveFreeze would move it): applied
 * in order, latest first when moving later and earliest first when moving earlier, so a selected
 * freeze never lands on another selected freeze's old frame. `p` is the project at the press.
 */
export function groupAccepts(p: Project, plan: GroupMovePlan, delta: number): boolean {
  if (plan.freezes.length === 0) return true
  let q = p
  for (const { id, at } of freezeOrder(plan, delta)) {
    if (!canMoveFreeze(q, id, at + delta)) return false
    q = moveFreeze(q, id, at + delta)
  }
  return true
}

/** A plan's members by kind (id → press times), parsed once per plan. */
const parsedPlans = new WeakMap<GroupMovePlan, Map<GroupKind, Map<string, { start: number; end: number }>>>()
function byKind(plan: GroupMovePlan): Map<GroupKind, Map<string, { start: number; end: number }>> {
  let m = parsedPlans.get(plan)
  if (m) return m
  m = new Map()
  for (const [key, init] of plan.initial) {
    const k = parseItemKey(key)
    if (!k) continue
    let ids = m.get(k.kind)
    if (!ids) m.set(k.kind, (ids = new Map()))
    ids.set(k.id, init)
  }
  parsedPlans.set(plan, m)
  return m
}

/** Where a member goes: its press times plus `delta`; the edge that snapped is written exactly as its target. */
function placedStart(init: { start: number; end: number }, delta: number, exact: { from: number; to: number } | null | undefined): number {
  if (exact && init.start === exact.from) return exact.to
  if (exact && init.end === exact.from) return exact.to - (init.end - init.start)
  return init.start + delta
}
function placedEnd(init: { start: number; end: number }, delta: number, exact: { from: number; to: number } | null | undefined): number {
  if (exact && init.start === exact.from) return exact.to + (init.end - init.start)
  if (exact && init.end === exact.from) return exact.to
  return init.end + delta
}

/** `list` with the members in `inits` moved by `delta` (and given `extra`); the same array when none changed. */
function retimed<T extends { id: string; start: number; end: number }>(
  list: readonly T[],
  inits: ReadonlyMap<string, { start: number; end: number }>,
  delta: number,
  exact: { from: number; to: number } | null | undefined,
  extra?: Partial<T>
): T[] {
  let out: T[] | null = null
  for (let i = 0; i < list.length; i++) {
    const x = list[i]
    const init = inits.get(x.id)
    if (!init) continue
    const start = placedStart(init, delta, exact)
    const end = placedEnd(init, delta, exact)
    if (start === x.start && end === x.end) continue
    out ??= list.slice()
    out[i] = { ...x, start, end, ...extra }
  }
  return out ?? (list as T[])
}

/** `list` with item `id` given exactly `times` (and `extra`). */
function withTimes<T extends { id: string; start: number; end: number }>(list: readonly T[], id: string, times: { start: number; end: number }, extra?: Partial<T>): T[] {
  return list.map((x) => (x.id === id ? { ...x, start: times.start, end: times.end, ...extra } : x))
}

/**
 * The group moved by `delta` from its press times (`plan.initial`), in one project: text, shapes,
 * spotlights, title cards and chapters by exactly `delta`, zooms too (made yours: `auto: false`), and
 * freezes through moveFreeze (each anchor on a frame start). With `exact` (a snapped edge), every
 * member edge equal to `exact.from` is written as `exact.to`. The same project when nothing changes.
 * O(n) per call: the plan's keys are parsed once.
 */
export function moveGroup(p: Project, plan: GroupMovePlan, delta: number, exact?: { from: number; to: number } | null): Project {
  const to = byKind(plan)
  let q = p
  const zooms = to.get('zoom')
  if (zooms) {
    const next = retimed(q.zooms, zooms, delta, exact, { auto: false })
    if (next !== q.zooms) q = { ...q, zooms: next }
  }
  const annotations = to.get('annotation')
  if (annotations) {
    const next = retimed(q.annotations, annotations, delta, exact)
    if (next !== q.annotations) q = { ...q, annotations: next }
  }
  const shapes = to.get('shape')
  if (shapes && q.shapes) {
    const next = retimed(q.shapes, shapes, delta, exact)
    if (next !== q.shapes) q = { ...q, shapes: next }
  }
  const spotlights = to.get('spotlight')
  if (spotlights && q.spotlights) {
    const next = retimed(q.spotlights, spotlights, delta, exact)
    if (next !== q.spotlights) q = { ...q, spotlights: next }
  }
  const titles = to.get('title')
  if (titles && q.titles) {
    const next = retimed(q.titles, titles, delta, exact)
    if (next !== q.titles) q = { ...q, titles: next }
  }
  const chapters = to.get('chapter')
  if (chapters && q.chapters) {
    let changed = false
    const next = q.chapters.map((c) => {
      const init = chapters.get(c.id)
      const t = init ? placedStart(init, delta, exact) : c.t
      if (t === c.t) return c
      changed = true
      return { ...c, t }
    })
    if (changed) q = { ...q, chapters: next }
  }
  const freezes = to.get('freeze')
  if (freezes && q.freezes) {
    // Applied in the order of this move from where they are now, so none lands on another's frame.
    const now = new Map(q.freezes.map((f) => [f.id, f.at]))
    const list = [...freezes].filter(([id]) => now.has(id)).map(([id, init]) => ({ id, from: now.get(id)!, t: placedStart(init, delta, exact) }))
    const later = list.some((x) => x.t > x.from)
    list.sort((a, b) => (later ? b.from - a.from : a.from - b.from))
    for (const x of list) q = moveFreeze(q, x.id, x.t)
  }
  return q
}

/** The points a group drag snaps: the grabbed item's start and end, then the group's outer start and end, without repeats. */
export function groupSnapPoints(plan: GroupMovePlan, grabbed: ItemKey): number[] {
  const out: number[] = []
  const add = (t: number | undefined): void => {
    if (t !== undefined && Number.isFinite(t) && !out.includes(t)) out.push(t)
  }
  const g = plan.initial.get(grabbed)
  add(g?.start)
  add(g?.end)
  add(plan.span.start)
  add(plan.span.end)
  return out
}

/**
 * The group moved so it starts at `t` (Starts at, ±1 s): with the drag's limits, and no move at all
 * when its freezes refuse the delta (`freeze-taken`). `stopped` says why a move came out shorter.
 */
export function setGroupStart(p: Project, keys: readonly ItemKey[], t: number): { project: Project; moved: number; stopped: StopReason | null } {
  const plan = groupMovePlan(p, keys)
  if (plan.initial.size === 0 || !Number.isFinite(t)) return { project: p, moved: 0, stopped: null }
  const want = t - plan.span.start
  const d = Math.min(plan.max, Math.max(plan.min, want))
  if (!groupAccepts(p, plan, d)) return { project: p, moved: 0, stopped: 'freeze-taken' }
  const stopped = Math.abs(d - want) > 1e-9 ? (want < d ? plan.minWhy : plan.maxWhy) : null
  return { project: d === 0 ? p : moveGroup(p, plan, d), moved: d, stopped }
}

/**
 * Every span member (zoom, text, shape, spotlight, title card) set to `length` seconds by its own
 * end drag: zooms stop at the next zoom and at MIN_ZOOM_LENGTH (and become yours), the others at
 * their minimum and the recording's end. Chapters and freezes are left as they are. `clamped`
 * counts the members that came out at another length.
 */
export function setGroupLength(p: Project, keys: readonly ItemKey[], length: number): { project: Project; clamped: number } {
  if (!Number.isFinite(length)) return { project: p, clamped: 0 }
  let q = p
  let clamped = 0
  for (const key of keys) {
    const k = parseItemKey(key)
    if (!k || k.kind === 'chapter' || k.kind === 'freeze') continue
    const item = listOf(q, k.kind).find((x) => x.id === k.id)
    if (!item) continue
    const initial = { start: item.start, end: item.end }
    const dt = length - (item.end - item.start)
    const times =
      k.kind === 'zoom'
        ? dragZoomTimes(initial, 'end', dt, zoomDragBounds(q.zooms, k.id, q.duration))
        : k.kind === 'annotation'
          ? dragAnnotationTimes(initial, 'end', dt, q.duration)
          : k.kind === 'title'
            ? dragTitleTimes(initial, 'end', dt, q.duration)
            : dragShapeTimes(initial, 'end', dt, q.duration)
    if (Math.abs(times.end - times.start - length) > 1e-6) clamped++
    if (times.start === item.start && times.end === item.end) continue
    if (k.kind === 'zoom') q = { ...q, zooms: withTimes(q.zooms, k.id, times, { auto: false }) }
    else if (k.kind === 'annotation') q = { ...q, annotations: withTimes(q.annotations, k.id, times) }
    else if (k.kind === 'shape') q = { ...q, shapes: withTimes(q.shapes ?? [], k.id, times) }
    else if (k.kind === 'spotlight') q = { ...q, spotlights: withTimes(q.spotlights ?? [], k.id, times) }
    else q = { ...q, titles: withTimes(q.titles ?? [], k.id, times) }
  }
  return { project: q, clamped }
}
