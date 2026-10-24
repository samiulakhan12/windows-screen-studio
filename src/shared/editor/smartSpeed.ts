/**
 * Smart speed: finds the idle parts of a recording, where the picture stays still (ffmpeg
 * freezedetect in the main process), nothing is heard (the audio pack's sound activity) and
 * nothing is done with the mouse or keyboard, and speeds them up or cuts them. Everything here
 * is in source seconds; only parts still in the video count. Pure, so the Clip panel's list and
 * its Apply button agree exactly.
 *
 * Its "Silences" mode finds the pauses where nothing is heard instead, measured as the video
 * plays them (after cuts and speed changes), and keeps a little of each pause next to the sound.
 */
import { rangesToOutput } from '../audio/activity'
import { clamp } from '../engine/math'
import { cutRange, outputDuration } from '../engine/timeline'
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

/** The parts of [0, duration] outside `ranges`. */
export function rangeGaps(ranges: readonly TimeRange[], duration: number): TimeRange[] {
  const gaps: TimeRange[] = []
  let at = 0
  for (const r of intersectRanges(ranges, [{ start: 0, end: duration }])) {
    if (r.start - at > EPS) gaps.push({ start: at, end: r.start })
    at = r.end
  }
  if (duration - at > EPS) gaps.push({ start: at, end: duration })
  return gaps
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
  /**
   * Stretches where the recording is heard (sourceActivity: someone talking over a still
   * screen is not idle), or null/absent when that is not known (no sound, or not measured):
   * then the picture and the input decide.
   */
  sound?: readonly TimeRange[] | null
  clips: readonly Clip[]
  duration: number
}

/**
 * Idle parts in the video: still AND silent AND without input, at least `minIdle` seconds of it
 * in the video, with up to IDLE_PAD seconds left at normal speed at each end (less for short parts).
 */
export function findIdleRanges(input: IdleInput, minIdle: number): TimeRange[] {
  const whole = [{ start: 0, end: input.duration }]
  const still = intersectRanges(mergeRanges(input.still, STILL_MERGE_GAP), whole)
  const quiet = input.sound ? intersectRanges(still, rangeGaps(input.sound, input.duration)) : still
  const idle = input.inactive ? intersectRanges(quiet, input.inactive) : quiet
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

/* ---------- Silences ---------- */

/** Shortest pause (seconds of the video) the Silences mode acts on: the slider's range and default. */
export const SILENCE_LENGTH = { min: 0.5, max: 5, step: 0.1, default: 1 } as const
/** Silence kept next to the sound at each end of a pause (seconds of the video), so speech is never clipped. */
export const SILENCE_PADDING = { min: 0.15, max: 0.5, step: 0.05, default: 0.25 } as const

export interface SilenceSettings {
  /** Pauses shorter than this (output seconds) are left alone. */
  minLength: number
  /** Silence kept next to the sound at each end (output seconds). */
  padding: number
}

export interface SilencePart extends SmartSpeedPart {
  /**
   * The source ranges the action applies to, padding taken off: one, or several when the
   * pause runs across a cut. `start` and `end` span all of them.
   */
  pieces: TimeRange[]
  /** How long the whole pause plays in the video now (output seconds, padding included). */
  length: number
}

export interface SilencePlan {
  parts: SilencePart[]
  /** Output seconds saved in all. */
  saved: number
}

/**
 * The source ranges of kept clips that play during output seconds [from, to]; ranges of
 * neighbouring clips that touch are joined, so only a cut separates two of them.
 */
export function outputToSourceRanges(clips: readonly Clip[], from: number, to: number): TimeRange[] {
  const out: TimeRange[] = []
  let at = 0
  for (const c of clips) {
    const length = (c.end - c.start) / c.speed
    const s = Math.max(from, at)
    const e = Math.min(to, at + length)
    if (e - s > EPS) out.push({ start: c.start + (s - at) * c.speed, end: c.start + (e - at) * c.speed })
    at += length
    if (at >= to) break
  }
  return mergeRanges(out)
}

/**
 * The pauses of the video: stretches of the output where `sound` (source seconds, where the
 * recording is heard) is silent for at least `minLength`, measured as the video plays them, so
 * a pause running across a cut is one pause and a sped-up one is shorter. Each loses `padding`
 * at an end that meets sound (not at the very start or end of the video), and comes back as the
 * source ranges to act on. Nothing when nothing is heard at all: then there is no sound to keep.
 */
export function findSilences(sound: readonly TimeRange[], clips: readonly Clip[], settings: SilenceSettings): Omit<SilencePart, 'saved'>[] {
  const list = [...clips]
  const total = outputDuration(list)
  const heard = rangesToOutput(sound, list).filter((r) => r.end - r.start > EPS)
  if (heard.length === 0 || total <= EPS) return []
  const minLength = Math.max(0.05, Number.isFinite(settings.minLength) ? settings.minLength : SILENCE_LENGTH.default)
  const padding = clamp(Number.isFinite(settings.padding) ? settings.padding : SILENCE_PADDING.default, 0, 10)
  const out: Omit<SilencePart, 'saved'>[] = []
  for (const gap of rangeGaps(heard, total)) {
    const length = gap.end - gap.start
    if (length < minLength - EPS) continue
    const from = gap.start + (gap.start > EPS ? padding : 0)
    const to = gap.end - (gap.end < total - EPS ? padding : 0)
    if (to - from <= EPS) continue
    const pieces = outputToSourceRanges(list, from, to)
    if (pieces.length === 0) continue
    out.push({ start: pieces[0].start, end: pieces[pieces.length - 1].end, pieces, length })
  }
  return out
}

/** The pauses worth acting on (they save time with `action`), and what each saves. */
export function planSilences(sound: readonly TimeRange[], clips: readonly Clip[], settings: SilenceSettings, action: SmartSpeedAction): SilencePlan {
  const parts = findSilences(sound, clips, settings)
    .map((p) => ({ ...p, saved: p.pieces.reduce((s, r) => s + rangeSaving(r, clips, action), 0) }))
    .filter((p) => p.saved >= MIN_SAVING)
  return { parts, saved: parts.reduce((s, p) => s + p.saved, 0) }
}
