import { keptBounds } from '../engine/timeline'
import type { CameraLayout, Clip, LayoutSegment, Project } from '../types'
import { createLayoutSegment, DEFAULT_LAYOUT_LENGTH } from './layouts'

/*
 * The editor's "camera layout at the playhead" commands: what they change in the project's layout
 * segments. Pure; the segments themselves and how they are drawn belong to layouts.ts.
 */

/** Names of the layouts in the editor's messages. */
export const LAYOUT_NAMES: Record<CameraLayout, string> = {
  default: 'Screen with camera bubble',
  'camera-only': 'Camera only',
  'screen-only': 'Screen only',
  'side-by-side': 'Side by side',
  'camera-large': 'Large camera'
}

/** A new segment shorter than this (seconds) has no room. */
const MIN_NEW_SEGMENT = 0.3

export type LayoutAtResult =
  | { ok: true; layouts: LayoutSegment[]; id: string; added: boolean }
  /**
   * 'same': the layout at `t` already is that one (`id`: the segment showing it, if any);
   * 'no-room': another segment starts right after `t`; 'end': the video ends right after `t` and
   * the segment before (`id`, if any) ends right before it.
   */
  | { ok: false; reason: 'same' | 'no-room' | 'end'; id: string | null }

/**
 * Sets the camera layout at source time `t`. Inside a layout segment that segment changes;
 * elsewhere a new segment (createLayoutSegment) starts at `t`, ending where the next one starts
 * so segments never overlap. Too close to the end of the video (`clips`: its kept part) for that,
 * the new segment ends with the video and starts earlier instead. Outside every segment the
 * layout is already 'default'.
 */
export function setLayoutAt(project: Pick<Project, 'layouts' | 'duration'> & { clips?: Clip[] }, layout: CameraLayout, t: number): LayoutAtResult {
  const layouts = project.layouts ?? []
  const videoEnd = Math.max(0, project.clips?.length ? Math.min(project.duration, keptBounds(project.clips).end) : project.duration)
  // The playhead at the end shows the video's last frame, so it is in the segment ending there.
  t = Math.min(t, videoEnd - 1e-3)
  const here = layouts.find((s) => t >= s.start && t < s.end)
  if (here) {
    if (here.layout === layout) return { ok: false, reason: 'same', id: here.id }
    return { ok: true, layouts: layouts.map((s) => (s.id === here.id ? { ...s, layout } : s)), id: here.id, added: false }
  }
  if (layout === 'default') return { ok: false, reason: 'same', id: null }
  const seg = createLayoutSegment(layout, t, project.duration)
  // Never over a neighbour: after the one before, up to the one after.
  const prev = layouts.filter((s) => s.end <= t + 1e-9).reduce<LayoutSegment | null>((a, s) => (!a || s.end > a.end ? s : a), null)
  const before = Math.max(0, prev?.end ?? 0)
  const after = Math.min(Infinity, ...layouts.filter((s) => s.start > t).map((s) => s.start))
  let start = Math.max(seg.start, before)
  let end = Math.min(seg.end, after)
  const atEnd = after >= videoEnd - 1e-9 && Math.min(end, videoEnd) - start < MIN_NEW_SEGMENT
  if (atEnd) {
    // Too close to the end of the video to start at the playhead: up to the end, as long as a new one would be.
    end = videoEnd
    start = Math.max(before, end - DEFAULT_LAYOUT_LENGTH)
  }
  if (end - start < MIN_NEW_SEGMENT) return atEnd ? { ok: false, reason: 'end', id: prev?.id ?? null } : { ok: false, reason: 'no-room', id: null }
  const added = { ...seg, start, end }
  return { ok: true, layouts: [...layouts, added], id: added.id, added: true }
}
