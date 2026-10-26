import { cornered, LAYOUT_TRANSITION, layoutRamps, segmentCorner } from '../engine/layout'
import { clamp } from '../engine/math'
import { keptBounds } from '../engine/timeline'
import { MIN_LAYOUT_LENGTH } from '../engine/webcamData'
import type { CameraLayout, Clip, Corner, LayoutSegment, Project } from '../types'
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

/**
 * The camera's corner at source time `t`: the corner the segment there chose, else the project's
 * (the Camera section's corner, the default for times without a segment).
 */
export function cornerAt(project: Pick<Project, 'layouts' | 'webcam'>, t: number): Corner {
  const seg = layoutSegmentAt(project.layouts, t)
  return (seg && segmentCorner(seg)) ?? project.webcam.corner
}

/** Whether segment `seg`'s layout puts the camera in a corner it may choose. */
export const segmentHasCorner = (seg: Pick<LayoutSegment, 'layout'>): boolean => cornered(seg.layout)

/**
 * Whether segment `s` only puts the camera in its own corner (the default layout with a corner):
 * where the live bubble was moved while recording, or "Move camera here". It is a camera
 * position, not a change of layout, so a layout change at the playhead inside it is added there
 * (layoutInStay) rather than retyping the whole stay, which can run for minutes.
 */
export const cornerOnly = (s: Pick<LayoutSegment, 'layout' | 'corner'>): boolean => s.layout === 'default' && !!s.corner

/**
 * Segment `s` as the user's own: without the camera director's marks (LayoutSegment.auto and
 * cutOut), so "Direct again" keeps it. Every edit by hand of a segment goes through this, as
 * editing a zoom sets its auto to false; the same object when it has no marks.
 */
export function byHand(s: LayoutSegment): LayoutSegment {
  if (s.auto === undefined && s.cutOut === undefined) return s
  const { auto: _auto, cutOut: _cutOut, ...rest } = s
  void _auto
  void _cutOut
  return rest
}

/**
 * A change to `layout` at `at` inside corner-only segment `here`: a DEFAULT_LAYOUT_LENGTH segment
 * of `layout` in the same corner, cut out of the stay, which carries on around it. It stays
 * inside the stay and the kept video (near their ends it starts earlier, as addLayoutAt does), and
 * a leftover too short for its own change goes to the new segment. Null when the stay is too short for it.
 */
function layoutInStay(layouts: LayoutSegment[], here: LayoutSegment, layout: CameraLayout, at: number, end: number): { layouts: LayoutSegment[]; segment: LayoutSegment } | null {
  const limit = Math.min(here.end, end)
  let start = at
  let stop = Math.min(at + DEFAULT_LAYOUT_LENGTH, limit)
  if (stop - start < MIN_NEW_SEGMENT) {
    stop = limit
    start = Math.max(here.start, stop - DEFAULT_LAYOUT_LENGTH)
  }
  if (stop - start < MIN_NEW_SEGMENT) return null
  // The piece before only changes in (the new segment follows it); the one after changes in and usually out again.
  if (start - here.start < LAYOUT_TRANSITION) start = here.start
  if (here.end - stop < 2 * LAYOUT_TRANSITION) stop = here.end
  const segment: LayoutSegment = { id: newId(), layout, start, end: stop, corner: here.corner }
  const pieces: LayoutSegment[] = []
  if (start > here.start) pieces.push({ ...here, end: start })
  pieces.push(segment)
  if (stop < here.end) pieces.push({ ...here, id: pieces.length > 1 ? newId() : here.id, start: stop })
  return { layouts: [...layouts.filter((s) => s.id !== here.id), ...pieces].sort((a, b) => a.start - b.start), segment }
}

/**
 * The pieces of the camera position that segment `seg` was cut out of (layoutInStay), right before
 * and after it: corner-only segments in its corner touching it. None for a camera position itself,
 * unless it sits between two of them (a change cut out of one, set back to the default layout).
 */
export function stayAround(layouts: LayoutSegment[], seg: LayoutSegment): { before?: LayoutSegment; after?: LayoutSegment } {
  if (!seg.corner) return {}
  const piece = (s: LayoutSegment): boolean => s.id !== seg.id && cornerOnly(s) && s.corner === seg.corner
  const before = layouts.find((s) => piece(s) && Math.abs(s.end - seg.start) <= 1e-6)
  const after = layouts.find((s) => piece(s) && Math.abs(s.start - seg.end) <= 1e-6)
  if (cornerOnly(seg) && !(before && after)) return {}
  return { before, after }
}

/**
 * The layouts without segment `id`. A change cut out of a camera position gives its time back to
 * it: the pieces join again, keeping the first one's id. A change the camera director cut out of
 * a camera position it covered whole (LayoutSegment.cutOut, no pieces left around it) becomes
 * that camera position again. A piece of a camera position takes along the director's cut-outs
 * that only it held (releaseCutOuts).
 */
export function removeLayout(layouts: LayoutSegment[] | undefined, id: string): LayoutSegment[] {
  const list = layouts ?? []
  const seg = list.find((s) => s.id === id)
  const rest = list.filter((s) => s.id !== id)
  if (!seg) return rest
  const { before, after } = stayAround(list, seg)
  if (before) return rest.filter((s) => s !== after).map((s) => (s === before ? { ...s, end: after?.end ?? seg.end } : s))
  if (after) return rest.map((s) => (s === after ? { ...s, start: seg.start } : s))
  if (seg.auto && seg.cutOut && seg.corner) {
    const position: LayoutSegment = { id: seg.id, start: seg.start, end: seg.end, layout: 'default', corner: seg.corner }
    return [...rest, position].sort((a, b) => a.start - b.start)
  }
  return releaseCutOuts(rest, seg)
}

