import { cornered } from '../engine/layout'
import { CORNER_NAMES } from '../recording/cameraBubble'
import type { CameraLayout, Corner, LayoutSegment, Project } from '../types'
import { addLayoutAt, byHand, cornerOnly, layoutSegmentAt, layoutTimeAt, type LayoutEdit } from './layouts'

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
 * Inside a layout segment that segment changes (and becomes the user's, byHand), except a
 * corner-only one (a camera position, such as a bubble move): a new one is added there, in its
 * corner, as elsewhere (addLayoutAt). Outside every segment the layout is already 'default'.
 */
export function setLayoutAt(project: LayoutEdit, layout: CameraLayout, t: number): LayoutAtResult {
  const layouts = project.layouts ?? []
  const here = layoutSegmentAt(layouts, layoutTimeAt(project, t))
  if (here) {
    if (here.layout === layout) return { ok: false, reason: 'same', id: here.id }
    const r = cornerOnly(here) ? addLayoutAt(project, layout, t) : null
    if (r?.ok) return { ok: true, layouts: r.layouts, id: r.segment.id, added: true }
    return { ok: true, layouts: layouts.map((s) => (s.id === here.id ? byHand({ ...s, layout }) : s)), id: here.id, added: false }
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

export type CornerAtResult =
  | { ok: true; layouts: LayoutSegment[]; id: string; added: boolean }
  /**
   * 'same': the camera already is in that corner at `t` (`id`: the segment there, if any);
   * 'no-corner': the layout at `t` (segment `id`) shows no camera bubble; 'no-room' / 'end' as for setLayoutAt.
   */
  | { ok: false; reason: 'same' | 'no-corner' | 'no-room' | 'end'; id: string | null }

/**
 * Puts the camera in `corner` at the playhead `t` (on the frame the preview shows there). Inside a
 * layout segment that segment's corner changes (it becomes the user's, byHand); elsewhere a new
 * segment of the default layout with that corner is added there (addLayoutAt), so the camera
 * moves there from the playhead on. The project's own corner stays the default for times without
 * a segment.
 */
export function setCornerAt(project: LayoutEdit & Pick<Project, 'webcam'>, corner: Corner, t: number): CornerAtResult {
  const layouts = project.layouts ?? []
  const here = layoutSegmentAt(layouts, layoutTimeAt(project, t))
  if (here) {
    if (!cornered(here.layout)) return { ok: false, reason: 'no-corner', id: here.id }
    if ((here.corner ?? project.webcam.corner) === corner) return { ok: false, reason: 'same', id: here.id }
    return { ok: true, layouts: layouts.map((s) => (s.id === here.id ? byHand({ ...s, corner }) : s)), id: here.id, added: false }
  }
  if (corner === project.webcam.corner) return { ok: false, reason: 'same', id: null }
  const r = addLayoutAt(project, 'default', t, corner)
  if (r.ok) return { ok: true, layouts: r.layouts, id: r.segment.id, added: true }
  return { ok: false, reason: r.reason === 'inside' ? 'same' : r.reason, id: r.id }
}

/** What the editor says when setCornerAt changed nothing. */
export function cornerRefusal(reason: 'same' | 'no-corner' | 'no-room' | 'end', corner: Corner): string {
  if (reason === 'same') return `The camera already is in the ${CORNER_NAMES[corner].toLowerCase()} corner here`
  if (reason === 'no-corner') return 'The camera layout here has no camera corner: pick the default, large camera or side by side layout first'
  if (reason === 'end') return 'Too close to the end of the video to move the camera'
  return 'No room to move the camera here: another camera layout starts right after the playhead'
}
