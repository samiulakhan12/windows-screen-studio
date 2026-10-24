/**
 * Smart speed: finds the idle parts of a recording, where the picture stays still (ffmpeg
 * freezedetect in the main process) and nothing is done with the mouse or keyboard, and speeds
 * them up or cuts them. Everything here is in source seconds; only parts still in the video
 * count. Pure, so the Clip panel's list and its Apply button agree exactly.
 */
import { clamp } from '../engine/math'
import { cutRange } from '../engine/timeline'
import type { Clip, CursorTrack } from '../types'
import { setRangeSpeed } from './clips'

export interface TimeRange {
  start: number
  end: number
}

/** Speed idle parts up this much, or cut them. */
export type SmartSpeedAction = 2 | 4 | 8 | 'cut'

export const SMART_SPEED_ACTIONS: readonly SmartSpeedAction[] = [2, 4, 8, 'cut']

/** Minimum idle lengths offered (seconds). */
export const MIN_IDLE_CHOICES: readonly number[] = [1, 2, 3, 5, 10]
export const DEFAULT_MIN_IDLE = 3

/** Shortest still stretch asked of the analysis; longer minimums are applied here. */
export const STILL_DETECT_MIN = 0.5

/** Normal-speed time kept at each end of an idle part, so a pause still reads as one. */
export const IDLE_PAD = 0.5
/** Still stretches this close together are one: a clock ticking over is not activity. */
const STILL_MERGE_GAP = 0.3
/** Cursor moves shorter than this (normalised to the screen) are hand jitter, not input. */
const MOVE_EPS = 0.004
/** A click, key press or move keeps the moment around it busy (half before, half after). */
const INPUT_SPAN = 0.1
/** Parts that would save less than this are not worth listing. */
const MIN_SAVING = 0.05

const EPS = 1e-6

/** Sorted, overlapping or touching (closer than `gap`) ranges joined; empty ones dropped. */
export function mergeRanges(ranges: readonly TimeRange[], gap = 0): TimeRange[] {
  const sorted = ranges.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start).sort((a, b) => a.start - b.start)
  const out: TimeRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start - last.end <= gap + EPS) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

/** Parts covered by both lists (each list is merged first). */
export function intersectRanges(a: readonly TimeRange[], b: readonly TimeRange[]): TimeRange[] {
  const x = mergeRanges(a)
  const y = mergeRanges(b)
  const out: TimeRange[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    const start = Math.max(x[i].start, y[j].start)
    const end = Math.min(x[i].end, y[j].end)
    if (end - start > EPS) out.push({ start, end })
    if (x[i].end < y[j].end) i++
    else j++
  }
  return out
}

/** The parts of the recording that are in the video (clips next to each other are one part). */
export function keptRanges(clips: readonly Clip[]): TimeRange[] {
  return mergeRanges(clips.map((c) => ({ start: c.start, end: c.end })))
}

/**
 * Stretches of [0, duration] with no input: no cursor movement (beyond jitter), clicks,
 * shortcuts, typing or "zoom here" marks. Null when the recording has no input data (a
 * window recorded without the native helper), since then nothing is known about input.
 */
export function inputGaps(track: CursorTrack, duration: number): TimeRange[] | null {
  if (!track.valid) return null
  const activity: TimeRange[] = []
  const at = (t: number): void => void activity.push({ start: t - INPUT_SPAN / 2, end: t + INPUT_SPAN / 2 })
  // Movement is measured from where the cursor last counted as moving, so slow drags add up.
  let anchor: { x: number; y: number } | null = null
  for (const s of track.samples) {
    if (!anchor) {
      anchor = s
      continue
    }
    if (Math.hypot(s.x - anchor.x, s.y - anchor.y) > MOVE_EPS) {
      at(s.t)
      anchor = s
    }
  }
  for (const c of track.clicks) at(c.t)
  for (const k of track.keys ?? []) at(k.t)
  for (const m of track.marks ?? []) at(m.t)
  for (const b of track.typing ?? []) activity.push({ start: b.t - INPUT_SPAN / 2, end: Math.max(b.t, b.end) + INPUT_SPAN / 2 })
  const busy = activity
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({ start: clamp(r.start, 0, duration), end: clamp(r.end, 0, duration) }))
    .sort((a, b) => a.start - b.start)
  const gaps: TimeRange[] = []
  let cursor = 0
  for (const r of busy) {
    if (r.start - cursor > EPS) gaps.push({ start: cursor, end: r.start })
    cursor = Math.max(cursor, r.end)
  }
  if (duration - cursor > EPS) gaps.push({ start: cursor, end: duration })
  return gaps
}

