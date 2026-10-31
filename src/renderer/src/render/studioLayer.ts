/**
 * The Captions Studio caption layer (docs/design/captions-studio.md §9.7): word sprites drawn with
 * the motion engine's poses, boxes, marks and the caption block for key presses; and the
 * gallery's thumbnails, drawn with the same code.
 *
 * CONTRACT (part P2): signatures are frozen; bodies are to be written.
 */
import type { Rect } from '../../../shared/engine/layout'
import type { CaptionStudio, Project, StudioPosition } from '../../../shared/types'
import type { FrameContext } from './frameContext'

/** The body of a frozen signature part P2 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P2)`)
}

/** The captions of fc.t in a Studio look (drawCaptionsLayer calls it when captions.studio is set). */
export function drawStudioCaptions(fc: FrameContext): void {
  return notImplemented('drawStudioCaptions', fc)
}

/** The Studio caption block at `t`, with the edge key presses keep clear of (§8.5), or null. */
export function studioBlockAt(
  ctx: CanvasRenderingContext2D,
  project: Project,
  t: number,
  w: number,
  h: number,
  area?: Rect | null
): { position: StudioPosition | null; edge: 'top' | 'middle' | 'bottom'; top: number; bottom: number; box: Rect } | null {
  return notImplemented('studioBlockAt', ctx, project, t, w, h, area)
}

/** A gallery thumbnail at the sample scale of §2.5; returns the text size it drew. */
export function drawStudioSample(ctx: CanvasRenderingContext2D, studio: CaptionStudio, frame: { w: number; h: number }, tile: { w: number; h: number }, t: number): { textPx: number } {
  return notImplemented('drawStudioSample', ctx, studio, frame, tile, t)
}
