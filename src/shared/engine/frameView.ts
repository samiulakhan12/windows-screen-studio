/**
 * One entry point for what a frame shows (docs/design/vertical-video.md §8.1): the project as
 * drawn, the layout and the camera at a time, for the compositor, the shapes layer, the preview
 * and the camera director alike. A project that does not follow gets exactly what it got before
 * (sceneLayout and cameraAt); one that follows gets the virtual rectangle, the framed zooms and
 * the camera resting on the follow plan.
 *
 * CONTRACT (part P1): signatures are frozen; bodies are to be written.
 */
import type { CursorTrack, Project } from '../types'
import type { SceneLayout } from './layout'
import type { Camera, PathLike } from './zoom'

/** What a frame is drawn from: the drawn project and track (cropView) and the path the zoom camera follows. */
export interface ViewScene {
  project: Project
  cursor: CursorTrack
  focusPath: PathLike
}

/**
 * The project as a w x h frame of a vw x vh recording draws it: while following, framed zooms,
 * no device frame and no tilt (memoised per project); otherwise `project` itself.
 */
export function drawnForFrame(project: Project, w: number, h: number, vw: number, vh: number): Project {
  return notImplemented(project, w, h, vw, vh)
}

/** The camera at source time `t` for `layout` (`at`: the frame's own time for a motion-blur sub-frame, §5.4). */
export function frameCamera(scene: ViewScene, layout: SceneLayout, t: number, at?: number): Camera {
  return notImplemented(scene, layout, t, at)
}

/** The drawn project, the layout and the camera of a w x h frame at source time `t`. */
export function frameView(scene: ViewScene, w: number, h: number, vw: number, vh: number, t: number, at?: number): { project: Project; layout: SceneLayout; cam: Camera } {
  return notImplemented(scene, w, h, vw, vh, t, at)
}

/** How much larger click effects are drawn while following (§6.6): the magnification relative to a 16:9 frame of the same shorter side; 1 when not following. */
export function followGain(layout: SceneLayout, w: number, h: number, vw: number, vh: number, padding: number): number {
  return notImplemented(layout, w, h, vw, vh, padding)
}

/** The webcam framing zoom in a box narrower than square while following (§5.14): max(1, zoom × min(1, boxAspect)). */
export function narrowBoxZoom(zoom: number, boxAspect: number): number {
  return notImplemented(zoom, boxAspect)
}

/** Output px per recorded px of a followed outW x outH frame, at rest and in its strongest zoom; null when it does not follow. */
export function viewMagnification(project: Project, outW: number, outH: number, vw: number, vh: number): { rest: number; zoomed: number } | null {
  return notImplemented(project, outW, outH, vw, vh)
}

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
