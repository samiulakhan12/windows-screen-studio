import type { FrameContext } from './frameContext'

/**
 * Privacy shapes ('blur', 'pixelate') active at fc.t, drawn over the recording inside the
 * card's clip and under the cursor. They follow the content through the camera (fc.toOut).
 */
export function drawPrivacyLayer(fc: FrameContext): void {
  void fc
}

/** Arrows, lines, boxes, ellipses and highlights active at fc.t, drawn over the recording and cursor. */
export function drawShapesLayer(fc: FrameContext): void {
  void fc
}
