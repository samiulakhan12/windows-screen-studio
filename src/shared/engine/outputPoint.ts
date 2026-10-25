import type { Rect } from './layout'
import type { Camera } from './zoom'

/**
 * Normalised source coordinates (0..1 of the recording) to output pixels, through the zoom
 * camera `cam`, for the recording drawn in `rect` (sceneContentRect at that time): where the
 * compositor draws a point of the recording (cursor, clicks, shapes, privacy blur) and where the
 * camera director measures it, so the two never disagree. Zoomed in, a point outside the view
 * lands outside `rect`; pulled back (scale < 1), the whole recording lands inside it.
 */
export function toOutput(rect: Rect, cam: Camera): (x: number, y: number) => { x: number; y: number } {
  const viewX = cam.cx - 0.5 / cam.scale
  const viewY = cam.cy - 0.5 / cam.scale
  return (x, y) => ({ x: rect.x + (x - viewX) * cam.scale * rect.w, y: rect.y + (y - viewY) * cam.scale * rect.h })
}
