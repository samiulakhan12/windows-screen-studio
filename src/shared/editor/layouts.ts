import type { CameraLayout, LayoutSegment, Project } from '../types'

/** Default length (seconds) of a new layout segment. */
export const DEFAULT_LAYOUT_LENGTH = 5

let idCounter = 0
const newId = (): string => `y${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** The camera layout in effect at source time `t`. */
export function layoutAt(project: Pick<Project, 'layouts'>, t: number): CameraLayout {
  return project.layouts?.find((s) => t >= s.start && t < s.end)?.layout ?? 'default'
}

/** A new layout segment starting at `t`, clamped to the recording. */
export function createLayoutSegment(layout: CameraLayout, t: number, duration: number): LayoutSegment {
  const start = Math.max(0, Math.min(t, duration - 0.1))
  return { id: newId(), layout, start, end: Math.min(duration, start + DEFAULT_LAYOUT_LENGTH) }
}
