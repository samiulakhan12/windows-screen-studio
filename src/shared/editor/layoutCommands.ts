import type { CameraLayout, LayoutSegment, Project } from '../types'
import { createLayoutSegment } from './layouts'

/*
 * The editor's "camera layout at the playhead" commands: what they change in the project's layout
 * segments. Pure; the segments themselves and how they are drawn belong to layouts.ts.
 */

/** Command palette names of the layouts. */
export const LAYOUT_NAMES: Record<CameraLayout, string> = {
  default: 'Screen and camera bubble',
  'camera-only': 'Camera only',
  'screen-only': 'Screen only',
  'side-by-side': 'Side by side',
  'camera-large': 'Large camera'
}

/** A new segment shorter than this (seconds) has no room. */
const MIN_NEW_SEGMENT = 0.3

export type LayoutAtResult =
  | { ok: true; layouts: LayoutSegment[]; id: string; added: boolean }
  /** 'same': the layout at `t` already is that one (`id`: the segment showing it, if any); 'no-room': another segment starts right there. */
  | { ok: false; reason: 'same' | 'no-room'; id: string | null }

/**
 * Sets the camera layout at source time `t`. Inside a layout segment that segment changes;
 * elsewhere a new segment (createLayoutSegment) starts at `t`, ending where the next one starts
 * so segments never overlap. Outside every segment the layout is already 'default'.
 */
export function setLayoutAt(project: Pick<Project, 'layouts' | 'duration'>, layout: CameraLayout, t: number): LayoutAtResult {
  const layouts = project.layouts ?? []
  const here = layouts.find((s) => t >= s.start && t < s.end)
  if (here) {
    if (here.layout === layout) return { ok: false, reason: 'same', id: here.id }
    return { ok: true, layouts: layouts.map((s) => (s.id === here.id ? { ...s, layout } : s)), id: here.id, added: false }
  }
  if (layout === 'default') return { ok: false, reason: 'same', id: null }
  const seg = createLayoutSegment(layout, t, project.duration)
  // Never over a neighbour: after the one before, up to the one after.
  const before = Math.max(0, ...layouts.filter((s) => s.end <= t + 1e-9).map((s) => s.end))
  const after = Math.min(Infinity, ...layouts.filter((s) => s.start > t).map((s) => s.start))
  const start = Math.max(seg.start, before)
  const end = Math.min(seg.end, after)
  if (end - start < MIN_NEW_SEGMENT) return { ok: false, reason: 'no-room', id: null }
  const added = { ...seg, start, end }
  return { ok: true, layouts: [...layouts, added], id: added.id, added: true }
}
