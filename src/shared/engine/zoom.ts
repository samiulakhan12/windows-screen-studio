import type { ClickEvent, ZoomFocus, ZoomSegment } from '../types'
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

/**
 * Left clicks that landed on the captured display. Clicks on other monitors are
 * normalised outside 0..1 and must never become zooms aimed at the frame edge.
 */
export function isUsableClick(c: ClickEvent): boolean {
  return c.button === 'left' && Number.isFinite(c.t) && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1
}

/** Builds zoom segments from click clusters: zoom in just before a click, hold, ease out. */
export function generateAutoZooms(
  clicks: ClickEvent[],
  duration: number,
  options: Partial<AutoZoomOptions> = {}
): ZoomSegment[] {
  const o = { ...DEFAULT_AUTO_ZOOM, ...options }
  const sorted = clicks.filter(isUsableClick).sort((a, b) => a.t - b.t)
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

/* ---------- Editing helpers: they never move or drop segments other than the one edited ---------- */

/** Shortest zoom the timeline lets the user drag a segment down to. */
export const MIN_ZOOM_LENGTH = 0.6
/** Shortest zoom that "add zoom" creates; a smaller free gap is refused with a hint. */
export const MIN_NEW_ZOOM = 1
export const DEFAULT_NEW_ZOOM = 3

export const zoomAt = (zooms: ZoomSegment[], t: number): ZoomSegment | null =>
  zooms.find((z) => t >= z.start && t < z.end) ?? null

export type InsertZoomResult =
  | { ok: true; zooms: ZoomSegment[]; id: string }
  | { ok: false; reason: 'inside'; id: string }
  | { ok: false; reason: 'no-room' }

/**
 * Adds a zoom covering time `at`, fitted into the free gap around it. `lead` is
 * how long before `at` the zoom starts, so it is fully zoomed in at `at`.
 * Existing segments are never changed: inside an existing zoom the result names
 * that zoom instead, and a gap shorter than MIN_NEW_ZOOM is refused.
 */
export function insertZoom(
  zooms: ZoomSegment[],
  at: number,
  duration: number,
  options: { lead?: number; length?: number; scale?: number; focus?: ZoomFocus } = {}
): InsertZoomResult {
  const t = clamp(at, 0, duration)
  const hit = zoomAt(zooms, t)
  if (hit) return { ok: false, reason: 'inside', id: hit.id }
  const length = Math.max(MIN_NEW_ZOOM, options.length ?? DEFAULT_NEW_ZOOM)
  const gapStart = Math.max(0, ...zooms.filter((z) => z.end <= t).map((z) => z.end))
  const gapEnd = Math.min(duration, ...zooms.filter((z) => z.start > t).map((z) => z.start))
  let start = Math.max(gapStart, t - clamp(options.lead ?? 0, 0, length))
  const end = Math.min(gapEnd, start + length)
  // Close to the next zoom (or the end), grow backwards into the free space instead.
  if (end - start < length) start = Math.max(gapStart, end - length)
  if (end - start < MIN_NEW_ZOOM - 1e-9) return { ok: false, reason: 'no-room' }
  const id = newZoomId()
  const seg: ZoomSegment = { id, start, end, scale: options.scale ?? 2, focus: options.focus ?? { mode: 'cursor' }, auto: false }
  return { ok: true, id, zooms: [...zooms, seg].sort((a, b) => a.start - b.start) }
}

/** Range a segment may be dragged within without overlapping its neighbours. */
export function zoomDragBounds(zooms: ZoomSegment[], id: string, duration: number): { lower: number; upper: number } {
  const seg = zooms.find((z) => z.id === id)
  if (!seg) return { lower: 0, upper: duration }
  const others = zooms.filter((z) => z.id !== id)
  const lower = Math.max(0, ...others.filter((z) => z.end <= seg.start + 1e-6).map((z) => z.end))
  const upper = Math.min(duration, ...others.filter((z) => z.start >= seg.end - 1e-6).map((z) => z.start))
  return { lower, upper }
}

/** New start/end for a move or edge drag by `dt` seconds, kept between the neighbours. */
export function dragZoomTimes(
  initial: { start: number; end: number },
  mode: 'move' | 'start' | 'end',
  dt: number,
  bounds: { lower: number; upper: number }
): { start: number; end: number } {
  let { start, end } = initial
  if (mode === 'move') {
    const len = end - start
    start = clamp(start + dt, bounds.lower, Math.max(bounds.lower, bounds.upper - len))
    end = start + len
  } else if (mode === 'start') {
    start = clamp(start + dt, bounds.lower, end - MIN_ZOOM_LENGTH)
  } else {
    end = clamp(end + dt, start + MIN_ZOOM_LENGTH, bounds.upper)
  }
  return { start, end }
}

/**
 * Clamps segments into [0, duration] after the media duration was corrected.
 * Unlike normalizeZooms it never shifts a segment because of its neighbours.
 */
export function clampZooms(zooms: ZoomSegment[], duration: number): ZoomSegment[] {
  const out: ZoomSegment[] = []
  for (const z of zooms) {
    const start = clamp(z.start, 0, duration)
    const end = clamp(z.end, 0, duration)
    if (end - start >= 0.05) out.push(start === z.start && end === z.end ? z : { ...z, start, end })
  }
  return out
}

/**
 * Replaces every automatic zoom with a fresh set generated from the clicks.
 * Zooms the user created or edited (auto: false) are kept as they are, and new
 * automatic zooms that would overlap them are skipped.
 */
export function regenerateAutoZooms(
  zooms: ZoomSegment[],
  clicks: ClickEvent[],
  duration: number
): { zooms: ZoomSegment[]; removed: number; added: number; kept: number } {
  const manual = zooms.filter((z) => !z.auto)
  const fresh = generateAutoZooms(clicks, duration).filter((a) => !manual.some((m) => a.start < m.end && a.end > m.start))
  return {
    zooms: [...manual, ...fresh].sort((a, b) => a.start - b.start),
    removed: zooms.length - manual.length,
    added: fresh.length,
    kept: manual.length
  }
}
