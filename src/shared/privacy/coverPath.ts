/**
 * A cover's path (docs/design/auto-blur.md §4.2): keys "t x y w h" joined by ";", t in source
 * seconds, the box normalised to the whole recorded frame. The box holds from one key until the
 * next; before the first key, the first key's box. Written rounded outward, so a written path never
 * shrinks a box. Pure.
 */
import type { Cover, NormRect } from '../types'

export interface CoverKey {
  t: number
  x: number
  y: number
  w: number
  h: number
}

/** A placed or lost box on an analysed frame. */
export interface Placement {
  t: number
  box: NormRect
}

/** At most this many keys in one cover's path (§4.2). */
export const MAX_KEYS_PER_COVER = 4000

/** Tolerance for the float sums of grid values: a written edge is never more than this inside the float edge. */
const EPS = 1e-12

/** The largest multiple of 1/scale at or below `v` (as integer units). */
function floorUnits(v: number, scale: number): number {
  let r = Math.round(v * scale)
  if (r / scale > v + EPS) r -= 1
  return r
}

/** The smallest multiple of 1/scale at or above `v` (as integer units). */
function ceilUnits(v: number, scale: number): number {
  let r = Math.round(v * scale)
  if (r / scale < v - EPS) r += 1
  return r
}

/** Integer units of 1/10^digits written as a decimal without exponent or trailing zeros. */
function unitsText(u: number, digits: number): string {
  const scale = digits === 3 ? 1000 : 10000
  const neg = u < 0
  const a = neg ? -u : u
  const whole = Math.floor(a / scale)
  let frac = a - whole * scale
  let text = neg && a ? `-${whole}` : `${whole}`
  if (frac) {
    let d = digits
    while (frac % 10 === 0) {
      frac /= 10
      d--
    }
    text += `.${String(frac).padStart(d, '0')}`
  }
  return text
}

/** 10^0 … 10^22, each exact in a double. */
const POW10 = Array.from({ length: 23 }, (_v, i) => Number(`1e${i}`))

/**
 * The keys of `path`, or null when it is not a path: empty keys, a field that is not a plain
 * decimal (an optional '-', digits, then optionally '.' and digits: no exponents, NaN, Infinity,
 * leading '+' or '.'), not five fields, or times that do not strictly increase. Any number of keys
 * is accepted here; the readers apply the limits. One pass over the characters: a field of at most
 * 15 digits is its digits as an integer divided by a power of ten, which a double divides with
 * correct rounding, so it equals Number() of the field; a longer one goes through Number().
 */
export function parsePath(path: string): CoverKey[] | null {
  const n = readFlat(path)
  if (n < 0) return null
  const out: CoverKey[] = new Array(n)
  for (let k = 0, j = 0; k < n; k++, j += 5) out[k] = { t: flat[j], x: flat[j + 1], y: flat[j + 2], w: flat[j + 3], h: flat[j + 4] }
  return out
}

/**
 * The keys of `path` read as parsePath reads them, without making an object per key: t, x, y, w and
 * h of each key in turn, in a buffer the next call reuses (copy what is kept), or null when it is
 * not a path. For readers that check a path and keep its text.
 */
export function scanPath(path: string): Float64Array | null {
  const n = readFlat(path)
  return n < 0 ? null : flat.subarray(0, 5 * n)
}

/** The keys parsePath and scanPath read, five numbers each; grown as a longer path needs. */
let flat = new Float64Array(5 * 256)

/** Reads `path` into `flat`: the number of keys, or -1 when it is not a path (parsePath's rules). */
function readFlat(path: string): number {
  if (typeof path !== 'string' || !path) return -1
  let field = 0
  let keys = 0
  let last = -Infinity
  const n = path.length
  let i = 0
  for (;;) {
    const from = i
    const neg = path.charCodeAt(i) === 45
    if (neg) i++
    const digitsFrom = i
    let v = 0
    let c = 0
    while (i < n && (c = path.charCodeAt(i)) >= 48 && c <= 57) {
      v = v * 10 + (c - 48)
      i++
    }
    if (i === digitsFrom) return -1
    let fracDigits = 0
    if (i < n && path.charCodeAt(i) === 46) {
      const fracFrom = ++i
      while (i < n && (c = path.charCodeAt(i)) >= 48 && c <= 57) {
        v = v * 10 + (c - 48)
        i++
      }
      fracDigits = i - fracFrom
      if (!fracDigits) return -1
    }
    const digits = i - digitsFrom - (fracDigits ? 1 : 0)
    const value = digits <= 15 ? v / POW10[fracDigits] : Number(path.slice(neg ? from + 1 : from, i))
    if (5 * keys + field >= flat.length) {
      const grown = new Float64Array(flat.length * 2)
      grown.set(flat)
      flat = grown
    }
    flat[5 * keys + field] = neg ? -value : value
    // A field ends at a space or a ';' (or the end, read as one).
    const sep = i < n ? path.charCodeAt(i) : 59
    if (sep === 32) {
      if (++field > 4) return -1
      i++
      continue
    }
    const t = flat[5 * keys]
    if (sep !== 59 || field !== 4 || !(t > last)) return -1
    last = t
    keys++
    field = 0
    if (i >= n) return keys
    i++
  }
}

