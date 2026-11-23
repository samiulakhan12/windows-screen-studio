/**
 * Covers on the editor's own pictures of the raw recording (docs/design/auto-blur.md §9 rows 18 and
 * 28): the timeline's filmstrip tiles and the Style tab's look chips. Stubs from the contracts step:
 * part P1 fills them. Until then they draw nothing.
 */
import type { Project } from '../../../shared/types'

/**
 * Fills, in Dark, the boxes of every cover active anywhere in [t − 15 / fps − 0.02, t] over each
 * tile (a tile shows the last key frame at or before its time). Tiles are in the canvas's units. Stub: nothing.
 */
export function fillCoverTiles(ctx: CanvasRenderingContext2D, project: Project, fps: number, tiles: readonly { t: number; x: number; y: number; w: number; h: number }[]): void {
  void ctx
  void project
  void fps
  void tiles
}

/** Fills, in Dark, the boxes of the covers active at `t` into a look chip's pixels (width × height RGBA) before grading. Stub: nothing. */
export function fillCoverPixels(pixels: Uint8ClampedArray, width: number, height: number, project: Project, t: number): void {
  void pixels
  void width
  void height
  void project
  void t
}
