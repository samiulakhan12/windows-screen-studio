/**
 * Drawing animated callouts (docs/design/editing-polish.md §7.2): badges, bubbles and texts with a
 * motion (drawCallout, from drawAnnotations), and the poses of shapes and title cards (applied by
 * shapesLayer and titleCardLayer). Reached only for items with the new fields.
 *
 * Contracts step: the exported signatures of part P3 (§17.3), stubs: drawCallout draws nothing
 * and says so (today's code draws the text), the poses are null (today's fades). Part P3 writes
 * the bodies.
 */
import type { CalloutPose } from '../../../shared/render/callouts'
import type { Annotation, Shape, TitleCard } from '../../../shared/types'
import type { FrameContext } from './frameContext'

/** Draws `a` as a callout; false when it is not one (today's code draws it). `label`: an automatic badge's number. */
export function drawCallout(c: CanvasRenderingContext2D, top: FrameContext, a: Annotation, label: string | null): boolean {
  void c
  void top
  void a
  void label
  return false
}

/** A shape's pose at fc.t (it has a motion), or null: today's fade. */
export function shapeCalloutPose(fc: FrameContext, s: Shape): CalloutPose | null {
  void fc
  void s
  return null
}

/** A title card's pose at fc.t (it has a motion), or null: today's fade and rise. */
export function titleCalloutPose(fc: FrameContext, card: TitleCard): CalloutPose | null {
  void fc
  void card
  return null
}
