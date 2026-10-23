import type { ClickEvent, ZoomSegment } from '../types'
import type { SmoothedTrack } from './cursor'
import { clamp, easeInOutCubic, lerp } from './math'

export const ZOOM_TRANSITION = 0.7

export interface AutoZoomOptions {
  scale: number
  /** Clicks closer than this (seconds) share one zoom segment. */
  clusterGap: number
  leadIn: number
  hold: number
  minDuration: number
}

export const DEFAULT_AUTO_ZOOM: AutoZoomOptions = {
  scale: 1.8,
  clusterGap: 3,
  leadIn: 0.9,
  hold: 1.8,
  minDuration: 2.2
}

let idCounter = 0
export const newZoomId = (): string => `z${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** Builds zoom segments from click clusters: zoom in just before a click, hold, ease out. */
export function generateAutoZooms(
  clicks: ClickEvent[],
  duration: number,
  options: Partial<AutoZoomOptions> = {}
): ZoomSegment[] {
  const o = { ...DEFAULT_AUTO_ZOOM, ...options }
  const sorted = clicks.filter((c) => c.button === 'left').sort((a, b) => a.t - b.t)
  const ranges: { start: number; end: number }[] = []
  for (const c of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && c.t - (last.end - o.hold) <= o.clusterGap) {
      last.end = c.t + o.hold
    } else {
      ranges.push({ start: c.t - o.leadIn, end: c.t + o.hold })
    }
  }
  const segments: ZoomSegment[] = []
  for (const r of ranges) {
    let start = clamp(r.start, 0, duration)
    let end = clamp(Math.max(r.end, start + o.minDuration), 0, duration)
    if (end - start < 2 * ZOOM_TRANSITION) {
      start = clamp(end - 2 * ZOOM_TRANSITION, 0, duration)
      end = clamp(start + 2 * ZOOM_TRANSITION, 0, duration)
    }
    const prev = segments[segments.length - 1]
    // Merge segments whose transitions would overlap, to avoid a zoom-out/in "dip".
    if (prev && start - prev.end < ZOOM_TRANSITION) {
      prev.end = end
      continue
    }
    if (end - start > 0.2) {
      segments.push({ id: newZoomId(), start, end, scale: o.scale, focus: { mode: 'cursor' }, auto: true })
    }
  }
  return segments
}

/** Envelope 0..1 of a segment at time t (eased ramps at both ends). */
export function segmentEnvelope(seg: ZoomSegment, t: number, transition = ZOOM_TRANSITION): number {
  if (t <= seg.start || t >= seg.end) return 0
  const tr = Math.min(transition, (seg.end - seg.start) / 2)
  const rampIn = easeInOutCubic((t - seg.start) / tr)
  const rampOut = easeInOutCubic((seg.end - t) / tr)
  return Math.min(rampIn, rampOut)
}

export interface Camera {
  /** Zoom factor (1 = whole frame). */
  scale: number
  /** Viewport centre in normalised source coordinates. */
  cx: number
  cy: number
}

/**
 * Camera at time `t`. Focus follows a heavily smoothed cursor path (`focusTrack`)
 * and is clamped so the zoomed viewport never shows anything outside the recording.
 */
export function cameraAt(zooms: ZoomSegment[], t: number, focusTrack: SmoothedTrack | null): Camera {
  let best: ZoomSegment | null = null
  let env = 0
  for (const z of zooms) {
    const e = segmentEnvelope(z, t)
    if (e > env) {
      env = e
      best = z
    }
  }
  if (!best || env <= 0) return { scale: 1, cx: 0.5, cy: 0.5 }
  const scale = lerp(1, best.scale, env)
  let fx = 0.5
  let fy = 0.5
  if (best.focus.mode === 'fixed') {
    fx = best.focus.x
    fy = best.focus.y
  } else if (focusTrack) {
    const p = focusTrack.at(t)
    fx = p.x
    fy = p.y
  }
  const half = 0.5 / scale
  const cx = clamp(lerp(0.5, fx, env), half, 1 - half)
  const cy = clamp(lerp(0.5, fy, env), half, 1 - half)
  return { scale, cx, cy }
}

/** Keeps segments sorted, inside [0, duration] and non-overlapping. */
export function normalizeZooms(zooms: ZoomSegment[], duration: number): ZoomSegment[] {
  const sorted = [...zooms].sort((a, b) => a.start - b.start)
  const out: ZoomSegment[] = []
  for (const z of sorted) {
    const prev = out[out.length - 1]
    const start = clamp(Math.max(z.start, prev ? prev.end : 0), 0, duration)
    const end = clamp(z.end, 0, duration)
    if (end - start >= 0.3) out.push({ ...z, start, end, scale: clamp(z.scale, 1.05, 5) })
  }
  return out
}
