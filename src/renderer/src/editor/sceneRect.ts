import { sceneContentRect, type Rect } from '../../../shared/engine/layout'
import type { Project } from '../../../shared/types'

/**
 * Where the recording is in the preview overlay (px) at the playhead: what drawFrame computes
 * for the camera layout in effect, so handles and picks line up with the drawn frame.
 */
export function useSceneRect(project: Project, w: number, h: number, vw: number, vh: number): Rect {
  return sceneContentRect(project, w, h, vw, vh, 0)
}
