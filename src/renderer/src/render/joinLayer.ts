/**
 * Drawing a cut's join (docs/design/editing-polish.md §5.6): the slide's offset before the picture
 * (beginJoin), A* or the dip's colour after it (endJoin), and composing A* once per cut on a
 * scratch target (composeJoinStill), copied into a plain canvas no layer draws on.
 *
 * drawFrame calls beginJoin and endJoin only for a frame inside a join. A crossfade or a slide
 * whose A* is not ready (a null still) draws nothing here: a hard cut.
 */
import { joinPose, type JoinWindow } from '../../../shared/render/joins'
import { drawFramePicture, type FrameExtras, type FrameImage, type RenderScene } from './compositor'
import { releaseGrade } from './gradeLayer'
import { releaseTilt } from './tiltLayer'

type Join = NonNullable<FrameExtras['join']>

/** A slide with its still: the live picture is moved, so beginJoin saved the context. */
const slides = (join: Join): boolean => join.at.window.kind === 'slide' && !!join.still

/** Before the picture: a slide's offset of the live picture (the context saved first; endJoin restores it). */
export function beginJoin(ctx: CanvasRenderingContext2D, w: number, h: number, join: FrameExtras['join']): void {
  if (!join || !slides(join)) return
  const { live } = joinPose(join.at, w, h)
  ctx.save()
  ctx.translate(live.dx, live.dy)
}

/**
 * After the picture, before the overlays: A* at its alpha and offset, or the dip's colour. After a
 * slide the picture's own save and beginJoin's are restored, and one save is left for drawFrame's
 * closing restore, so the overlays are drawn where they always are.
 */
export function endJoin(ctx: CanvasRenderingContext2D, w: number, h: number, join: FrameExtras['join']): void {
  if (!join) return
  const pose = joinPose(join.at, w, h)
  if (slides(join)) {
    ctx.restore()
    ctx.restore()
    ctx.save()
  }
  if (pose.still && join.still) {
    ctx.save()
    ctx.globalAlpha = pose.still.alpha
    ctx.drawImage(join.still, pose.still.dx, pose.still.dy, w, h)
    ctx.restore()
  }
  if (pose.fill && pose.fill.alpha > 0) {
    ctx.save()
    ctx.globalAlpha = pose.fill.alpha
    ctx.fillStyle = pose.fill.color
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  }
}

/** The scratch target of each raster mode (one each, whatever the number of cuts). */
const scratches = new Map<'gpu' | 'cpu', CanvasRenderingContext2D>()

/** The one scratch target of a raster mode that A* is composed on, at w × h. */
export function scratchTarget(raster: 'gpu' | 'cpu', w: number, h: number): CanvasRenderingContext2D {
  let ctx = scratches.get(raster)
  if (!ctx) {
    const canvas = document.createElement('canvas')
    const made = canvas.getContext('2d', { alpha: false, willReadFrequently: raster === 'cpu' })
    if (!made) throw new Error('Could not create a drawing surface')
    ctx = made
    scratches.set(raster, ctx)
  }
  if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx.canvas.width = w
    ctx.canvas.height = h
  }
  return ctx
}

/** Drops the scratch targets and their layers' copies (releaseTilt, releaseGrade). */
export function releaseScratch(): void {
  for (const ctx of scratches.values()) {
    releaseTilt(ctx)
    releaseGrade(ctx)
    ctx.canvas.width = 0
    ctx.canvas.height = 0
  }
  scratches.clear()
}

/** A <video> the picture's size test reads when no element is drawn (the stills are given as frames). */
let placeholder: HTMLVideoElement | null = null

/**
 * Composes A* of `window` on `scratch` and copies it into `out` with one drawImage: the picture
 * only (no captions, texts, title cards, graphics, bar or watermark), sharp (one motion-blur
 * sample), at A*'s instant, from the stills given (the camera's with its person mask prepared).
 */
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
  const still = window.still
  if (!still) return
  const a = scene.project.clips[window.index - 1]
  // The sound's clock just before A's end (the camera's, the animated background's).
  const soundTime = a ? a.end - 1e-6 : still.screen
  placeholder ??= document.createElement('video')
  drawFramePicture(scratch, w, h, still.screen, scene, { screen: placeholder, webcam: null, background, screenFrame: stills.screen, webcamFrame: stills.camera }, { blurSamples: 1 }, soundTime)
  // drawFramePicture leaves the context saved once.
  scratch.restore()
  if (out.width !== w || out.height !== h) {
    out.width = w
    out.height = h
  }
  out.getContext('2d', { alpha: false })?.drawImage(scratch.canvas, 0, 0)
}