/**
 * `layouts` after `was`, a piece of a camera position of the user's (a manual corner-only
 * segment), was removed or stopped being one (another layout or corner): the camera director's
 * cut-outs only it held lose their `cutOut` mark. Walking from each edge of `was` across touching
 * cut-outs in its corner, a chain that reaches no other piece of the position becomes automatic
 * changes like any other, which "Remove automatic changes" and "Direct again" drop
 * (withoutDirected) instead of bringing back as a camera position the user removed. Drawn the
 * same; `layouts` itself when nothing is released.
 */
export function releaseCutOuts(layouts: LayoutSegment[], was: LayoutSegment): LayoutSegment[] {
  const piece = (s: LayoutSegment): boolean => cornerOnly(s) && !s.auto && s.corner === was.corner
  if (!piece(was) || layouts.some((s) => s.id === was.id && piece(s))) return layouts
  const cut = (s: LayoutSegment): boolean => !!s.auto && !!s.cutOut && s.corner === was.corner
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6
  const release = new Set<LayoutSegment>()
  for (const back of [true, false]) {
    // The segment of a kind touching `edge` on this side of `was`.
    const at = (edge: number, is: (s: LayoutSegment) => boolean): LayoutSegment | undefined => layouts.find((s) => is(s) && near(back ? s.end : s.start, edge))
    const chain: LayoutSegment[] = []
    let edge = back ? was.start : was.end
    for (let next = at(edge, cut); next && !chain.includes(next); next = at(edge, cut)) {
      chain.push(next)
      edge = back ? next.start : next.end
    }
    if (!at(edge, piece)) chain.forEach((s) => release.add(s))
  }
  if (!release.size) return layouts
  return layouts.map((s) => {
    if (!release.has(s)) return s
    const { cutOut: _cutOut, ...rest } = s
    void _cutOut
    return rest
  })
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
 * starts earlier instead (after the one before), so its change still plays. Inside a corner-only
 * segment it is cut out of that camera position (layoutInStay). `corner`: the camera corner the
 * new segment chooses.
 */
export function addLayoutAt(project: LayoutEdit, layout: CameraLayout, t: number, corner?: Corner): AddLayoutResult {
  const layouts = project.layouts ?? []
  const end = videoEnd(project)
  const at = layoutTimeAt(project, t)
  const here = layoutSegmentAt(layouts, at)
  if (here) {
    const inStay = cornerOnly(here) && layout !== 'default' ? layoutInStay(layouts, here, layout, at, end) : null
    return inStay ? { ok: true, ...inStay } : { ok: false, reason: 'inside', id: here.id }
  }
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
  const segment: LayoutSegment = { ...seg, start, end: stop, ...(corner ? { corner } : {}) }
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

/**
 * How far segment `id` may move or grow: up to its neighbours and the recording's ends. A change
 * cut out of a camera position moves inside it: the pieces next to it (stayAround) follow its
 * edges (dragLayout) down to MIN_LAYOUT_LENGTH.
 */
export function layoutDragBounds(layouts: LayoutSegment[], id: string, duration: number): { lower: number; upper: number } {
  const seg = layouts.find((s) => s.id === id)
  if (!seg) return { lower: 0, upper: duration }
  const { before, after } = stayAround(layouts, seg)
  const others = layouts.filter((s) => s.id !== id && s !== before && s !== after)
  const lower = Math.max(0, before ? Math.min(seg.start, before.start + MIN_LAYOUT_LENGTH) : 0, ...others.filter((s) => s.end <= seg.start + 1e-6).map((s) => s.end))
  const upper = Math.min(duration, after ? Math.max(seg.end, after.end - MIN_LAYOUT_LENGTH) : duration, ...others.filter((s) => s.start >= seg.end - 1e-6).map((s) => s.start))
  return { lower, upper }
}

/**
 * The layouts with segment `id` dragged to `times`, made the user's (byHand); the pieces of a
 * camera position around it (`around`: stayAround as the drag began) follow its edges and keep
 * their marks.
 */
export function dragLayout(
  layouts: LayoutSegment[] | undefined,
  id: string,
  times: { start: number; end: number },
  around: { before?: LayoutSegment; after?: LayoutSegment } = {}
): LayoutSegment[] {
  return (layouts ?? []).map((s) => {
    if (s.id === id) return byHand({ ...s, ...times })
    if (s.id === around.before?.id) return { ...s, end: times.start }
    if (s.id === around.after?.id) return { ...s, start: times.end }
    return s
  })
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

/**
 * The layouts with segment `id` changed by `patch` (an edit by hand: it becomes the user's, byHand),
 * kept in order. A piece of a camera position changed into something else releases the director's
 * cut-outs only it held (releaseCutOuts).
 */
export function updateLayout(layouts: LayoutSegment[] | undefined, id: string, patch: Partial<Omit<LayoutSegment, 'id' | 'auto' | 'cutOut'>>): LayoutSegment[] {
  const list = layouts ?? []
  const was = list.find((s) => s.id === id)
  const out = list.map((s) => (s.id === id ? byHand({ ...s, ...patch }) : s)).sort((a, b) => a.start - b.start)
  return was ? releaseCutOuts(out, was) : out
}
