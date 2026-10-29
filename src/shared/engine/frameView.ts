/**
 * One entry point for what a frame shows (docs/design/vertical-video.md §8.1): the project as
 * drawn, the layout and the camera at a time, for the compositor, the shapes layer, the preview
 * and the camera director alike. A project that does not follow gets exactly what it got before
 * (sceneLayout and cameraAt); one that follows gets the virtual rectangle, the framed zooms and
 * the camera resting on the follow plan.
 *
 * CONTRACT: signatures are frozen (docs/design/vertical-video.md §9.0).
 */
import type { CursorTrack, Project } from '../types'
import { followLevel, peakMagnification, sceneLayout, styleContentRect, type SceneLayout } from './layout'
import { followCentre, followPlanFor, framedZooms, viewLimits } from './reframe'
import { followApplies } from './reframeData'
import { cameraAt, zoomStyleOf, type Camera, type PathLike } from './zoom'

/** What a frame is drawn from: the drawn project and track (cropView) and the path the zoom camera follows. */
export interface ViewScene {
  project: Project
  cursor: CursorTrack
  focusPath: PathLike
}

/** The drawn project of each project that follows, and back (so a drawn project passed again is never framed twice). */
const drawn = new WeakMap<Project, Project>()
const sources = new WeakMap<Project, Project>()

/** The project the drawn `p` was made from (`p` itself when it was not made by drawnForFrame). */
const sourceOf = (p: Project): Project => sources.get(p) ?? p

/**
 * The project as a w x h frame of a vw x vh recording draws it: while following, framed zooms,
 * no device frame and no tilt (memoised per project); otherwise `project` itself.
 */
export function drawnForFrame(project: Project, w: number, h: number, vw: number, vh: number): Project {
  if (sources.has(project) || !followApplies(project, w, h, vw, vh)) return project
  let out = drawn.get(project)
  if (!out) {
    const { tilt: _tilt, ...rest } = project
    const { frame: _frame, ...style } = project.style
    out = { ...rest, style, zooms: framedZooms(project.zooms, viewLimits(project)) }
    drawn.set(project, out)
    sources.set(out, project)
  }
  return out
}

/**
 * The camera at source time `t` for `layout` (`at`: the frame's own time for a motion-blur
 * sub-frame, §5.4). Not following: cameraAt with the focus path, as always. Following: the framed
 * zooms relative to the layout's view, resting on the follow plan, which is also what cursor
 * zooms aim at (anchors still win), clamped with the view of this frame.
 */
export function frameCamera(scene: ViewScene, layout: SceneLayout, t: number, at?: number): Camera {
  const project = sourceOf(scene.project)
  if (!layout.follow) return cameraAt(project.zooms, t, scene.cursor.valid ? scene.focusPath : null, zoomStyleOf(project))
  const plan = followPlanFor(project, scene.cursor)
  const when = at ?? t
  const centre = followCentre(plan, t, when)
  const path: PathLike = { at: (u) => followCentre(plan, u, when) }
  const { base } = layout.follow
  return cameraAt(framedZooms(project.zooms, viewLimits(project)), t, path, zoomStyleOf(project), { cx: centre.x, cy: centre.y, w: base.w, h: base.h })
}

/** The drawn project, the layout and the camera of a w x h frame at source time `t`. */
export function frameView(scene: ViewScene, w: number, h: number, vw: number, vh: number, t: number, at?: number): { project: Project; layout: SceneLayout; cam: Camera } {
  const project = drawnForFrame(scene.project, w, h, vw, vh)
  const layout = sceneLayout(project, w, h, vw, vh, t)
  return { project, layout, cam: frameCamera(scene, layout, t, at) }
}

/** How much larger click effects are drawn while following (§6.6): the magnification relative to a 16:9 frame of the same shorter side; 1 when not following. */
export function followGain(layout: SceneLayout, w: number, h: number, vw: number, vh: number, padding: number): number {
  if (!layout.follow) return 1
  const m = Math.min(w, h)
  const ref = styleContentRect((m * 16) / 9, m, vw, vh, { padding, frame: undefined })
  return ref.h > 0 ? layout.screen.h / ref.h : 1
}

/** The webcam framing zoom in a box narrower than square while following (§5.14): max(1, zoom × min(1, boxAspect)). */
export function narrowBoxZoom(zoom: number, boxAspect: number): number {
  return Number.isFinite(boxAspect) && boxAspect > 0 ? Math.max(1, zoom * Math.min(1, boxAspect)) : zoom
}

/**
 * Output px per recorded px of a followed outW x outH frame, at rest and in its strongest zoom, in
 * the layout that shows the recording largest; null when it does not follow.
 */
export function viewMagnification(project: Project, outW: number, outH: number, vw: number, vh: number): { rest: number; zoomed: number } | null {
  if (!followApplies(project, outW, outH, vw, vh)) return null
  const rest = peakMagnification(project, outW, outH, vw, vh) * followLevel(project, vw, vh)
  const strongest = framedZooms(project.zooms, viewLimits(project)).reduce((s, z) => Math.max(s, z.scale), 1)
  return { rest, zoomed: rest * strongest }
}
