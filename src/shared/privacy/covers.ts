/**
 * Finding covers fast (docs/design/auto-blur.md §13.1): the index the compositor asks every frame,
 * containment for Find again (§5.10), where a cover sits on screen (Review's place line) and Review's
 * index of private groups. Pure; every index is built once per array and kept.
 */
import type { Bleep, Cover, NormRect, Project } from '../types'
import { isPrivateBleep, privateGroupOf } from './coverData'
import { boxAt, drawnBox, pathKeys } from './coverPath'

export interface CoverIndex {
  readonly covers: readonly Cover[]
}

interface Built extends CoverIndex {
  /** Positions in `covers` sorted by start. */
  order: Int32Array
  starts: Float64Array
  ends: Float64Array
  /** A segment tree of the largest end over `order`. */
  tree: Float64Array
  size: number
}

const built = new WeakMap<readonly Cover[], Built>()
const NONE: readonly Cover[] = Object.freeze([])

/** The index of `covers`, built once per array: sorted by start, with the largest end of every span of them. */
export function coverIndex(covers: readonly Cover[]): CoverIndex {
  const hit = built.get(covers)
  if (hit) return hit
  const n = covers.length
  const order = Int32Array.from({ length: n }, (_v, i) => i).sort((a, b) => covers[a].start - covers[b].start || a - b)
  const starts = Float64Array.from(order, (i) => covers[i].start)
  const ends = Float64Array.from(order, (i) => covers[i].end)
  let size = 1
  while (size < n) size *= 2
  const tree = new Float64Array(2 * size).fill(-Infinity)
  for (let i = 0; i < n; i++) tree[size + i] = ends[i]
  for (let i = size - 1; i >= 1; i--) tree[i] = Math.max(tree[2 * i], tree[2 * i + 1])
  const index: Built = { covers, order, starts, ends, tree, size }
  built.set(covers, index)
  return index
}

/** Positions of the covers with start <= hi and end > lo, in the project's order. */
function query(index: CoverIndex, lo: number, hi: number): readonly Cover[] {
  const b = index as Built
  if (!b.order || !b.covers.length) return NONE
  // Covers sorted by start: those at positions [0, last) start at or before hi.
  let l = 0
  let r = b.starts.length
  while (l < r) {
    const m = (l + r) >> 1
    if (b.starts[m] <= hi) l = m + 1
    else r = m
  }
  const last = l
  if (!last) return NONE
  const hits: number[] = []
  const walk = (node: number, from: number, to: number): void => {
    if (from >= last || b.tree[node] <= lo) return
    if (to - from === 1) {
      hits.push(b.order[from])
      return
    }
    const mid = (from + to) >> 1
    walk(2 * node, from, mid)
    walk(2 * node + 1, mid, to)
  }
  walk(1, 0, b.size)
  if (!hits.length) return NONE
  hits.sort((x, y) => x - y)
  return hits.map((i) => b.covers[i])
}

/** The covers drawn at picture time `t`: active at some time in [t − slack, t + slack] (§4.2), in the project's order. */
export function coversAt(index: CoverIndex, t: number, slack: number): readonly Cover[] {
  return query(index, t - slack, t + slack)
}

/** The covers active anywhere in [from, to], in the project's order. */
export function coversIn(index: CoverIndex, from: number, to: number): readonly Cover[] {
  return query(index, from, to)
}

const EPS = 1e-9
const inside = (inner: NormRect, outer: NormRect): boolean =>
  inner.x >= outer.x - EPS && inner.y >= outer.y - EPS && inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.h <= outer.y + outer.h + EPS

/**
 * Whether `outer` holds `inner` over all of inner's time (§5.10): outer is active for inner's whole
 * time (with slack), and at every key of inner's path and every key of outer's path inside inner's
 * times, outer's drawn box (with slack) contains inner's box. Overlap alone is not enough.
 */
export function containsOver(outer: Pick<Cover, 'path' | 'start' | 'end'>, inner: Pick<Cover, 'path' | 'start' | 'end'>, slack: number): boolean {
  if (!(outer.start <= inner.start + slack && outer.end >= inner.end - slack)) return false
  const o = outer as Cover
  const i = inner as Cover
  const times = new Set<number>([inner.start])
  for (const k of pathKeys(inner)) if (k.t > inner.start && k.t < inner.end) times.add(k.t)
  for (const k of pathKeys(outer)) if (k.t > inner.start && k.t < inner.end) times.add(k.t)
  for (const t of times) {
    const box = boxAt(i, t)
    if (!box) continue
    const held = drawnBox(o, t, slack)
    if (!held || !inside(box, held)) return false
  }
  return true
}

/** Where a box's middle is on screen, in thirds (Review's place line, §2.7). */
export function placeOf(box: NormRect): 'topLeft' | 'top' | 'topRight' | 'left' | 'centre' | 'right' | 'bottomLeft' | 'bottom' | 'bottomRight' {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const col = cx < 1 / 3 ? 0 : cx < 2 / 3 ? 1 : 2
  const row = cy < 1 / 3 ? 0 : cy < 2 / 3 ? 1 : 2
  const names = [
    ['topLeft', 'top', 'topRight'],
    ['left', 'centre', 'right'],
    ['bottomLeft', 'bottom', 'bottomRight']
  ] as const
  return names[row][col]
}

export interface PrivacyIndex {
  group(id: string): { covers: readonly string[]; bleeps: readonly string[]; waiting: boolean; check: boolean } | null
  readonly groups: readonly string[]
}

interface GroupEntry {
  covers: string[]
  bleeps: string[]
  waiting: boolean
  check: boolean
}

const NO_COVERS: readonly Cover[] = Object.freeze([])
const NO_BLEEPS: readonly Bleep[] = Object.freeze([])
const privacyIndexes = new WeakMap<readonly Cover[], WeakMap<readonly Bleep[], PrivacyIndex>>()

/**
 * Review's index of private groups (§13.1), built once per covers and bleeps arrays: each group's
 * cover ids and private bleep ids, whether any of them still waits for review and whether any is a
 * Check suggestion. A cover's group and a said text's group are both listed by their own ids.
 */
export function privacyIndex(project: Pick<Project, 'covers' | 'bleeps'>): PrivacyIndex {
  const covers = project.covers ?? NO_COVERS
  const bleeps = project.bleeps ?? NO_BLEEPS
  let byBleeps = privacyIndexes.get(covers)
  if (!byBleeps) {
    byBleeps = new WeakMap()
    privacyIndexes.set(covers, byBleeps)
  }
  const hit = byBleeps.get(bleeps)
  if (hit) return hit
  const map = new Map<string, GroupEntry>()
  const entry = (id: string): GroupEntry => {
    let e = map.get(id)
    if (!e) {
      e = { covers: [], bleeps: [], waiting: false, check: false }
      map.set(id, e)
    }
    return e
  }
  for (const c of covers) {
    if (!c.group) continue
    const e = entry(c.group)
    e.covers.push(c.id)
    if (c.found) e.waiting = true
    if (c.found === 'check') e.check = true
  }
  for (const b of bleeps) {
    if (!isPrivateBleep(b)) continue
    const g = privateGroupOf(b)
    if (!g) continue
    const e = entry(g)
    e.bleeps.push(b.id)
    if (b.auto) e.waiting = true
  }
  const groups = Object.freeze([...map.keys()])
  const index: PrivacyIndex = {
    groups,
    group: (id) => {
      const e = map.get(id)
      return e ? { covers: e.covers, bleeps: e.bleeps, waiting: e.waiting, check: e.check } : null
    }
  }
  byBleeps.set(bleeps, index)
  return index
}
