/**
 * Gain automation on the OUTPUT timeline: fades and the music's ducking. Each is a
 * piecewise-linear gain curve. The preview schedules it as Web Audio ramps between the
 * curve's keyframes; the export evaluates the very same curve in ffmpeg (afade for fades,
 * a volume expression for ducking), so both sound the same.
 */
import { mergeRanges, type Range } from './activity'

/** A point of a piecewise-linear gain curve; between keyframes the gain changes linearly. */
export interface Keyframe {
  t: number
  gain: number
}

/** How music ducks under the recording's sound. */
export interface DuckShape {
  /** How far the music is lowered, 0 (not at all) .. 1 (to silence). */
  depth: number
  /** Seconds the music takes to go down; it starts this long before the sound (the export knows what comes). */
  attack: number
  /** Seconds the music takes to come back after the sound. */
  release: number
}

export const DUCK_TIMING = { attack: 0.15, release: 0.45 } as const

/**
 * Most ranges the music ducks for (about one every 0.7 s of an hour, the closest joined
 * ranges can be). A longer, busier recording has its closest ranges joined (limitRanges) in
 * the shared code, so the preview and the export still duck alike and the export's filter
 * stays a manageable size.
 */
export const MAX_DUCK_RANGES = 5000

const clip01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Fade gain at `t` of a `duration`-long sound: up over the first `fadeIn` seconds, down over the last `fadeOut`. */
export function fadeGainAt(t: number, duration: number, fadeIn: number, fadeOut: number): number {
  const up = fadeIn > 0 ? clip01(t / fadeIn) : 1
  const down = fadeOut > 0 ? clip01((duration - t) / fadeOut) : 1
  return up * down
}

/** Fade lengths that fit inside `duration` (each at most the whole length). */
export function fitFades(duration: number, fadeIn: number, fadeOut: number): { fadeIn: number; fadeOut: number } {
  const d = Math.max(0, duration)
  const ok = (v: number): number => (Number.isFinite(v) ? Math.min(d, Math.max(0, v)) : 0)
  return { fadeIn: ok(fadeIn), fadeOut: ok(fadeOut) }
}

/** Keyframes of fadeGainAt over [0, duration]. */
export function fadeKeyframes(duration: number, fadeIn: number, fadeOut: number): Keyframe[] {
  const f = fitFades(duration, fadeIn, fadeOut)
  const ts = [0, f.fadeIn, duration - f.fadeOut, duration].filter((t) => t >= 0 && t <= duration)
  return keyframesAt(ts, (t) => fadeGainAt(t, duration, f.fadeIn, f.fadeOut))
}

/** Ramp lengths actually used: never zero, so the curve stays continuous (a 1 ms ramp is a step to the ear). */
const ramps = (shape: Pick<DuckShape, 'attack' | 'release'>): { a: number; r: number } => ({ a: Math.max(1e-3, shape.attack), r: Math.max(1e-3, shape.release) })

/**
 * The ranges music actually ducks for: activity ranges (output seconds) joined where the
 * music would not have time to come back up in between (shorter than attack + release).
 */
export function duckRanges(activity: readonly Range[], shape: Pick<DuckShape, 'attack' | 'release'>): Range[] {
  const { a, r } = ramps(shape)
  return mergeRanges(activity, a + r)
}

/** How ducked (0..1) the music is at `t` for already joined `ranges` (a trapezoid per range). */
export function duckAmount(ranges: readonly Range[], t: number, shape: Pick<DuckShape, 'attack' | 'release'>): number {
  const { a, r } = ramps(shape)
  let sum = 0
  for (const g of ranges) {
    if (t < g.start - a || t > g.end + r) continue
    sum += clip01((t - (g.start - a)) / a) * clip01((g.end + r - t) / r)
  }
  return Math.min(1, sum)
}

/** Music gain at `t` with ducking (1 = not ducked). */
export const duckGainAt = (ranges: readonly Range[], t: number, shape: DuckShape): number => 1 - shape.depth * duckAmount(ranges, t, shape)

/**
 * Keyframes of duckGainAt over [0, duration] (exact: the curve is linear between them), in
 * time linear in the number of ranges: joined ranges never overlap, so each one's corners
 * (fully up before the attack, fully down from its start to its end, up again after the
 * release) are known without looking at the others.
 */
