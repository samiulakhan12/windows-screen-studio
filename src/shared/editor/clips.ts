import { clamp } from '../engine/math'
import { clampZooms } from '../engine/zoom'
import {
  clipIndexAt,
  MIN_CLIP,
  newClipId,
  normalizeClips,
  outputDuration,
  outputToSource,
  playableFrom,
  sourceToOutput,
  splitAt
} from '../engine/timeline'
import type { Clip, Project } from '../types'

/**
 * Editor-side helpers on top of the pure clip engine. The timeline is drawn in
 * source time, so anything that is not inside a clip is a gap: trimmed off at
 * either end, or cut out of the middle.
 */

export interface Gap {
  kind: 'trim-start' | 'cut' | 'trim-end'
  start: number
  end: number
}

const EPS = 1e-6

export function timelineGaps(clips: Clip[], duration: number): Gap[] {
  const gaps: Gap[] = []
  if (clips[0].start > EPS) gaps.push({ kind: 'trim-start', start: 0, end: clips[0].start })
  for (let i = 1; i < clips.length; i++) {
    if (clips[i].start - clips[i - 1].end > EPS) gaps.push({ kind: 'cut', start: clips[i - 1].end, end: clips[i].start })
  }
  const last = clips[clips.length - 1]
  if (duration - last.end > EPS) gaps.push({ kind: 'trim-end', start: last.end, end: duration })
  return gaps
}

/**
 * Puts the source range [start, end) back into the edit. Neighbouring clips with
 * the same speed are merged; otherwise the restored footage plays at 1x.
 */
export function restoreRange(clips: Clip[], start: number, end: number, duration: number): Clip[] {
  const a = clamp(Math.min(start, end), 0, duration)
  const b = clamp(Math.max(start, end), 0, duration)
  if (b - a < EPS) return clips
  const before = clips.filter((c) => c.end <= a + EPS)
  const after = clips.filter((c) => c.start >= b - EPS)
  const inside = clips.filter((c) => c.end > a + EPS && c.start < b - EPS)
  const left = before[before.length - 1]
  const right = after[0]
  const touchesLeft = !!left && Math.abs(left.end - a) < EPS
  const touchesRight = !!right && Math.abs(right.start - b) < EPS
  // Only a pure gap is restored; partially kept ranges keep their own clips.
  if (inside.length > 0) {
    const out = [...clips]
    let cursor = a
    for (const c of inside) {
      if (c.start - cursor > EPS) out.push({ id: newClipId(), start: cursor, end: c.start, speed: 1 })
      cursor = Math.max(cursor, c.end)
    }
    if (b - cursor > EPS) out.push({ id: newClipId(), start: cursor, end: b, speed: 1 })
    return normalizeClips(out, duration)
  }
  if (touchesLeft && touchesRight && left.speed === right.speed) {
    return [...before.slice(0, -1), { ...left, end: right.end }, ...after.slice(1)]
  }
  if (touchesLeft && left.speed === 1) return [...before.slice(0, -1), { ...left, end: b }, ...after]
  if (touchesRight && right.speed === 1) return [...before, { ...right, start: a }, ...after.slice(1)]
  return [...before, { id: newClipId(), start: a, end: b, speed: 1 }, ...after]
}

/**
 * Applies `speed` to the source range [start, end), splitting clips at its ends.
 * Range ends closer than MIN_CLIP to a clip edge snap to that edge, since a split
 * there would leave a sliver (and splitAt refuses it).
 */
export function setRangeSpeed(clips: Clip[], start: number, end: number, speed: number): Clip[] {
  const snap = (t: number): number => {
    for (const c of clips) {
      if (Math.abs(t - c.start) < MIN_CLIP) return c.start
      if (Math.abs(t - c.end) < MIN_CLIP) return c.end
    }
    return t
  }
  const a = snap(Math.min(start, end))
  const b = snap(Math.max(start, end))
  const split = splitAt(splitAt(clips, a), b)
  return split.map((c) => (c.start >= a - EPS && c.end <= b + EPS ? { ...c, speed } : c))
}

/**
 * Source time of the frame the preview shows when the playhead is at `t`:
 * inside a cut it is the next kept frame, past the end it is the last one.
 */
export function displayTime(clips: Clip[], t: number): number {
  const p = playableFrom(clips, t)
  if (p) return p.time
  return clips[clips.length - 1].end
}

/** Output (exported video) time for a playhead at source time `t`. */
export function outputTimeAt(clips: Clip[], t: number): number {
  const s = displayTime(clips, t)
  return sourceToOutput(clips, s) ?? outputDuration(clips)
}

/** Moves the playhead by `delta` seconds of *output* time, skipping cuts. */
export function stepOutput(clips: Clip[], t: number, delta: number): number {
  const o = clamp(outputTimeAt(clips, t) + delta, 0, outputDuration(clips))
  return outputToSource(clips, o).time
}

export function clipAt(clips: Clip[], t: number): Clip | null {
  const i = clipIndexAt(clips, t)
  return i < 0 ? null : clips[i]
}

/** True when a split at `t` would create two clips (not inside a cut, not too close to an edge). */
export function canSplitAt(clips: Clip[], t: number): boolean {
  const c = clipAt(clips, t)
  return !!c && t - c.start >= MIN_CLIP && c.end - t >= MIN_CLIP
}

/**
 * Reconciles a project with the media file actually on disk. MediaRecorder timing
 * and the capture track's reported size can differ slightly from the encoded file;
 * the file wins. Clips that ended at the old duration follow the new one.
 */
export function correctProjectMedia(project: Project, media: { duration: number; width: number; height: number }): Project {
  let next = project
  if (media.width > 0 && media.height > 0 && (project.width !== media.width || project.height !== media.height)) {
    next = { ...next, width: media.width, height: media.height }
  }
  const d = media.duration
  if (Number.isFinite(d) && d > 0 && Math.abs(project.duration - d) > 1e-3) {
    const clips = project.clips.map((c) => (Math.abs(c.end - project.duration) < 0.05 || c.end > d ? { ...c, end: d } : c))
    next = {
      ...next,
      duration: d,
      clips: normalizeClips(clips, d),
      zooms: clampZooms(project.zooms, d),
      annotations: project.annotations
        .map((a) => ({ ...a, start: clamp(a.start, 0, d), end: clamp(a.end, 0, d) }))
        .filter((a) => a.end - a.start >= 0.05)
    }
  }
  return next
}
