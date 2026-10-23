import type { ClickEvent, CursorSample } from '../types'
import { clamp, easeOutCubic, lerp, lowerIndex } from './math'

/** Linear interpolation of a raw cursor track at time `t`. */
export function cursorAt(samples: CursorSample[], t: number): { x: number; y: number } | null {
  if (samples.length === 0) return null
  const i = lowerIndex(samples, t)
  if (i < 0) return { x: samples[0].x, y: samples[0].y }
  if (i >= samples.length - 1) return { x: samples[i].x, y: samples[i].y }
  const a = samples[i]
  const b = samples[i + 1]
  const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t)
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) }
}

/**
 * A cursor path pre-simulated with a critically damped spring at a fixed rate.
 * Pre-computing makes the result a pure function of time, so scrubbing and export
 * always show exactly the same motion as playback.
 */
export class SmoothedTrack {
  readonly hz: number
  readonly xs: Float32Array
  readonly ys: Float32Array

  constructor(samples: CursorSample[], duration: number, smoothing: number, hz = 120) {
    this.hz = hz
    const n = Math.max(1, Math.ceil(duration * hz) + 1)
    this.xs = new Float32Array(n)
    this.ys = new Float32Array(n)
    if (samples.length === 0) {
      this.xs.fill(0.5)
      this.ys.fill(0.5)
      return
    }
    // Natural frequency: high = snappy (little smoothing), low = floaty.
    const omega = lerp(40, 5, clamp(smoothing, 0, 1))
    const dt = 1 / hz
    let x = samples[0].x
    let y = samples[0].y
    let vx = 0
    let vy = 0
    for (let i = 0; i < n; i++) {
      const target = cursorAt(samples, i * dt)!
      const ax = omega * omega * (target.x - x) - 2 * omega * vx
      const ay = omega * omega * (target.y - y) - 2 * omega * vy
      vx += ax * dt
      vy += ay * dt
      x += vx * dt
      y += vy * dt
      this.xs[i] = x
      this.ys[i] = y
    }
  }

  at(t: number): { x: number; y: number } {
    const f = clamp(t * this.hz, 0, this.xs.length - 1)
    const i = Math.floor(f)
    const j = Math.min(i + 1, this.xs.length - 1)
    const k = f - i
    return { x: lerp(this.xs[i], this.xs[j], k), y: lerp(this.ys[i], this.ys[j], k) }
  }
}

/** Movement smaller than this (normalised units, per axis) does not count as moving. */
const STILL_EPS = 0.0015

/**
 * For each sample i, the time the cursor last moved as of that sample: the time of
 * the earliest sample of the stretch ending at i whose samples all lie within
 * STILL_EPS of sample i (per axis), i.e. one past the nearest earlier sample that
 * does not. This equals scanning back from i sample by sample, but costs
 * O(n log n) for the whole track instead of O(stretch) per lookup.
 *
 * Nearest earlier sample with `x[k] - x[i] > eps`: only samples greater than every
 * later sample can be the nearest such (a later, at least as large sample would be
 * nearer), so a stack of those, decreasing in x, is binary-searched with the exact
 * same floating-point comparison as the scan. Likewise for the three other bounds.
 */
function lastMoveTimes(samples: CursorSample[]): Float64Array {
  const n = samples.length
  const out = new Float64Array(n)
  const xs = Float64Array.from(samples, (s) => s.x)
  const ys = Float64Array.from(samples, (s) => s.y)
  const bounds = [new Bound(xs, true), new Bound(xs, false), new Bound(ys, true), new Bound(ys, false)]
  let outside = -1
  for (let i = 0; i < n; i++) {
    if (i > 0 && xs[i] === xs[i - 1] && ys[i] === ys[i - 1]) {
      // Same position as the previous sample (a still cursor polled again): same answer.
      for (const b of bounds) b.replaceTop(i)
    } else {
      outside = -1
      for (const b of bounds) outside = Math.max(outside, b.nearestOutside(i))
      for (const b of bounds) b.push(i)
    }
    out[i] = samples[outside + 1].t
  }
  return out
}

/** One side of the stillness box along one axis (see lastMoveTimes). */
class Bound {
  private readonly stack: Int32Array
  private size = 0

  constructor(
    private readonly v: Float64Array,
    /** true: looks for earlier values more than eps above; false: below. */
    private readonly above: boolean
  ) {
    this.stack = new Int32Array(v.length)
  }

  /** Nearest earlier index whose value is more than STILL_EPS beyond v[i] on this side, or -1. */
  nearestOutside(i: number): number {
    const { v, stack, above } = this
    const ref = v[i]
    // Bottom-up, the stack's values approach ref, so the matches form a prefix: find its end.
    let lo = 0
    let hi = this.size - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const k = stack[mid]
      if (above ? v[k] - ref > STILL_EPS : ref - v[k] > STILL_EPS) {
        found = k
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found
  }

  /** Adds i, dropping the samples it dominates (no further out on this side, and older). */
  push(i: number): void {
    const { v, stack, above } = this
    const ref = v[i]
    while (this.size > 0 && (above ? v[stack[this.size - 1]] <= ref : v[stack[this.size - 1]] >= ref)) this.size--
    stack[this.size++] = i
  }

  /** i repeats the value on top of the stack (pushed last): it replaces it. */
  replaceTop(i: number): void {
    this.stack[this.size - 1] = i
  }
}

/** Per-track cache: tracks are loaded once and never mutated, so this is built once per track. */
const lastMoveCache = new WeakMap<CursorSample[], Float64Array>()

/**
 * Cursor opacity for "hide when idle": fades out after `idleAfter` seconds without
 * movement and fades back in as soon as it moves. O(log n) per call.
 */
export function cursorOpacity(samples: CursorSample[], t: number, idleAfter = 2, fade = 0.3): number {
  if (samples.length < 2) return 1
  const i = lowerIndex(samples, t)
  if (i <= 0) return 1
  let lastMove = lastMoveCache.get(samples)
  if (!lastMove || lastMove.length !== samples.length) {
    lastMove = lastMoveTimes(samples)
    lastMoveCache.set(samples, lastMove)
  }
  const idle = t - lastMove[i] - idleAfter
  return idle <= 0 ? 1 : clamp(1 - idle / fade, 0, 1)
}

/** Clicks whose ripple is visible at `t`, with animation progress 0..1. */
export function activeClicks(clicks: ClickEvent[], t: number, duration = 0.45): { click: ClickEvent; progress: number }[] {
  const out: { click: ClickEvent; progress: number }[] = []
  for (const click of clicks) {
    const dt = t - click.t
    if (dt >= 0 && dt <= duration) out.push({ click, progress: easeOutCubic(dt / duration) })
  }
  return out
}

/** Scale pulse applied to the cursor sprite around a click (1 = normal). */
export function clickPulse(clicks: ClickEvent[], t: number): number {
  let s = 1
  for (const c of clicks) {
    const dt = t - c.t
    if (dt > -0.08 && dt < 0.25) {
      const k = dt < 0 ? (dt + 0.08) / 0.08 : 1 - dt / 0.25
      s = Math.min(s, 1 - 0.2 * k)
    }
  }
  return s
}
