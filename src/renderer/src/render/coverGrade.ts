/**
 * A cover's colour through the screen's grade, and the preview-only outlines (docs/design/auto-blur.md
 * §8.4, §8.5). Stubs from the contracts step: part P1 fills them. Until then a cover is filled in its
 * own colour and nothing is outlined.
 */
import type { CubeLut } from '../../../shared/render/cubeLut'
import type { ColorGrade } from '../../../shared/types'
import type { RenderScene } from './compositor'
import type { OutputView } from './coverLayer'

/** The cover colour run through the screen's grade and LUT (Compare: the ungraded colour). Stub: the colour itself. */
export function gradedCoverColour(color: string, grade: ColorGrade | undefined, lut: CubeLut | null, compare?: boolean): string {
  void grade
  void lut
  void compare
  return color
}

/** Peeked covers as 2 px accent outlines on the output (preview only). Stub: nothing. */
export function drawCoverPeek(c: CanvasRenderingContext2D, scene: RenderScene, t: number, views: readonly OutputView[]): void {
  void c
  void scene
  void t
  void views
}

/** *Show where covers are*: a dashed outline around every active cover (preview only). Stub: nothing. */
export function drawCoverMarks(c: CanvasRenderingContext2D, scene: RenderScene, t: number, views: readonly OutputView[]): void {
  void c
  void scene
  void t
  void views
}
