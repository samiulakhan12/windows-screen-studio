import { clamp } from '../engine/math'

/**
 * Horizontal scale of the timeline (pixels per source second). "Fit" shows the
 * whole recording; zooming in is capped so one 60 fps frame is a few pixels wide.
 */
export const MAX_PX_PER_SEC = 400
export const ZOOM_STEP = 1.5

export function fitScale(viewportPx: number, duration: number): number {
  return Math.max(1e-3, viewportPx) / Math.max(1e-3, duration)
}

export function clampScale(pxPerSec: number, fit: number): number {
  return clamp(pxPerSec, fit, Math.max(fit, MAX_PX_PER_SEC))
}

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/** Ruler tick interval (seconds) so labels are at least `minSpacingPx` apart. */
export function tickStep(pxPerSec: number, minSpacingPx = 72): number {
  return STEPS.find((s) => s * pxPerSec >= minSpacingPx) ?? STEPS[STEPS.length - 1]
}

/** Tick times in [from, to] for a given step (inclusive, aligned to multiples of the step). */
export function ticksIn(from: number, to: number, step: number): number[] {
  const out: number[] = []
  const first = Math.max(0, Math.ceil(from / step - 1e-9))
  for (let i = first; i * step <= to + 1e-9; i++) out.push(+(i * step).toFixed(3))
  return out
}

/** Ruler label: "m:ss", with tenths when the ticks are closer than a second. */
export function formatTick(t: number, step: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  const whole = Math.floor(s + 1e-6)
  const base = `${m}:${whole.toString().padStart(2, '0')}`
  return step < 1 ? `${base}.${Math.round((s - whole) * 10) % 10}` : base
}

/** New scroll offset that keeps the time under `anchorX` (viewport px) fixed while zooming. */
export function scrollForZoom(oldPx: number, newPx: number, scrollLeft: number, anchorX: number): number {
  const t = (scrollLeft + anchorX) / oldPx
  return Math.max(0, t * newPx - anchorX)
}

/**
 * Scroll offset that keeps a playhead at `x` (content px) in view, paging forward
 * like a DAW, or null when it is already visible.
 */
export function followScroll(x: number, scrollLeft: number, viewport: number, margin = 24): number | null {
  if (viewport <= 0) return null
  if (x < scrollLeft + margin * 0.5) return Math.max(0, x - viewport * 0.1)
  if (x > scrollLeft + viewport - margin) return Math.max(0, x - viewport * 0.1)
  return null
}

/** Time window worth rendering for a scroll position (one viewport of overscan on each side). */
export function renderWindow(scrollLeft: number, viewport: number, pxPerSec: number, duration: number): { start: number; end: number } {
  const start = (scrollLeft - viewport) / pxPerSec
  const end = (scrollLeft + 2 * viewport) / pxPerSec
  return { start: Math.max(0, start), end: Math.min(duration, end) }
}

export const overlaps = (a: { start: number; end: number }, w: { start: number; end: number }): boolean => a.end >= w.start && a.start <= w.end
