/**
 * What Find found, as covers (docs/design/auto-blur.md §5.10, §6.1): suggestions grouped, tiered and
 * coloured; Find again's merge into the project, which never uncovers anything (containment through a
 * time and grid index, missed suggestions, removed paths that suppress only what they hold, the
 * limits); the width that hides a text's length; and what a copy made before Find lacks. Pure.
 */
import type { FindResult, FoundCover, OriginCovers } from '../api/privacy'
import { newCoverId } from '../editor/coverEdit'
import { coverColourOf } from '../render/coverColour'
import type { Bleep, Cover, FindRecord, NormRect, PrivateKind, Project, RejectedPlace } from '../types'
import { isPrivateBleep, MAX_COVERS, MAX_KEYS, mergeCovers } from './coverData'
import { boxAt, coverSlack, parsePath, pathKeys, simplifyKeys, unionBox, writePath, type CoverKey } from './coverPath'
import { containsOver } from './covers'
import { COVER_DARK, isPrivateKind, tierOf } from './kinds'
import type { Size } from './look'
import type { Box } from './protocol'

/* ---------- the width that hides a text's length (§6.1, D23) ---------- */

/**
 * A found cover widened so its width does not give the text's length: the own text's width (the box
 * less its padding) rounded up to the next multiple of 4 mean character widths, the padding added
 * back, then `extra` (0, 1 or 2) more character widths; widened equally on both sides and held inside
 * the frame. Two names of 9 and 11 characters in one font get the same width.
 */
export function hideLength(box: Box, charWidth: number, padH: number, extra: number, frame: Size): Box {
  const cw = Math.max(1, charWidth)
  const own = Math.max(cw, box[2] - 2 * padH)
  const unit = 4 * cw
  const width = Math.min(frame.width, Math.ceil(own / unit - 1e-9) * unit + 2 * padH + Math.max(0, Math.round(extra)) * cw)
  if (width <= box[2]) return box
  let x = box[0] - (width - box[2]) / 2
  if (x < 0) x = 0
  if (x + width > frame.width) x = frame.width - width
  return [x, box[1], width, box[3]]
}

/** The random extra of each group, chosen once a group (every place of one text gets the same). */
export function groupExtras(random: () => number): (group: string) => number {
  const chosen = new Map<string, number>()
  return (group) => {
    let e = chosen.get(group)
    if (e === undefined) {
      e = Math.min(2, Math.floor(Math.min(0.999999, Math.max(0, random())) * 3))
      chosen.set(group, e)
    }
    return e
  }
}

