import { insideWindow, mapPointToWindowVideo, poseIndexAt, type Size, type WindowPose } from '../../shared/recording/windowGeometry'
import type { ClickEvent, CursorSample, CursorShape, CursorShapeEvent, CursorTrack, KeyEvent, NormRect } from '../../shared/types'

/** A paused interval in epoch ms. */
export interface PauseSpan {
  from: number
  to: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Cursor and input events as captured: epoch ms and DIP screen coordinates. */
export interface RawTrack {
  samples: { at: number; x: number; y: number }[]
  clicks: { at: number; x: number; y: number; button: ClickEvent['button'] }[]
  keys: { at: number; label: string }[]
  /**
   * DIP bounds of the captured display; null for window captures (their positions are
   * global DIP screen coordinates, mapped through TrackOptions.window).
   */
  bounds: Rect | null
  /** Display scale factor of the captured monitor. */
  scale: number
}

/** How a window recording maps screen positions into its video. */
export interface WindowMapping {
  /** The window's rectangle over time (epoch ms, the same clock as the samples). */
  poses: WindowPose[]
  /** Size of the video the window content is fitted into (the proxy's output size). */
  out: Size
}

export interface TrackOptions {
  /** Epoch ms of the video timeline start. */
  startedAt: number
  pauses: PauseSpan[]
  /** Recorded duration in seconds. */
  duration: number
  /** Recorded part of the display (normalised); positions are remapped into it. */
  region: NormRect | null
  /** Cursor shape changes (native capture), epoch ms. */
  shapes?: { at: number; shape: CursorShape }[]
  /** Extra seconds kept after `duration` while the final duration is still unknown. */
  slack?: number
  /**
   * Window recordings: positions are mapped through the window's rectangle at each
   * instant instead of a display (`region` is ignored). Without poses there is no
   * cursor data (positions cannot be placed in the video).
   */
  window?: WindowMapping | null
}

/**
 * Seconds of recorded (non-paused) time at epoch `at`. An instant inside a pause
 * maps to the pause start, so a state change made while paused applies on resume.
 */
export function toSourceTime(at: number, startedAt: number, pauses: PauseSpan[]): number {
  let ms = at - startedAt
  for (const p of pauses) {
    if (p.to <= at) ms -= p.to - p.from
    else if (p.from < at) ms -= at - p.from
  }
  return ms / 1000
}

const byT = <T extends { t: number }>(a: T, b: T): number => a.t - b.t

export const inUnitSquare = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1

/**
 * Adds a sample just before each movement that follows a pause in sampling, so
 * linear interpolation holds the cursor still instead of drifting across the gap
 * (event-driven sampling only reports movement).
 */
export function holdSamples(samples: CursorSample[], maxGap = 0.05): CursorSample[] {
  const out: CursorSample[] = []
  for (const s of samples) {
    const prev = out[out.length - 1]
    if (prev && s.t - prev.t > maxGap) out.push({ t: s.t - 1 / 120, x: prev.x, y: prev.y })
    out.push(s)
  }
  return out
}

function buildShapes(raw: { at: number; shape: CursorShape }[], time: (at: number) => number, end: number): CursorShapeEvent[] {
  const timed = raw.map((s) => ({ t: Math.max(0, time(s.at)), shape: s.shape })).sort(byT)
  const out: CursorShapeEvent[] = []
  for (const s of timed) {
    if (s.t > end) break
    const last = out[out.length - 1]
    // Same instant (e.g. everything before the start): the later change wins.
    if (last && last.t === s.t) last.shape = s.shape
    else out.push({ ...s })
  }
  return out.filter((s, i) => i === 0 || s.shape !== out[i - 1].shape)
}

type Point = { x: number; y: number }

/**
 * Where each captured position lands in the video. `point` is null when it cannot be
 * shown (the window was minimised); `click` is false for clicks that are not on the
 * recorded content (another monitor, outside the area or the window).
 */
interface Placement {
  point(x: number, y: number, at: number): Point | null
  click(x: number, y: number, at: number): Point | null
  /**
   * Instants at which the recorded content moved on screen (a window was moved, resized
   * or restored): a cursor standing still there still moves in the video.
   */
  moves?: number[]
}

function displayPlacement(b: Rect, r: NormRect | null): Placement {
  const local = (x: number, y: number): Point => {
    const nx = (x - b.x) / b.width
    const ny = (y - b.y) / b.height
    return r ? { x: (nx - r.x) / r.w, y: (ny - r.y) / r.h } : { x: nx, y: ny }
  }
  return {
    point: local,
    click: (x, y) => {
      const p = local(x, y)
      return inUnitSquare(p) ? p : null
    }
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

function windowPlacement({ poses, out }: WindowMapping): Placement {
  const poseAt = (at: number): WindowPose => poses[poseIndexAt(poses, at)]
  return {
    moves: poses.slice(1).map((p) => p.at),
    // Outside the window the cursor maps outside the content (the compositor hides it there).
    point: (x, y, at) => mapPointToWindowVideo({ x, y }, poseAt(at), out),
    click: (x, y, at) => {
      const pose = poseAt(at)
      if (!insideWindow({ x, y }, pose)) return null
      const p = mapPointToWindowVideo({ x, y }, pose, out)
      // On the window's edge rounding can land a hair outside 0..1.
      return p && { x: clamp01(p.x), y: clamp01(p.y) }
    }
  }
}

/**
 * The cursor's screen position at any instant, interpolated between the captured
 * samples as the editor does; null without samples.
 */
function rawPositionAt(samples: RawTrack['samples']): (at: number) => Point | null {
  const sorted = [...samples].sort((a, b) => a.at - b.at)
  return (at) => {
    if (sorted.length === 0) return null
    let lo = 0
    let hi = sorted.length - 1
    // Last sample at or before `at`.
    let i = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid].at <= at) {
        i = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (i < 0) return { x: sorted[0].x, y: sorted[0].y }
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!b || b.at === a.at) return { x: a.x, y: a.y }
    const k = (at - a.at) / (b.at - a.at)
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
  }
}

/** Converts captured events into the project's cursor track (source seconds, normalised positions). */
export function buildCursorTrack(raw: RawTrack, o: TrackOptions): CursorTrack {
  const time = (at: number): number => toSourceTime(at, o.startedAt, o.pauses)
  const recorded = (at: number): boolean => !o.pauses.some((p) => at > p.from && at < p.to)
  const end = o.duration + (o.slack ?? 0)
  const keys: KeyEvent[] = raw.keys
    .filter((k) => recorded(k.at))
    .map((k) => ({ t: time(k.at), label: k.label }))
    .filter((k) => k.t >= 0 && k.t <= end)
    .sort(byT)
  const shapes = buildShapes(o.shapes ?? [], time, end)
  const invalid: CursorTrack = { samples: [], clicks: [], keys, shapes, scale: raw.scale, valid: false }
  let place: Placement
  if (o.window !== undefined && o.window !== null) {
    const { poses, out } = o.window
    if (poses.length === 0 || !(out.width > 0 && out.height > 0)) return invalid
    place = windowPlacement(o.window)
  } else {
    const b = raw.bounds
    if (!b || b.width <= 0 || b.height <= 0) return invalid
    place = displayPlacement(b, o.region)
  }

  const timed: CursorSample[] = []
  const add = (x: number, y: number, at: number): void => {
    // Positions while a recorded window is minimised are not in the video: dropped.
    const p = place.point(x, y, at)
    if (p) timed.push({ t: time(at), ...p })
  }
  for (const s of raw.samples) if (recorded(s.at)) add(s.x, s.y, s.at)
  if (place.moves) {
    // Where the content moved under the cursor (and after each pause, when it may have
    // moved meanwhile), add the cursor's position there: samples are only taken when the
    // cursor itself moves.
    const screenAt = rawPositionAt(raw.samples)
    for (const at of [...place.moves, ...o.pauses.map((p) => p.to)]) {
      const c = recorded(at) ? screenAt(at) : null
      if (c) add(c.x, c.y, at)
    }
  }
  timed.sort(byT)
  const before = timed.filter((s) => s.t < 0).pop()
  const inside = timed.filter((s) => s.t >= 0 && s.t <= end)
  // The last position seen before the start is where the cursor was at t = 0.
  if (before && (inside.length === 0 || inside[0].t > 0)) inside.unshift({ ...before, t: 0 })
  const clicks: ClickEvent[] = []
  for (const c of raw.clicks) {
    if (!recorded(c.at)) continue
    // Clicks on other monitors, outside the area or the window cannot be zoomed into.
    const p = place.click(c.x, c.y, c.at)
    const t = time(c.at)
    if (p && t >= 0 && t <= end) clicks.push({ t, button: c.button, ...p })
  }
  clicks.sort(byT)
  return { samples: holdSamples(inside), clicks, keys, shapes, scale: raw.scale, valid: true }
}

/** Applies the final duration: clicks, keys and shapes up to it; samples get a little slack. */
export function clampTrack(track: CursorTrack, duration: number): CursorTrack {
  return {
    ...track,
    samples: track.samples.filter((s) => s.t <= duration + 0.5),
    clicks: track.clicks.filter((c) => c.t <= duration),
    keys: (track.keys ?? []).filter((k) => k.t <= duration),
    shapes: (track.shapes ?? []).filter((s) => s.t <= duration)
  }
}
