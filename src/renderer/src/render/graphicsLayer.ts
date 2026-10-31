/**
 * Motion graphics on the video (docs/design/captions-studio.md §10.4): after annotations and
 * before captions, on the captions' clock.
 *
 * CONTRACT (part P2): signatures are frozen; bodies are to be written.
 */
import type { Rect } from '../../../shared/engine/layout'
import type { Project } from '../../../shared/types'
import type { FrameContext } from './frameContext'

/** The body of a frozen signature part P2 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P2)`)
}

export function drawGraphicsLayer(fc: FrameContext): void {
  return notImplemented('drawGraphicsLayer', fc)
}

/** Where each graphic shows at `t` (hit tests in the preview). */
export function graphicRects(ctx: CanvasRenderingContext2D, project: Project, t: number, w: number, h: number): { id: string; rect: Rect }[] {
  return notImplemented('graphicRects', ctx, project, t, w, h)
}
