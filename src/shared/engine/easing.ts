/**
 * Easing curves for zoom transitions (ZoomEasing). Each maps progress 0..1 to 0..1 with
 * f(0) = 0 and f(1) = 1 exactly, starts from rest (no jump in speed when a move begins,
 * except 'linear'), and never dips below 0, so a zoom never shows outside the recording
 * on the way in. Only 'bouncy' passes 1 (a slight overshoot before settling).
 */
import type { ZoomEasing } from '../types'
import { clamp, easeInOutCubic } from './math'

/** CSS-style cubic-bezier(x1, y1, x2, y2) timing function (x1, x2 in 0..1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s
  const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s
  const slopeX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx
  return (x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    // Newton steps from a good guess, then bisection if the slope is too flat.
    let s = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x
      if (Math.abs(err) < 1e-7) return sampleY(s)
      const d = slopeX(s)
      if (Math.abs(d) < 1e-6) break
      s -= err / d
    }
    let lo = 0
    let hi = 1
    s = x
    for (let i = 0; i < 40; i++) {
      const v = sampleX(s)
      if (Math.abs(v - x) < 1e-7) break
      if (v < x) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return sampleY(s)
  }
}

/** Quick start, long gentle landing. */
const snappyCurve = cubicBezier(0.3, 0, 0, 1)

/**
 * Damped spring released from rest: rises quickly, passes the target by about 5% halfway
 * through, then settles. The tiny residual at x = 1 is folded back in so it lands exactly.
 */
const SPRING_DECAY = 5.83
const SPRING_FREQ = 2 * Math.PI
const springRaw = (x: number): number =>
  1 - Math.exp(-SPRING_DECAY * x) * (Math.cos(SPRING_FREQ * x) + (SPRING_DECAY / SPRING_FREQ) * Math.sin(SPRING_FREQ * x))
const SPRING_END = springRaw(1)
const spring = (x: number): number => springRaw(x) + (1 - SPRING_END) * x * x * x

/** The same spring critically damped: the bouncy feel without passing the target. */
const DAMPED_RATE = 9
const dampedRaw = (x: number): number => 1 - (1 + DAMPED_RATE * x) * Math.exp(-DAMPED_RATE * x)
const DAMPED_END = dampedRaw(1)
const damped = (x: number): number => dampedRaw(x) + (1 - DAMPED_END) * x * x * x

/** Most a 'bouncy' transition passes its target (fraction of the move). */
export const BOUNCY_OVERSHOOT = 0.06

/**
 * Progress of a transition with `easing` at x (0..1, clamped). `overshoot: false` asks
 * for a curve that never passes 1 (used where passing the target would show outside
 * the recording, e.g. 'bouncy' returning to the full frame).
 */
export function ease(easing: ZoomEasing | undefined, x: number, overshoot = true): number {
  const t = clamp(x, 0, 1)
  if (t === 0 || t === 1) return t
  switch (easing) {
    case 'linear':
      return t
    case 'snappy':
      return snappyCurve(t)
    case 'bouncy':
      return overshoot ? spring(t) : damped(t)
    default:
      return easeInOutCubic(t)
  }
}

export const ZOOM_EASINGS: { value: ZoomEasing; label: string; title: string }[] = [
  { value: 'smooth', label: 'Smooth', title: 'Eases in and out evenly' },
  { value: 'snappy', label: 'Snappy', title: 'Moves quickly, lands softly' },
  { value: 'bouncy', label: 'Bouncy', title: 'Springs slightly past and settles' },
  { value: 'linear', label: 'Linear', title: 'Constant speed' }
]
