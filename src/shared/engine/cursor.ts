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

/**
 * Cursor opacity for "hide when idle": fades out after `idleAfter` seconds without
 * movement and fades back in as soon as it moves.
 */
export function cursorOpacity(samples: CursorSample[], t: number, idleAfter = 2, fade = 0.3): number {
  if (samples.length < 2) return 1
  const i = lowerIndex(samples, t)
  if (i <= 0) return 1
  const eps = 0.0015
  const ref = samples[i]
  let lastMove = samples[0].t
  for (let j = i; j > 0; j--) {
    const p = samples[j - 1]
    if (Math.abs(p.x - ref.x) > eps || Math.abs(p.y - ref.y) > eps) {
      lastMove = samples[j].t
      break
    }
  }
  const idle = t - lastMove - idleAfter
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