/**
 * The path of `keys`: t to the millisecond (the first key rounded down, the others to the nearest),
 * x and y rounded down and x + w and y + h rounded up to 4 decimals. Keys whose rounded time does
 * not increase are folded into the key before them (their boxes joined), so the result parses.
 */
export function writePath(keys: readonly CoverKey[]): string {
  const parts: string[] = []
  let lastMs = -Infinity
  let pending: { ms: number; l: number; t: number; r: number; b: number } | null = null
  const flush = (): void => {
    if (!pending) return
    parts.push(`${unitsText(pending.ms, 3)} ${unitsText(pending.l, 4)} ${unitsText(pending.t, 4)} ${unitsText(pending.r - pending.l, 4)} ${unitsText(pending.b - pending.t, 4)}`)
  }
  keys.forEach((k, i) => {
    const ms = i === 0 ? floorUnits(k.t, 1000) : Math.round(k.t * 1000)
    const l = floorUnits(k.x, 1e4)
    const t = floorUnits(k.y, 1e4)
    const r = Math.max(l + 1, ceilUnits(k.x + k.w, 1e4))
    const b = Math.max(t + 1, ceilUnits(k.y + k.h, 1e4))
    if (pending && ms <= lastMs) {
      pending = { ms: pending.ms, l: Math.min(pending.l, l), t: Math.min(pending.t, t), r: Math.max(pending.r, r), b: Math.max(pending.b, b) }
      return
    }
    flush()
    pending = { ms, l, t, r, b }
    lastMs = ms
  })
  flush()
  return parts.join(';')
}

const parsed = new WeakMap<object, { path: string; keys: readonly CoverKey[] }>()

/** Remembers `keys` as the parsed keys of `cover`'s path (a reader that parsed it already). */
export function rememberKeys(cover: Pick<Cover, 'path'>, keys: readonly CoverKey[]): void {
  parsed.set(cover, { path: cover.path, keys: Object.freeze(keys) })
}

/** The keys of a cover's path, parsed once per cover object (an unreadable path has none). */
export function pathKeys(cover: Pick<Cover, 'path'>): readonly CoverKey[] {
  const hit = parsed.get(cover)
  if (hit && hit.path === cover.path) return hit.keys
  const keys = Object.freeze(parsePath(cover.path) ?? [])
  parsed.set(cover, { path: cover.path, keys })
  return keys
}

