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

/** Keyframes of duckGainAt over [0, duration] (exact: the curve is linear between them). */
export function duckKeyframes(ranges: readonly Range[], duration: number, shape: DuckShape): Keyframe[] {
  const { a, r } = ramps(shape)
  const ts = [0, duration]
  for (const g of ranges) ts.push(g.start - a, g.start, g.end, g.end + r)
  return keyframesAt(
    ts.filter((t) => t >= 0 && t <= duration),
    (t) => duckGainAt(ranges, t, shape)
  )
}

/** Gain at `t` of a keyframed curve (held before the first and after the last keyframe). */
export function gainAt(keys: readonly Keyframe[], t: number): number {
  if (keys.length === 0) return 1
  if (t <= keys[0].t) return keys[0].gain
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]
    if (t <= b.t) {
      const a = keys[i - 1]
      return b.t > a.t ? a.gain + ((b.gain - a.gain) * (t - a.t)) / (b.t - a.t) : b.gain
    }
  }
  return keys[keys.length - 1].gain
}

/** Sorted, de-duplicated times with the curve's value at each; collinear points are dropped. */
function keyframesAt(times: number[], value: (t: number) => number): Keyframe[] {
  const ts = [...new Set(times.map((t) => +t.toFixed(6)))].sort((a, b) => a - b)
  const keys = ts.map((t) => ({ t, gain: +value(t).toFixed(6) }))
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