/** A found cover's colour from its read line's ring (§8.4): the ring's colour, or Dark for a mixed ring. */
export function foundColour(ring: string, spread: number): string {
  return coverColourOf({ color: /^#[0-9a-f]{6}$/i.test(ring) ? ring.toLowerCase() : COVER_DARK, spread: Number.isFinite(spread) ? spread : Infinity }, 'ring')
}

/* ---------- found covers (§5.10) ---------- */

const GROUP = /^[A-Za-z0-9_-]{1,32}$/
/** Covers of one group this close in time, with overlapping boxes, are one. */
const GROUP_GAP_S = 0.5

const keysOf = (c: Pick<Cover, 'path'>): readonly CoverKey[] => pathKeys(c)
const overlapsN = (a: NormRect, b: NormRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Whether two covers of one group touch: overlapping in time with boxes that overlap throughout it (the
 * same place found twice), or within 0.5 s with boxes that overlap where they meet. Two places of one
 * text that only cross (a list showing it on many rows, one lost for a moment) stay apart: their union
 * would be one box over every row between them for their whole time.
 */
function touching(a: Cover, b: Cover): boolean {
  const from = Math.max(a.start, b.start)
  const to = Math.min(a.end, b.end)
  if (to > from) {
    const times = new Set<number>([from])
    for (const k of keysOf(a)) if (k.t > from && k.t < to) times.add(k.t)
    for (const k of keysOf(b)) if (k.t > from && k.t < to) times.add(k.t)
    let met = false
    for (const t of times) {
      const x = boxAt(a, t)
      const y = boxAt(b, t)
      if (!x || !y) continue
      if (!overlapsN(x, y)) return false
      met = true
    }
    return met
  }
  if (from - to > GROUP_GAP_S) return false
  const [first, second] = a.end <= b.start ? [a, b] : [b, a]
  const x = boxAt(first, first.end - 1e-6)
  const y = boxAt(second, second.start)
  return !!x && !!y && overlapsN(x, y)
}

/** The union of two covers' paths: at each key of either, both boxes where both are active; the gap between them covered. */
function unionCover(a: Cover, b: Cover): Cover {
  const start = Math.min(a.start, b.start)
  const end = Math.max(a.end, b.end)
  const times = [...new Set([start, ...keysOf(a).map((k) => k.t), ...keysOf(b).map((k) => k.t), a.end, b.end].filter((t) => t >= start && t < end))].sort((x, y) => x - y)
  const [first, second] = a.start <= b.start ? [a, b] : [b, a]
  const keys: CoverKey[] = []
  for (const t of times) {
    // In a gap between the two, the earlier one's last box holds until the later one starts.
    const x = boxAt(first, t) ?? (t >= first.end && t < second.start ? boxAt(first, first.end - 1e-6) : null)
    const y = boxAt(second, t)
    const box = x && y ? unionBox(x, y) : (x ?? y)
    if (!box) continue
    const last = keys[keys.length - 1]
    if (last && last.x === box.x && last.y === box.y && last.w === box.w && last.h === box.h) continue
    keys.push({ t, ...box })
  }
  const tier = a.found === 'auto' || b.found === 'auto' ? 'auto' : 'check'
  const out: Cover = { id: a.id, start, end, path: writePath(keys), color: first.color, found: tier }
  if (a.kind) out.kind = a.kind
  if (a.group) out.group = a.group
  if (a.lost || b.lost) out.lost = true
  if (a.thin || b.thin) out.thin = true
  return out
}

/**
 * The covers of Find's result (§5.10, §6.1): each found cover a suggestion, its tier from its score
 * (0.85 Auto, 0.50 Check, under it nothing), its colour as main read it from its line's ring (Dark
 * when unreadable), and covers of one group that touch (overlapping in time or within 0.5 s, with
 * overlapping boxes) joined into one whose path is the union. The width rounding of §6.1 was made in
 * main, where the lines' character widths are (hideLength). Paths that do not parse, empty times and
 * boxes under a pixel are left out.
 */
export function foundCovers(result: Pick<Extract<FindResult, { ok: true }>, 'found'>, size: Size, random: () => number): Cover[] {
  const minW = 1 / Math.max(1, size.width)
  const minH = 1 / Math.max(1, size.height)
  const groups = new Map<string, Cover[]>()
  const taken = new Set<string>()
  const id = (): string => {
    let x = newCoverId(random)
    while (taken.has(x)) x = newCoverId(random)
    taken.add(x)
    return x
  }
  for (const f of result.found) {
    const tier = tierOf(f.score)
    const keys = typeof f.path === 'string' ? parsePath(f.path) : null
    if (!tier || !keys?.length || !isPrivateKind(f.kind) || !(Number.isFinite(f.start) && Number.isFinite(f.end) && f.end > f.start)) continue
    if (keys.every((k) => k.w < minW || k.h < minH)) continue
    const group = typeof f.group === 'string' && GROUP.test(f.group) ? f.group : id().slice(2)
    const c: Cover = { id: id(), start: f.start, end: f.end, path: f.path, color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color.toLowerCase() : COVER_DARK, found: tier, kind: f.kind, group }
    if (f.lost) c.lost = true
    if (f.thin) c.thin = true
    const list = groups.get(group)
    if (list) list.push(c)
    else groups.set(group, [c])
  }
  const out: Cover[] = []
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.start - b.start)
    const merged: Cover[] = []
    for (const c of sorted) {
      let cur = c
      for (let i = merged.length - 1; i >= 0; i--) {
        if (!touching(merged[i], cur)) continue
        cur = unionCover(merged[i], cur)
        merged.splice(i, 1)
      }
      merged.push(cur)
    }
    out.push(...merged)
  }
  return out.sort((a, b) => a.start - b.start)
}

/* ---------- the index of Find again (§5.10) ---------- */

/** A cover or a removed place, with the bounding box of its path in an 8 × 8 grid and its times. */
interface Entry<T> {
  item: T
  start: number
  end: number
  mask: [number, number]
}

const GRID = 8
/** Covers longer than this are kept in one list checked by every query, not in time buckets. */
const LONG_S = 60

function maskOf(keys: readonly CoverKey[]): [number, number] {
  if (!keys.length) return [0, 0]
  let x0 = 1
  let y0 = 1
  let x1 = 0
  let y1 = 0
  for (const k of keys) {
    x0 = Math.min(x0, k.x)
    y0 = Math.min(y0, k.y)
    x1 = Math.max(x1, k.x + k.w)
    y1 = Math.max(y1, k.y + k.h)
  }
  const c0 = Math.max(0, Math.min(GRID - 1, Math.floor(x0 * GRID)))
  const c1 = Math.max(0, Math.min(GRID - 1, Math.ceil(x1 * GRID) - 1))
  const r0 = Math.max(0, Math.min(GRID - 1, Math.floor(y0 * GRID)))
  const r1 = Math.max(0, Math.min(GRID - 1, Math.ceil(y1 * GRID) - 1))
  let lo = 0
  let hi = 0
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const i = r * GRID + c
      if (i < 32) lo |= 1 << i
      else hi |= 1 << (i - 32)
    }
  return [lo, hi]
}

