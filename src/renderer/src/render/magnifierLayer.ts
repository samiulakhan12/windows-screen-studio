/**
 * Drawing magnifiers (docs/design/editing-polish.md §6.4): on the card's canvas, inside its clip,
 * between the cursor and the shapes.
 *
 * Contracts step: the exported signature of part P2 (§17.2). It returns at once when no spotlight
 * has `magnify` (every project from before); the stub draws nothing. Part P2 writes the body.
 */
import type { FrameContext } from './frameContext'

export function drawMagnifierLayer(fc: FrameContext): void {
  if (!(fc.project.spotlights ?? []).some((s) => s.magnify !== undefined)) return
}
