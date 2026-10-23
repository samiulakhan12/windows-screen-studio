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
  /** DIP bounds of the captured display; null for window captures (positions unknown). */
  bounds: Rect | null
  /** Display scale factor of the captured monitor. */
  scale: number
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
  const b = raw.bounds
  if (!b || b.width <= 0 || b.height <= 0) return { samples: [], clicks: [], keys, shapes, scale: raw.scale, valid: false }

  const r = o.region
  const local = (x: number, y: number): { x: number; y: number } => {
    const nx = (x - b.x) / b.width
    const ny = (y - b.y) / b.height
    return r ? { x: (nx - r.x) / r.w, y: (ny - r.y) / r.h } : { x: nx, y: ny }
  }
  const timed = raw.samples
    .filter((s) => recorded(s.at))
    .map((s) => ({ t: time(s.at), ...local(s.x, s.y) }))
    .sort(byT)
  const before = timed.filter((s) => s.t < 0).pop()
  const inside = timed.filter((s) => s.t >= 0 && s.t <= end)
  // The last position seen before the start is where the cursor was at t = 0.
  if (before && (inside.length === 0 || inside[0].t > 0)) inside.unshift({ ...before, t: 0 })
  const clicks: ClickEvent[] = raw.clicks
    .filter((c) => recorded(c.at))
    .map((c) => ({ t: time(c.at), button: c.button, ...local(c.x, c.y) }))
    // Clicks on other monitors or outside the region cannot be zoomed into.
    .filter((c) => c.t >= 0 && c.t <= end && inUnitSquare(c))
    .sort(byT)
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
