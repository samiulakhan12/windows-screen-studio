import { cursorOverWindow, hiddenPoint, insideWindow, mapPointToWindowVideo, poseAt, type Size, type WindowPose } from '../../shared/recording/windowGeometry'
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
  /** Instants of typing key presses (which keys is never recorded). */
  typing?: number[]
  /** "Zoom here" hotkey presses. */
  marks?: number[]
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
  /**
   * Converts a captured position (Electron DIP on Windows) into the space of `poses`
   * (physical pixels), one point at a time; the identity when absent. Electron's DIP space
   * is not continuous across monitors with different scale factors, so a window straddling
   * two of them can only be mapped exactly in physical pixels.
   */
  pointToScreen?: (p: { x: number; y: number }) => { x: number; y: number }
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

/** Key presses at most this far apart (ms) belong to one typing burst. */
export const TYPING_GAP_MS = 1500
/** Fewer key presses than this are not a typing burst (a lone key, a quick "ok"). */
export const TYPING_MIN_KEYS = 3

/**
 * Groups typing key presses (epoch ms) into bursts: presses at most `gapMs` apart, with no
 * pause between them; presses made while paused are not recorded. Returns epoch-ms spans
 * from the first to the last press of each burst of at least `minKeys` presses.
 */
export function typingBursts(presses: number[], pauses: PauseSpan[], gapMs = TYPING_GAP_MS, minKeys = TYPING_MIN_KEYS): PauseSpan[] {
  const recorded = presses.filter((at) => !pauses.some((p) => at > p.from && at < p.to)).sort((a, b) => a - b)
  const out: PauseSpan[] = []
  let from = NaN
  let last = NaN
  let count = 0
  const close = (): void => {
    if (count >= minKeys) out.push({ from, to: last })
  }
  for (const at of recorded) {
    const split = count === 0 || at - last > gapMs || pauses.some((p) => p.to > last && p.from < at)
    if (split) {
      close()
      from = at
      count = 0
    }
    last = at
    count++
  }
  close()
  return out
}

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
 * shown (the window was minimised), and outside 0..1 where it is not over the recorded
 * content; `click` is null for clicks that are not on the recorded content (another
 * monitor, outside the area or the window, or on another window covering it).
 */
interface Placement {
  point(x: number, y: number, at: number): Point | null
  click(x: number, y: number, at: number): Point | null
  /**
   * Instants at which the recorded content moved on screen (a window was moved, resized
   * or restored) or the cursor went over or off it: a cursor standing still there still
   * moves (or appears, or disappears) in the video.
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
  const at = (t: number): WindowPose => poseAt(poses, t)
  return {
    // Also the instants the cursor went over or off a window covering the recorded one.
    moves: poses.slice(1).map((p) => p.at),
    point: (x, y, t) => {
      const pose = at(t)
      // Outside the window the cursor maps outside the video (the compositor hides it there).
      const p = mapPointToWindowVideo({ x, y }, pose, out)
      // Over another window covering the recorded one: not on the recorded content either.
      return p && !cursorOverWindow(pose) ? hiddenPoint(p) : p
    },
    click: (x, y, t) => {
      const pose = at(t)
      if (!insideWindow({ x, y }, pose) || !cursorOverWindow(pose)) return null
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
export function buildCursorTrack(captured: RawTrack, o: TrackOptions): CursorTrack {
  let raw = captured
  const time = (at: number): number => toSourceTime(at, o.startedAt, o.pauses)
  const recorded = (at: number): boolean => !o.pauses.some((p) => at > p.from && at < p.to)
  const end = o.duration + (o.slack ?? 0)
  const keys: KeyEvent[] = raw.keys
    .filter((k) => recorded(k.at))
    .map((k) => ({ t: time(k.at), label: k.label }))
    .filter((k) => k.t >= 0 && k.t <= end)
    .sort(byT)
  const shapes = buildShapes(o.shapes ?? [], time, end)
  // Marks and typing are about time only: kept even when positions cannot be placed.
  const input: Pick<CursorTrack, 'marks' | 'typing'> = {}
  if (raw.marks) {
    input.marks = raw.marks
      .filter(recorded)
      .map((at) => ({ t: time(at) }))
      .filter((m) => m.t >= 0 && m.t <= end)
      .sort(byT)
  }
  if (raw.typing) {
    input.typing = typingBursts(raw.typing, o.pauses)
      .map((b) => ({ t: time(b.from), end: time(b.to) }))
      // Typing before the start (the countdown) or after the end is cut off.
      .filter((b) => b.end >= 0 && b.t <= end)
      .map((b) => ({ t: Math.max(0, b.t), end: Math.min(end, b.end) }))
  }
  const invalid: CursorTrack = { samples: [], clicks: [], keys, shapes, ...input, scale: raw.scale, valid: false }
  let place: Placement
  if (o.window !== undefined && o.window !== null) {
    const { poses, out, pointToScreen } = o.window
    if (poses.length === 0 || !(out.width > 0 && out.height > 0)) return invalid
    place = windowPlacement(o.window)
    if (pointToScreen) {
      // Into the rectangles' space before anything is interpolated between positions.
      const conv = <T extends { x: number; y: number }>(p: T): T => ({ ...p, ...pointToScreen({ x: p.x, y: p.y }) })
      raw = { ...raw, samples: raw.samples.map(conv), clicks: raw.clicks.map(conv) }
    }
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
  return { samples: holdSamples(inside), clicks, keys, shapes, ...input, scale: raw.scale, valid: true }
}

/** Applies the final duration: clicks, keys and shapes up to it; samples get a little slack. */
export function clampTrack(track: CursorTrack, duration: number): CursorTrack {
  return {
    ...track,
    samples: track.samples.filter((s) => s.t <= duration + 0.5),
    clicks: track.clicks.filter((c) => c.t <= duration),
    keys: (track.keys ?? []).filter((k) => k.t <= duration),
    shapes: (track.shapes ?? []).filter((s) => s.t <= duration),
    ...(track.marks ? { marks: track.marks.filter((m) => m.t <= duration) } : {}),
    ...(track.typing ? { typing: track.typing.filter((b) => b.t <= duration).map((b) => ({ t: b.t, end: Math.min(b.end, duration) })) } : {})
  }
}