/** A time (one-second buckets) and grid index of covers or removed places, built once per call. */
class PlaceIndex<T extends Pick<Cover, 'path' | 'start' | 'end'>> {
  private readonly buckets = new Map<number, Entry<T>[]>()
  private readonly long: Entry<T>[] = []
  private stamp = 0
  private readonly seen = new Map<Entry<T>, number>()

  constructor(items: readonly T[]) {
    for (const item of items) {
      const e: Entry<T> = { item, start: item.start, end: item.end, mask: maskOf(keysOf(item)) }
      if (e.end - e.start > LONG_S) {
        this.long.push(e)
        continue
      }
      for (let s = Math.floor(e.start); s <= Math.floor(e.end); s++) {
        const list = this.buckets.get(s)
        if (list) list.push(e)
        else this.buckets.set(s, [e])
      }
    }
  }

  /** The items whose times and grid cells meet `c`'s. */
  near(c: Pick<Cover, 'path' | 'start' | 'end'>, slack: number): T[] {
    const mask = maskOf(keysOf(c))
    const stamp = ++this.stamp
    const out: T[] = []
    const take = (e: Entry<T>): void => {
      if (this.seen.get(e) === stamp) return
      this.seen.set(e, stamp)
      if (e.end < c.start - slack || e.start > c.end + slack) return
      if (!(e.mask[0] & mask[0]) && !(e.mask[1] & mask[1])) return
      out.push(e.item)
    }
    for (const e of this.long) take(e)
    for (let s = Math.floor(c.start - slack); s <= Math.floor(c.end + slack); s++) for (const e of this.buckets.get(s) ?? []) take(e)
    return out
  }
}

/** Two covers active together somewhere with boxes that overlap there. */
function meet(a: Cover, b: Cover): boolean {
  return a.start < b.end && b.start < a.end && touching(a, b)
}

/* ---------- limits (§5.10, §4.2) ---------- */

/**
 * The covers within the limits (§4.2, §5.10): over MAX_COVERS, the cheapest pairs merged first
 * (mergeCovers, O(n log n), finding 7); over MAX_KEYS, the longest paths simplified first. Merging and
 * simplifying only grow boxes and times; a drawn cover is never dropped.
 */
export function limitCovers(covers: readonly Cover[]): Cover[] {
  const merged = covers.length > MAX_COVERS ? mergeCovers(covers, MAX_COVERS) : [...covers]
  let keys = 0
  for (const c of merged) keys += keysOf(c).length
  return keys > MAX_KEYS ? simplifyKeys(merged, MAX_KEYS) : merged
}

/* ---------- applying Find's result (§5.10) ---------- */

