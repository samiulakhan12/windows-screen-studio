/**
 * Drawing a cut's join (docs/design/editing-polish.md §5.6): the slide's offset before the picture
 * (beginJoin), A* or the dip's colour after it (endJoin), and composing A* once per cut on a
 * scratch target (composeJoinStill), copied into a plain canvas no layer draws on.
 *
 * Contracts step: the exported signatures of part P1 (§17.1). drawFrame calls beginJoin and endJoin
 * only for a frame inside a join; the stubs draw nothing. Part P1 writes the bodies.
 */
import type { JoinWindow } from '../../../shared/render/joins'
import type { FrameExtras, FrameImage, RenderScene } from './compositor'

/** Before the picture: a slide's offset of the live picture. */
export function beginJoin(ctx: CanvasRenderingContext2D, w: number, h: number, join: FrameExtras['join']): void {
  void ctx
  void w
  void h
  void join
}

/** After the picture, before the overlays: A* at its alpha and offset, or the dip's colour. */
export function endJoin(ctx: CanvasRenderingContext2D, w: number, h: number, join: FrameExtras['join']): void {
  void ctx
  void w
  void h
  void join
}

/** The one scratch target of a raster mode that A* is composed on. */
export function scratchTarget(raster: 'gpu' | 'cpu', w: number, h: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: raster === 'cpu'
  })
  if (!ctx) throw new Error('Could not create a drawing surface')
  return ctx
}

/** Drops the scratch targets and their layers' copies (releaseTilt, releaseGrade). */
export function releaseScratch(): void {}

/** Composes A* of `window` (the picture only, sharp, at A's end) on `scratch` and copies it into `out`. */
export function composeJoinStill(
  scratch: CanvasRenderingContext2D,
  out: HTMLCanvasElement,
  w: number,
  h: number,
  window: JoinWindow,
  scene: RenderScene,
  stills: { screen: FrameImage; camera: FrameImage | null },
  background: HTMLImageElement | null
): void {
  void scratch
  void out
  void w
  void h
  void window
  void scene
  void stills
  void background
}
