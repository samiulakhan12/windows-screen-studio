import { sortedLayouts } from '../engine/layout'
import { clamp } from '../engine/math'
import { MIN_LAYOUT_LENGTH } from '../engine/webcamData'
import type { CameraLayout, LayoutSegment, Project } from '../types'

/** Default length (seconds) of a new layout segment. */
export const DEFAULT_LAYOUT_LENGTH = 5

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

/**
 * A new segment of `layout` at `t`, fitted into the free time there (it never overlaps or
 * shortens another segment), and the layouts with it added in order. Null when `t` is inside
 * a segment or there is no room for one.
 */
export function addLayoutAt(layouts: LayoutSegment[] | undefined, layout: CameraLayout, t: number, duration: number): { layouts: LayoutSegment[]; segment: LayoutSegment } | null {
  const list = layouts ?? []
  if (!(duration > 0) || layoutSegmentAt(list, t)) return null
  const seg = createLayoutSegment(layout, clamp(t, 0, duration), duration)
  const next = sortedLayouts(list).find((s) => s.start >= seg.start - 1e-6)
  const end = Math.min(seg.end, next ? next.start : duration)
  // Too close to the next one: start earlier when there is room before it.
  const prevEnd = Math.max(0, ...list.filter((s) => s.end <= seg.start + 1e-6).map((s) => s.end))
  let start = seg.start
  if (end - start < MIN_LAYOUT_LENGTH) start = Math.max(prevEnd, end - MIN_LAYOUT_LENGTH)
  if (end - start < MIN_LAYOUT_LENGTH - 1e-6) return null
  const segment = { ...seg, start, end }
  return { layouts: [...list, segment].sort((a, b) => a.start - b.start), segment }
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