export function duckKeyframes(ranges: readonly Range[], duration: number, shape: DuckShape): Keyframe[] {
  const joined = duckRanges(ranges, shape)
  const { a, r } = ramps(shape)
  const down = 1 - shape.depth
  const points: Keyframe[] = [{ t: 0, gain: duckGainAt(joined, 0, shape) }]
  for (const g of joined) {
    points.push({ t: g.start - a, gain: 1 }, { t: g.start, gain: down }, { t: g.end, gain: down }, { t: g.end + r, gain: 1 })
  }
  points.push({ t: duration, gain: duckGainAt(joined, duration, shape) })
  return keyframesOf(points.filter((k) => k.t >= 0 && k.t <= duration))
}

/** Index of the first keyframe at or after `t` (binary search; keys.length when none). */
export function keyIndexAt(keys: readonly Keyframe[], t: number): number {
  let lo = 0
  let hi = keys.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keys[mid].t >= t) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Gain at `t` of a keyframed curve (held before the first and after the last keyframe). */
export function gainAt(keys: readonly Keyframe[], t: number): number {
  if (keys.length === 0) return 1
  if (t <= keys[0].t) return keys[0].gain
  const i = keyIndexAt(keys, t)
  if (i >= keys.length) return keys[keys.length - 1].gain
  const b = keys[i]
  const prev = keys[i - 1]
  return b.t > prev.t ? prev.gain + ((b.gain - prev.gain) * (t - prev.t)) / (b.t - prev.t) : b.gain
}

/** Sorted, de-duplicated times with the curve's value at each; collinear points are dropped. */
function keyframesAt(times: number[], value: (t: number) => number): Keyframe[] {
  return keyframesOf(times.map((t) => ({ t, gain: value(t) })))
}

/** To a millionth (times that close are one keyframe). */
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6

/** Points of a curve (times may repeat with the same value), sorted and rounded, corners only. */
function keyframesOf(points: readonly Keyframe[]): Keyframe[] {
  const seen = new Set<number>()
  const keys: Keyframe[] = []
  for (const p of points) {
    const t = round6(p.t)
    if (seen.has(t)) continue
    seen.add(t)
    keys.push({ t, gain: round6(p.gain) })
  }
  keys.sort((x, y) => x.t - y.t)
  return keys.filter((k, i) => {
    if (i === 0 || i === keys.length - 1) return true
    const a = keys[i - 1]
    const b = keys[i + 1]
    // Keep corners only.
    return Math.abs(a.gain + ((b.gain - a.gain) * (k.t - a.t)) / (b.t - a.t) - k.gain) > 1e-6
  })
}

/** Compact decimal for ffmpeg arguments. */
const num = (v: number): string => String(+v.toFixed(4))
/** `t` minus `v` in an ffmpeg expression (never "t--0.1"). */
const tMinus = (v: number): string => (v < 0 ? `t+${num(-v)}` : `t-${num(v)}`)

/**
 * The ducked gain as an ffmpeg expression in `t` (for `volume=eval=frame`), exactly
 * duckGainAt: 1 minus depth times the trapezoid of the range around `t`. Joined ranges never
 * overlap (their trapezoids are at least attack + release apart), so a binary search on `t`
 * picks the only one that can be non-zero: each evaluation costs log N comparisons, also for
 * a long recording with thousands of ranges. Contains commas: quote it in a filtergraph.
 */
export function duckExpression(activity: readonly Range[], shape: DuckShape): string {
  const ranges = duckRanges(activity, shape)
  if (ranges.length === 0 || shape.depth <= 0) return '1'
  const { a, r } = ramps(shape)
  const term = (g: Range): string => `clip((${tMinus(g.start - a)})/${num(a)},0,1)*clip((${num(g.end + r)}-t)/${num(r)},0,1)`
  const tree = (lo: number, hi: number): string => {
    if (hi - lo === 1) return term(ranges[lo])
    const mid = (lo + hi) >> 1
    const split = (ranges[mid - 1].end + r + ranges[mid].start - a) / 2
    return `if(lt(t,${num(split)}),${tree(lo, mid)},${tree(mid, hi)})`
  }
  return `1-${num(Math.min(1, shape.depth))}*${tree(0, ranges.length)}`
}