/**
 * Find's result merged into the project as it is now (§5.10), in one update: Find again never
 * uncovers anything. The user's covers are never changed. A new suggestion is dropped when one
 * existing cover contains it at every key (overlap is not enough), and when a removed place of the
 * same kind holds it (D21; counted). The last run's suggestions of the kinds this run looked for that
 * it did not find again are marked missed (not past where a stopped run read to); found again, the
 * mark goes. The private bleeps found in what was said are added, the run's record set, and the covers
 * kept within the limits.
 */
export function withFoundCovers(project: Project, result: Extract<FindResult, { ok: true }>, said: readonly Bleep[], record: FindRecord, random: () => number): { project: Project; suppressed: number } {
  const size = { width: project.width, height: project.height }
  const slack = coverSlack(project.capture?.fps ?? 60)
  const fresh = foundCovers(result, size, random)
  const existing = project.covers ?? []
  const used = new Set(existing.map((c) => c.id))
  for (const c of fresh) while (used.has(c.id)) c.id = newCoverId(random)
  const covers = new PlaceIndex<Cover>(existing)
  const rejected = new PlaceIndex<RejectedPlace>(project.privacy?.rejected ?? [])
  const kept: Cover[] = []
  const again = new Set<string>()
  let suppressed = 0
  for (const c of fresh) {
    if (rejected.near(c, slack).some((r) => r.kind === c.kind && containsOver(r, c, slack))) {
      suppressed++
      continue
    }
    const near = covers.near(c, slack)
    for (const e of near) if (e.found && e.kind === c.kind && meet(e, c)) again.add(e.id)
    if (near.some((e) => containsOver(e, c, slack))) {
      for (const e of near) if (e.found && e.kind === c.kind && containsOver(e, c, slack)) again.add(e.id)
      continue
    }
    kept.push(c)
  }
  const looked = new Set<PrivateKind>(record.kinds)
  const readTo = result.stopped && result.readTo !== null ? result.readTo : Infinity
  const next = existing.map((e) => {
    if (!e.found) return e
    if (again.has(e.id)) {
      if (!e.missed) return e
      const { missed: _m, ...rest } = e
      void _m
      return rest
    }
    if (e.missed || !e.kind || !looked.has(e.kind) || e.start > readTo) return e
    return { ...e, missed: true as const }
  })
  const all = limitCovers([...next, ...kept])
  const out: Project = { ...project }
  if (all.length || project.covers) out.covers = all
  if (said.length) out.bleeps = [...(project.bleeps ?? []), ...said]
  out.privacy = { ...(project.privacy ?? {}), find: suppressed ? { ...record, suppressed } : record }
  return { project: out, suppressed }
}

/* ---------- copies made before Find (§2.12, §5.10) ---------- */

/** A cover as Find sends it (for a copy's suggestions): its kind, its tier's score, its group, times, path and colour. */
function asFound(c: Cover): FoundCover | null {
  if (!c.kind) return null
  const f: FoundCover = { kind: c.kind, score: c.found === 'check' ? 0.6 : 0.9, group: c.group ?? c.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32), start: c.start, end: c.end, path: c.path, color: c.color }
  if (c.lost) f.lost = true
  if (c.thin) f.thin = true
  return f
}

/**
 * What a copy made from `original` lacks of its covers and private bleeps (§5.10): the original's
 * found covers (waiting or kept) that no cover of the copy contains, as suggestions, and its private
 * bleeps the copy does not have. Covers the user drew are the user's own in each project.
 */
export function originCoversFor(original: Project, copy: Project): OriginCovers {
  const slack = coverSlack(original.capture?.fps ?? 60)
  const index = new PlaceIndex<Cover>(copy.covers ?? [])
  const covers: FoundCover[] = []
  for (const c of original.covers ?? []) {
    const f = asFound(c)
    if (!f) continue
    if (index.near(c, slack).some((e) => containsOver(e, c, slack))) continue
    covers.push(f)
  }
  const have = (copy.bleeps ?? []).filter(isPrivateBleep)
  const bleeps = (original.bleeps ?? []).filter((b) => isPrivateBleep(b) && !have.some((h) => h.word === b.word && h.start <= b.start + 1e-3 && h.end >= b.end - 1e-3))
  return { missing: covers.length + bleeps.length, covers, bleeps }
}
