/**
 * What the preview shows at a moment, for placing and moving step badges and speech bubbles
 * (docs/design/editing-polish.md §2.3, §7.3, §7.4): the frame's camera both ways (a point of the
 * recording to a place in the frame and back), the text area and the visible picture, worked out
 * as the compositor works them out (frameView's camera, the punch-in, toOutput), so a new badge
 * lands where it is drawn and a handle sits on what is drawn.
 */
import { fromOutput, type CalloutView } from '../../../shared/editor/calloutsEdit'
import { fromCrop, toCrop } from '../../../shared/engine/crop'
import { frameView } from '../../../shared/engine/frameView'
import { outputSize, type Rect } from '../../../shared/engine/layout'
import { toOutput } from '../../../shared/engine/outputPoint'
import type { CalloutFrame } from '../../../shared/render/callouts'
import { punchedCamera } from '../../../shared/render/joins'
import { textArea } from '../../../shared/render/safeZones'
import type { Project } from '../../../shared/types'
import { visiblePicture } from '../render/calloutLayer'
import type { RenderScene } from '../render/compositor'

/** A frame of the preview at one source time: `view` maps full-recording points (pins as stored), `frame` is what calloutPlace places in. */
export interface CalloutMapping {
  view: CalloutView
  frame: CalloutFrame
  /** The drawn project at that time (crop view). */
  project: Project
  /** Where the recording is drawn (the card), px. */
  seen: Rect
}

/**
 * The preview's frame at source time `t` for `scene` (the editor's scene: the drawn project in the
 * crop's view), `w` × `h` px (default: the export's frame at 1080). Positions in it are fractions of
 * the frame, so any size gives the same `x`, `y` and pins.
 */
export function calloutMapping(scene: RenderScene, t: number, w?: number, h?: number): CalloutMapping {
  const p = scene.project
  const size = w && h ? { width: w, height: h } : outputSize(p.style.aspectRatio, p.width, p.height, 1080)
  const v = frameView(scene, size.width, size.height, p.width, p.height, t)
  const cam = punchedCamera(v.cam, v.project, t)
  const toView = toOutput(v.layout.screen, cam)
  const fromView = fromOutput(v.layout.screen, cam)
  const crop = scene.crop ?? null
  const { seen, visible } = visiblePicture({ rect: v.layout.screen, cam, layout: v.layout, project: v.project })
  return {
    view: {
      w: size.width,
      h: size.height,
      toOut: (x, y) => {
        const q = toCrop(crop, { x, y })
        return toView(q.x, q.y)
      },
      fromOut: (x, y) => fromCrop(crop, fromView(x, y))
    },
    frame: { w: size.width, h: size.height, area: textArea(v.project, size.width, size.height, p.width, p.height, t), toOut: toView, visible, seen, crop },
    project: v.project,
    seen
  }
}

/** The editor's scene while the preview holds a frame (paused, not seeking), else null. */
export function pausedScene(player: { pausedFrame(): { scene: RenderScene } | null }): RenderScene | null {
  return player.pausedFrame()?.scene ?? null
}

/** Where a pin shows in the frame at source time `t` (fractions of the frame, clamped to it): what an older Flown draws at (§4.5). */
export function shownAt(scene: RenderScene, t: number, pin: { x: number; y: number }): { x: number; y: number } {
  const m = calloutMapping(scene, t)
  const p = m.view.toOut(pin.x, pin.y)
  return { x: Math.min(1, Math.max(0, p.x / m.view.w)), y: Math.min(1, Math.max(0, p.y / m.view.h)) }
}

/** The point of the recording (full frame) a place of the frame (fractions) shows at source time `t`. */
export function pinUnder(scene: RenderScene, t: number, at: { x: number; y: number }): { x: number; y: number } {
  const m = calloutMapping(scene, t)
  return m.view.fromOut(at.x * m.view.w, at.y * m.view.h)
}
