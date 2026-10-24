import type { SmoothedTrack } from '../../../shared/engine/cursor'
import type { Rect } from '../../../shared/engine/layout'
import type { Camera } from '../../../shared/engine/zoom'
import type { CursorTrack, Project } from '../../../shared/types'
import type { RenderScene } from './compositor'

/**
 * Everything a render layer needs for one output frame. Built once per frame by
 * drawFrame(); layers draw through it so they never recompute the camera or layout.
 */
export interface FrameContext {
  ctx: CanvasRenderingContext2D
  /** Output frame size in pixels. */
  w: number
  h: number
  /** Source (recording) time in seconds. */
  t: number
  /** Scale of 1080p-referenced sizes for this output (min(w, h) / 1080). */
  k: number
  scene: RenderScene
  project: Project
  cursor: CursorTrack
  /** Cursor-following focus path, or null when the recording has no cursor data. */
  focus: SmoothedTrack | null
  /** Recorded video size in pixels. */
  vw: number
  vh: number
  /** Where the recording card is drawn (output px) and its corner radius. */
  rect: Rect
  radius: number
  /** Zoom camera at t. */
  cam: Camera
  /** Normalised source coordinates -> output pixels, through the camera. */
  toOut(x: number, y: number): { x: number; y: number }
}

/**
 * A normalised position inside the recorded video. The cursor of a window or area
 * recording can be outside it (over another window, outside the area): nothing is drawn there.
 */
export const inVideo = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
