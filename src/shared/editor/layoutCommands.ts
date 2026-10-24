import type { CameraLayout, LayoutSegment } from '../types'
import { addLayoutAt, layoutSegmentAt, layoutTimeAt, type LayoutEdit } from './layouts'

/*
 * The editor's "camera layout at the playhead" commands, and the Camera panel's layout picker
 * when no change is selected: what they change in the project's layout segments. Pure; the
 * segments themselves, and where a new one goes (addLayoutAt), belong to layouts.ts.
 */

/** Names of the layouts in the editor's messages. */
export const LAYOUT_NAMES: Record<CameraLayout, string> = {
  default: 'Screen with camera bubble',
  'camera-only': 'Camera only',
  'screen-only': 'Screen only',
  'side-by-side': 'Side by side',
  'camera-large': 'Large camera'
}

export type LayoutAtResult =
  | { ok: true; layouts: LayoutSegment[]; id: string; added: boolean }
  /**
   * 'same': the layout at `t` already is that one (`id`: the segment showing it, if any);
   * 'no-room': another segment starts right after `t`; 'end': the video ends right after `t` and
   * the segment before (`id`, if any) ends right before it.
   */
  | { ok: false; reason: 'same' | 'no-room' | 'end'; id: string | null }

/**
 * Sets the camera layout at the playhead `t`, on the frame the preview shows there (layoutTimeAt).
 * Inside a layout segment that segment changes; elsewhere a new one is added (addLayoutAt).
 * Outside every segment the layout is already 'default'.
 */
export function setLayoutAt(project: LayoutEdit, layout: CameraLayout, t: number): LayoutAtResult {
  const layouts = project.layouts ?? []
  const here = layoutSegmentAt(layouts, layoutTimeAt(project, t))
  if (here) {
    if (here.layout === layout) return { ok: false, reason: 'same', id: here.id }
    return { ok: true, layouts: layouts.map((s) => (s.id === here.id ? { ...s, layout } : s)), id: here.id, added: false }
  }
  if (layout === 'default') return { ok: false, reason: 'same', id: null }
  const r = addLayoutAt(project, layout, t)
  if (r.ok) return { ok: true, layouts: r.layouts, id: r.segment.id, added: true }
  return { ok: false, reason: r.reason === 'inside' ? 'same' : r.reason, id: r.id }
}

/** What the editor says when setLayoutAt changed nothing. */
export function layoutRefusal(reason: 'same' | 'no-room' | 'end', layout: CameraLayout): string {
  if (reason === 'same') return `The camera layout here already is ${LAYOUT_NAMES[layout].toLowerCase()}`
  if (reason === 'end') return 'Too close to the end of the video for a new camera layout'
  return 'No room for a new camera layout here: another one starts right after the playhead'
}