/** Index of the last key with key.t <= t, or 0 before the first key (its box holds there). */
function keyIndexAt(keys: readonly CoverKey[], t: number): number {
  let lo = 0
  let hi = keys.length - 1
  if (hi < 0 || t < keys[0].t) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (keys[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

const boxOf = (k: CoverKey): NormRect => ({ x: k.x, y: k.y, w: k.w, h: k.h })

/** The cover's box at source time `t`, or null outside [start, end). */
export function boxAt(cover: Cover, t: number): NormRect | null {
  if (!(t >= cover.start && t < cover.end)) return null
  const keys = pathKeys(cover)
  if (!keys.length) return null
  return boxOf(keys[keyIndexAt(keys, t)])
}

/**
 * The box drawn at picture time `t`: the union of the cover's boxes over [t − slack, t + slack]
 * within [start, end), or null when it is not active anywhere in that window (§4.2).
 */
export function drawnBox(cover: Cover, t: number, slack: number): NormRect | null {
  const from = Math.max(t - slack, cover.start)
  const to = Math.min(t + slack, cover.end)
  if (!(cover.start <= t + slack && cover.end > t - slack) || !(to >= from)) return null
  const keys = pathKeys(cover)
  if (!keys.length) return null
  let i = keyIndexAt(keys, from)
  let box = boxOf(keys[i])
  for (i += 1; i < keys.length && keys[i].t <= to && keys[i].t < cover.end; i++) box = unionBox(box, keys[i])
  return box
}

/** The slack a cover is drawn with at `fps` (§4.2): half a frame and a millisecond. */
export function coverSlack(fps: number): number {
  return 0.5 / (Number.isFinite(fps) && fps > 0 ? fps : 60) + 0.001
}

export function unionBox(a: NormRect, b: NormRect): NormRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

const sameBox = (a: NormRect, b: NormRect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/**
 * Keys for placements on analysed frames (§4.2): a key at each placement whose box differs from the
 * one before, and, when the two placements are more than one source frame apart, a union key at the
 * first source frame after the earlier one (its time plus one frame, rounded down to the
 * millisecond) holding both boxes, so every source frame between them is covered. The one function
 * that turns a walk's placements into keys.
 */
export function stepKeys(placements: readonly Placement[], fps: number): CoverKey[] {
  const frame = 1 / (Number.isFinite(fps) && fps > 0 ? fps : 60)
  const sorted = [...placements].filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t)
  const out: CoverKey[] = []
  let prev: Placement | null = null
  for (const p of sorted) {
    if (!prev) {
      out.push({ t: p.t, ...p.box })
      prev = p
      continue
    }
    if (p.t <= prev.t) {
      // Two placements at one time: one key holding both.
      const last = out[out.length - 1]
      Object.assign(last, unionBox(last, p.box))
      prev = { t: prev.t, box: boxOf(last) }
      continue
    }
    if (!sameBox(p.box, prev.box)) {
      if (p.t - prev.t > frame + 1e-6) {
        const at = Math.floor((prev.t + frame) * 1000 + 1e-6) / 1000
        if (at > prev.t && at < p.t) out.push({ t: at, ...unionBox(prev.box, p.box) })
      }
      out.push({ t: p.t, ...p.box })
    }
    prev = p
  }
  return out
}

/** Pairs of neighbouring keys merged into one at the first one's time holding both boxes. */
function halve(keys: readonly CoverKey[]): CoverKey[] {
  const out: CoverKey[] = []
  for (let i = 0; i < keys.length; i += 2) {
    const a = keys[i]
    const b = keys[i + 1]
    out.push(b ? { t: a.t, ...unionBox(a, b) } : { ...a })
  }
  return out
}

/** A cover's keys halved until there are at most `max` (only grows boxes). */
export function keysWithin(keys: readonly CoverKey[], max: number): CoverKey[] {
  let out = [...keys]
  while (out.length > Math.max(1, max)) out = halve(out)
  return out
}

/**
 * Merges neighbouring keys of the longest paths first until the total is at most `maxKeys` (§4.2):
 * the cover with the most keys has its keys merged in pairs, again and again, so no cover drops to
 * one key while a longer one keeps more. Merging only grows boxes. Covers left as they were are the
 * same objects.
 */
export function simplifyKeys(covers: readonly Cover[], maxKeys: number): Cover[] {
  const keys = covers.map((c) => pathKeys(c) as readonly CoverKey[])
  let total = keys.reduce((s, k) => s + k.length, 0)
  if (total <= maxKeys) return [...covers]
  // A max-heap of cover indices by key count.
  const heap: number[] = []
  const more = (a: number, b: number): boolean => keys[a].length > keys[b].length || (keys[a].length === keys[b].length && a < b)
  const up = (i: number): void => {
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!more(heap[i], heap[p])) break
      ;[heap[i], heap[p]] = [heap[p], heap[i]]
      i = p
    }
  }
  const down = (i: number): void => {
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < heap.length && more(heap[l], heap[m])) m = l
      if (r < heap.length && more(heap[r], heap[m])) m = r
      if (m === i) return
      ;[heap[i], heap[m]] = [heap[m], heap[i]]
      i = m
    }
  }
  keys.forEach((_k, i) => {
    heap.push(i)
    up(heap.length - 1)
  })
  const changed = new Set<number>()
  while (total > maxKeys && heap.length) {
    const i = heap[0]
    if (keys[i].length <= 1) break
    const next = halve(keys[i])
    total -= keys[i].length - next.length
    keys[i] = next
    changed.add(i)
    down(0)
  }
  return covers.map((c, i) => (changed.has(i) ? { ...c, path: writePath(keys[i]) } : c))
}
