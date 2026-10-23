import type { Clip } from '../types'
import { clamp } from './math'

/**
 * Edit timeline: the output video is `clips` played back to back, each at its own
 * speed. Everything else in a project (zooms, annotations, cursor, clicks) lives
 * in *source* time, so cutting or re-timing never moves overlays off their content.
 */

export const MIN_CLIP = 0.1
export const MIN_SPEED = 0.25
export const MAX_SPEED = 8
export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8]

let idCounter = 0
export const newClipId = (): string => `c${Date.now().toString(36)}${(idCounter++).toString(36)}`

export function fullClip(duration: number, id = newClipId()): Clip {
  return { id, start: 0, end: duration, speed: 1 }
}

/** Sorted, clamped to [0, duration], non-overlapping, at least MIN_CLIP long; never empty. */
export function normalizeClips(clips: Clip[], duration: number): Clip[] {
  const sorted = [...clips].sort((a, b) => a.start - b.start)
  const out: Clip[] = []
  for (const c of sorted) {
    const prevEnd = out.length ? out[out.length - 1].end : 0
    const start = clamp(Math.max(c.start, prevEnd), 0, duration)
    const end = clamp(c.end, 0, duration)
    if (end - start >= MIN_CLIP - 1e-9) out.push({ ...c, start, end, speed: clamp(c.speed || 1, MIN_SPEED, MAX_SPEED) })
  }
  return out.length ? out : [fullClip(duration, clips[0]?.id)]
}

const clipLength = (c: Clip): number => (c.end - c.start) / c.speed

export function outputDuration(clips: Clip[]): number {
  return clips.reduce((sum, c) => sum + clipLength(c), 0)
}

/** First kept source time and last kept source time. */
export function keptBounds(clips: Clip[]): { start: number; end: number } {
  return { start: clips[0].start, end: clips[clips.length - 1].end }
}

/** Index of the clip containing source time `s` (end-exclusive), or -1 when `s` is cut. */
export function clipIndexAt(clips: Clip[], s: number): number {
  for (let i = 0; i < clips.length; i++) {
    if (s >= clips[i].start && s < clips[i].end) return i
  }
  return -1
}

/** Output time at which source time `s` is shown, or null when `s` was cut. */
export function sourceToOutput(clips: Clip[], s: number): number | null {
  let acc = 0
  for (const c of clips) {
    if (s >= c.start && s < c.end) return acc + (s - c.start) / c.speed
    acc += clipLength(c)
  }
  const last = clips[clips.length - 1]
  return Math.abs(s - last.end) < 1e-9 ? acc : null
}

/** Source time shown at output time `o` (clamped to the edit), and the clip index. */
export function outputToSource(clips: Clip[], o: number): { time: number; index: number } {
  let acc = 0
  const target = Math.max(0, o)
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    const len = clipLength(c)
    if (target < acc + len) return { time: c.start + (target - acc) * c.speed, index: i }
    acc += len
  }
  const last = clips.length - 1
  return { time: clips[last].end, index: last }
}

/**
 * Where playback should continue from source time `s`: `s` itself when it is kept,
 * the start of the next clip when `s` falls in a cut, or null past the end.
 */
export function playableFrom(clips: Clip[], s: number): { time: number; index: number } | null {
  for (let i = 0; i < clips.length; i++) {
    if (s < clips[i].start) return { time: clips[i].start, index: i }
    if (s < clips[i].end) return { time: s, index: i }
  }
  return null
}

/** Source times of each output frame for an export at `fps` (sampled at frame starts). */
export function exportFrameTimes(clips: Clip[], fps: number): number[] {
  const count = Math.max(1, Math.round(outputDuration(clips) * fps))
  const times: number[] = new Array(count)
  let ci = 0
  let clipOutStart = 0
  for (let i = 0; i < count; i++) {
    const o = i / fps
    while (ci < clips.length - 1 && o >= clipOutStart + clipLength(clips[ci]) - 1e-9) {
      clipOutStart += clipLength(clips[ci])
      ci++
    }
    const c = clips[ci]
    times[i] = Math.min(c.start + (o - clipOutStart) * c.speed, c.end)
  }
  return times
}

/** Splits the clip under source time `s` into two clips; no-op if it would create a sliver. */
export function splitAt(clips: Clip[], s: number): Clip[] {
  const i = clipIndexAt(clips, s)
  if (i < 0) return clips
  const c = clips[i]
  if (s - c.start < MIN_CLIP || c.end - s < MIN_CLIP) return clips
  return [...clips.slice(0, i), { ...c, end: s }, { ...c, id: newClipId(), start: s }, ...clips.slice(i + 1)]
}

/** Removes a clip (a cut). The last remaining clip cannot be removed. */
export function removeClip(clips: Clip[], id: string): Clip[] {
  if (clips.length <= 1) return clips
  return clips.filter((c) => c.id !== id)
}

/** Cuts the source range [from, to) out of the edit, splitting clips as needed. */
export function cutRange(clips: Clip[], from: number, to: number): Clip[] {
  const a = Math.min(from, to)
  const b = Math.max(from, to)
  const out: Clip[] = []
  for (const c of clips) {
    if (c.end <= a || c.start >= b) {
      out.push(c)
      continue
    }
    if (c.start < a && a - c.start >= MIN_CLIP) out.push({ ...c, end: a })
    if (c.end > b && c.end - b >= MIN_CLIP) out.push({ ...c, id: c.start < a ? newClipId() : c.id, start: b })
  }
  return out.length ? out : clips
}

export function setClipSpeed(clips: Clip[], id: string, speed: number): Clip[] {
  return clips.map((c) => (c.id === id ? { ...c, speed: clamp(speed, MIN_SPEED, MAX_SPEED) } : c))
}

/** Moves the start of the edit (trim in). Earlier clips that end before `s` are dropped. */
export function setTrimStart(clips: Clip[], s: number): Clip[] {
  const lastEnd = clips[clips.length - 1].end
  const start = clamp(s, 0, lastEnd - MIN_CLIP)
  const kept = clips.filter((c) => c.end - MIN_CLIP > start)
  const first = kept[0] ?? clips[clips.length - 1]
  return [{ ...first, start: Math.min(start, first.end - MIN_CLIP) }, ...kept.slice(1)]
}

/** Moves the end of the edit (trim out). Later clips that start after `e` are dropped. */
export function setTrimEnd(clips: Clip[], e: number, duration: number): Clip[] {
  const firstStart = clips[0].start
  const end = clamp(e, firstStart + MIN_CLIP, duration)
  const kept = clips.filter((c) => c.start + MIN_CLIP < end)
  const last = kept[kept.length - 1] ?? clips[0]
  return [...kept.slice(0, -1), { ...last, end: Math.max(end, last.start + MIN_CLIP) }]
}

/**
 * Splits atempo into a chain within ffmpeg's supported 0.5..2 per-filter range
 * (e.g. 8 -> "atempo=2,atempo=2,atempo=2").
 */
export function atempoChain(speed: number): string {
  const parts: string[] = []
  let s = speed
  while (s > 2 + 1e-9) {
    parts.push('atempo=2')
    s /= 2
  }
  while (s < 0.5 - 1e-9) {
    parts.push('atempo=0.5')
    s /= 0.5
  }
  if (Math.abs(s - 1) > 1e-9 || parts.length === 0) parts.push(`atempo=${+s.toFixed(6)}`)
  return parts.join(',')
}