export interface IdleInput {
  /** Still-picture stretches from the analysis. */
  still: readonly TimeRange[]
  /** Stretches without input (inputGaps), or null when unknown: then the picture alone decides. */
  inactive: readonly TimeRange[] | null
  clips: readonly Clip[]
  duration: number
}

/**
 * Idle parts in the video: still AND without input, at least `minIdle` seconds of it in the
 * video, with up to IDLE_PAD seconds left at normal speed at each end (less for short parts).
 */
export function findIdleRanges(input: IdleInput, minIdle: number): TimeRange[] {
  const whole = [{ start: 0, end: input.duration }]
  const still = intersectRanges(mergeRanges(input.still, STILL_MERGE_GAP), whole)
  const idle = input.inactive ? intersectRanges(still, input.inactive) : still
  const out: TimeRange[] = []
  for (const r of intersectRanges(idle, keptRanges(input.clips))) {
    const length = r.end - r.start
    if (length < minIdle - EPS) continue
    const pad = Math.min(IDLE_PAD, length * 0.2)
    out.push({ start: r.start + pad, end: r.end - pad })
  }
  return out
}

/** Output seconds `action` saves on `range`, given the clips' current speeds. */
export function rangeSaving(range: TimeRange, clips: readonly Clip[], action: SmartSpeedAction): number {
  let saved = 0
  for (const c of clips) {
    const len = Math.min(range.end, c.end) - Math.max(range.start, c.start)
    if (len <= EPS) continue
    saved += action === 'cut' ? len / c.speed : Math.max(0, len / c.speed - len / action)
  }
  return saved
}

export interface SmartSpeedPart extends TimeRange {
  /** Output seconds saved by applying the action to this part. */
  saved: number
}

export interface SmartSpeedPlan {
  parts: SmartSpeedPart[]
  /** Output seconds saved in all. */
  saved: number
}

/** The idle parts worth acting on (they save time with `action`), and what they save. */
export function planSmartSpeed(input: IdleInput, minIdle: number, action: SmartSpeedAction): SmartSpeedPlan {
  const parts = findIdleRanges(input, minIdle)
    .map((r) => ({ ...r, saved: rangeSaving(r, input.clips, action) }))
    .filter((p) => p.saved >= MIN_SAVING)
  return { parts, saved: parts.reduce((s, p) => s + p.saved, 0) }
}

/**
 * The clips with `action` applied to `ranges`: each part of a range that plays slower than the
 * new speed is sped up (faster parts are left alone), or the ranges are cut. A cut never
 * removes the last of the video.
 */
export function applySmartSpeed(clips: Clip[], ranges: readonly TimeRange[], action: SmartSpeedAction): Clip[] {
  let out = clips
  for (const r of mergeRanges(ranges)) {
    if (action === 'cut') {
      out = cutRange(out, r.start, r.end)
      continue
    }
    const pieces = out
      .filter((c) => c.speed < action && Math.min(r.end, c.end) - Math.max(r.start, c.start) > EPS)
      .map((c) => ({ start: Math.max(r.start, c.start), end: Math.min(r.end, c.end) }))
    for (const p of pieces) out = setRangeSpeed(out, p.start, p.end, action)
  }
  return out
}
