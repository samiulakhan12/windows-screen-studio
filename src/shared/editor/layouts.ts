import { layoutRamps } from '../engine/layout'
import { clamp } from '../engine/math'
import { keptBounds } from '../engine/timeline'
import { MIN_LAYOUT_LENGTH } from '../engine/webcamData'
import type { CameraLayout, Clip, LayoutSegment, Project } from '../types'
import { displayTime } from './clips'

/** Default length (seconds) of a new layout segment. */
export const DEFAULT_LAYOUT_LENGTH = 5
/** A new segment shorter than this (seconds) has no room. */
const MIN_NEW_SEGMENT = 0.3

let idCounter = 0
const newId = (): string => `y${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** The layouts, as the Camera panel and the timeline name and describe them. */
export const LAYOUT_OPTIONS: { value: CameraLayout; label: string; short: string; hint: string }[] = [
  { value: 'default', label: 'Default', short: 'Default', hint: 'The screen with the camera bubble' },
  { value: 'camera-large', label: 'Large camera', short: 'Large', hint: 'A big camera over the screen' },
  { value: 'side-by-side', label: 'Side by side', short: 'Side by side', hint: 'The screen and a tall camera card next to each other' },
  { value: 'camera-only', label: 'Camera only', short: 'Camera', hint: 'The camera fills the frame; the screen is hidden' },
  { value: 'screen-only', label: 'Screen only', short: 'Screen', hint: 'The camera is hidden' }
]

export const layoutLabel = (layout: CameraLayout): string => LAYOUT_OPTIONS.find((o) => o.value === layout)?.label ?? 'Default'

/** The camera layout in effect at source time `t`. */
export function layoutAt(project: Pick<Project, 'layouts'>, t: number): CameraLayout {
  return project.layouts?.find((s) => t >= s.start && t < s.end)?.layout ?? 'default'
}

/** A new layout segment starting at `t`, clamped to the recording. */
export function createLayoutSegment(layout: CameraLayout, t: number, duration: number): LayoutSegment {
  const start = Math.max(0, Math.min(t, duration - 0.1))
  return { id: newId(), layout, start, end: Math.min(duration, start + DEFAULT_LAYOUT_LENGTH) }
}

/** The segment containing source time `t`, if any. */
export const layoutSegmentAt = (layouts: LayoutSegment[] | undefined, t: number): LayoutSegment | null =>
  layouts?.find((s) => t >= s.start && t < s.end) ?? null

/*
 * A layout change "at the playhead" (the Camera panel, a double-click on the camera track and the
 * editor's commands all go through these): it goes where the preview shows the playhead, so a
 * playhead in a cut adds it on the next kept frame and one at the end of the video on its last
 * frame, and it is fitted into the video that is kept (a trimmed end is the end).
 */

/** The project as the layout changes at the playhead need it: its layouts, length and edit. */
export type LayoutEdit = Pick<Project, 'layouts' | 'duration'> & { clips?: Clip[] }

/** Where the edited video ends (source seconds): its kept end, within the recording. */
const videoEnd = (p: LayoutEdit): number => Math.max(0, p.clips?.length ? Math.min(p.duration, keptBounds(p.clips).end) : p.duration)

/**
 * Source time of the frame the preview shows for a playhead at `t`: inside a cut the next kept
 * frame, at (or past) the end of the video its last frame, which is in a segment ending there.
 */
export function layoutTimeAt(project: LayoutEdit, t: number): number {
  const shown = project.clips?.length ? displayTime(project.clips, t) : t
  return clamp(shown, 0, Math.max(0, videoEnd(project) - 1e-3))
}

export type AddLayoutResult =
  | { ok: true; layouts: LayoutSegment[]; segment: LayoutSegment }
  /**
   * 'inside': the playhead shows segment `id`; 'no-room': another segment starts right after it;
   * 'end': the video ends right after it and the segment before (`id`, if any) ends right before.
   */
  | { ok: false; reason: 'inside' | 'no-room' | 'end'; id: string | null }

/**
 * A new segment of `layout` at the playhead `t` (layoutTimeAt), and the layouts with it added in
 * order. It starts there and lasts DEFAULT_LAYOUT_LENGTH, ending where the next one starts so
 * segments never overlap. Too close to the end of the video for that, it ends with the video and
 * starts earlier instead (after the one before), so its change still plays.
 */
export function addLayoutAt(project: LayoutEdit, layout: CameraLayout, t: number): AddLayoutResult {
  const layouts = project.layouts ?? []
  const end = videoEnd(project)
  const at = layoutTimeAt(project, t)
  const here = layoutSegmentAt(layouts, at)
  if (here) return { ok: false, reason: 'inside', id: here.id }
  const seg = createLayoutSegment(layout, at, project.duration)
  // Never over a neighbour: after the one before, up to the one after.
  const prev = layouts.filter((s) => s.end <= at + 1e-9).reduce<LayoutSegment | null>((a, s) => (!a || s.end > a.end ? s : a), null)
  const before = Math.max(0, prev?.end ?? 0)
  const after = Math.min(Infinity, ...layouts.filter((s) => s.start > at).map((s) => s.start))
  let start = Math.max(seg.start, before)
  let stop = Math.min(seg.end, after)
  const atEnd = after >= end - 1e-9 && Math.min(stop, end) - start < MIN_NEW_SEGMENT
  if (atEnd) {
    // Too close to the end of the video to start at the playhead: up to the end, as long as a new one would be.
    stop = end
    start = Math.max(before, stop - DEFAULT_LAYOUT_LENGTH)
  }
  if (stop - start < MIN_NEW_SEGMENT) return atEnd ? { ok: false, reason: 'end', id: prev?.id ?? null } : { ok: false, reason: 'no-room', id: null }
  const segment = { ...seg, start, end: stop }
  return { ok: true, layouts: [...layouts, segment].sort((a, b) => a.start - b.start), segment }
}

/**
 * Where to move a playhead at `t` so the preview shows `seg` (one of `project.layouts`) settled,
 * past its change in: null when the frame shown there already does. While `playing`, a playhead
 * in the segment stays (its change plays). Measured as if the camera were shown, so the playhead
 * lands the same whether it is or not.
 */
export function layoutShowTime(project: LayoutEdit & Pick<Project, 'webcam'>, seg: LayoutSegment, t: number, playing = false): number | null {
  const ramps = layoutRamps({ ...project, hasWebcam: true, webcam: { ...project.webcam, show: true } }, seg)
  const shown = layoutTimeAt(project, t)
  if (playing && shown >= seg.start && shown < seg.end) return null
  // Settled from the end of its change in to the start of its change out, or without one up to its end (where the next one shows).
  const settledTo = ramps.out > 0 ? seg.end - ramps.out : seg.end - 1e-3
  if (shown >= seg.start + ramps.in && shown <= settledTo) return null
  // Just past its change in; too short to settle (a change in that runs into the next one), as far into it as it gets.
  const at = Math.min(seg.start + ramps.in + 0.01, settledTo)
  const clips = project.clips
  if (!clips?.length) return at
  // On the frame the preview shows there: a change running into a cut shows after it...
  const kept = displayTime(clips, at)
  if (kept <= settledTo) return kept
  // ...unless it settles only in the cut: then the kept frame next to the cut that is furthest into the change.
  const prev = clips.filter((c) => c.start <= at).pop()
  const before = prev ? Math.min(at, prev.end - 1e-3) : -1
  const into = (s: number): number =>
    s < seg.start || s >= seg.end ? -1 : Math.min(ramps.in > 0 ? (s - seg.start) / ramps.in : 1, ramps.out > 0 ? (seg.end - s) / ramps.out : 1)
  if (into(before) < 0 && into(kept) < 0) return at
  return into(before) >= into(kept) ? before : kept
}

/** How far segment `id` may move or grow: up to its neighbours and the recording's ends. */
export function layoutDragBounds(layouts: LayoutSegment[], id: string, duration: number): { lower: number; upper: number } {
  const seg = layouts.find((s) => s.id === id)
  if (!seg) return { lower: 0, upper: duration }
  const others = layouts.filter((s) => s.id !== id)
  const lower = Math.max(0, ...others.filter((s) => s.end <= seg.start + 1e-6).map((s) => s.end))
  const upper = Math.min(duration, ...others.filter((s) => s.start >= seg.end - 1e-6).map((s) => s.start))
  return { lower, upper }
}

/** New start/end for a move or edge drag by `dt` seconds, kept between the neighbours and at least MIN_LAYOUT_LENGTH long. */
export function dragLayoutTimes(
  initial: { start: number; end: number },
  mode: 'move' | 'start' | 'end',
  dt: number,
  bounds: { lower: number; upper: number }
): { start: number; end: number } {
  let { start, end } = initial
  // A segment already shorter than the minimum may grow but not shrink further.
  const short = end - start < MIN_LAYOUT_LENGTH
  if (mode === 'move') {
    const len = end - start
    start = clamp(start + dt, bounds.lower, Math.max(bounds.lower, bounds.upper - len))
    end = start + len
  } else if (mode === 'start') {
    start = clamp(start + dt, Math.min(bounds.lower, start), short ? start : end - MIN_LAYOUT_LENGTH)
  } else {
    end = clamp(end + dt, short ? end : start + MIN_LAYOUT_LENGTH, Math.max(bounds.upper, end))
  }
  return { start, end }
}

/** The layouts with segment `id` changed by `patch`, kept in order. */
export function updateLayout(layouts: LayoutSegment[] | undefined, id: string, patch: Partial<Omit<LayoutSegment, 'id'>>): LayoutSegment[] {
  return (layouts ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)).sort((a, b) => a.start - b.start)
}
