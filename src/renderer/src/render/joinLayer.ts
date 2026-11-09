/**
 * Drawing a cut's join (docs/design/editing-polish.md §5.6): the slide's offset before the picture
 * (beginJoin), A* or the dip's colour after it (endJoin), and composing A* once per cut on a
 * scratch target (composeJoinStill), copied into a plain canvas no layer draws on.
 *
 * drawFrame calls beginJoin and endJoin only for a frame inside a join. A crossfade or a slide
 * whose A* is not ready (a null still) draws nothing here: a hard cut.
 *
 * In a see-through export (output-and-languages §6.4) A* is composed with the same alpha on a
 * scratch target with alpha, and a dip fades the picture to transparent instead of to its colour.
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
 *
 * `alpha` (the frame's RenderScene.alpha): the dip's colour belonged to the background, which a
 * see-through frame does not have, so the picture fades to transparent at the dip's alpha instead
 * ('destination-out'); the overlays drawn after it stay as they are.
 */
export function endJoin(ctx: CanvasRenderingContext2D, w: number, h: number, join: FrameExtras['join'], alpha?: RenderScene['alpha']): void {
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
    if (alpha) {
      // Any opaque colour: destination-out keeps (1 - its alpha × globalAlpha) of what is there.
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = '#000'
    } else {
      ctx.fillStyle = pose.fill.color
    }
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  }
}

/**
 * The scratch target of each raster mode (one each, whatever the number of cuts), and apart from
 * them the one with alpha of each mode, for transparent exports: an opaque and a transparent A*
 * never share a target.
 */
const scratches = new Map<string, CanvasRenderingContext2D>()

const scratchKey = (raster: 'gpu' | 'cpu', alpha: boolean): string => (alpha ? `${raster}:alpha` : raster)

/** The one scratch target of a raster mode that A* is composed on, at w × h; `alpha`: the one with an alpha channel (§6.4). */
export function scratchTarget(raster: 'gpu' | 'cpu', w: number, h: number, alpha = false): CanvasRenderingContext2D {
  const key = scratchKey(raster, alpha)
  let ctx = scratches.get(key)
  if (!ctx) {
    const canvas = document.createElement('canvas')
    const made = canvas.getContext('2d', { alpha, willReadFrequently: raster === 'cpu' })
    if (!made) throw new Error('Could not create a drawing surface')
    ctx = made
    scratches.set(key, ctx)
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

/** The raster mode of a scratch target scratchTarget made (else as its context was asked for). */
function rasterOf(scratch: CanvasRenderingContext2D): 'gpu' | 'cpu' {
  for (const [key, ctx] of scratches) if (ctx === scratch) return key.startsWith('cpu') ? 'cpu' : 'gpu'
  return scratch.getContextAttributes?.()?.willReadFrequently ? 'cpu' : 'gpu'
}

/**
 * Composes A* of `window` on `scratch` and copies it into `out` with one drawImage: the picture
 * only (no captions, texts, title cards, graphics, bar or watermark), sharp (one motion-blur
 * sample), at A*'s instant, from the stills given (the camera's with its person mask prepared).
 *
 * `alpha` (the scene's own by default): a see-through A* (§6.4), drawn with that alpha on the
 * scratch target with alpha of `scratch`'s raster mode (the exporter hands the opaque one) and
 * copied into `out` with alpha, cleared first.
 */
export function composeJoinStill(
  scratch: CanvasRenderingContext2D,
  out: HTMLCanvasElement,
  w: number,
  h: number,
  window: JoinWindow,
  scene: RenderScene,
  stills: { screen: FrameImage; camera: FrameImage | null },
  background: HTMLImageElement | null,
  alpha: RenderScene['alpha'] = scene.alpha
): void {
  const still = window.still
  if (!still) return
  const a = scene.project.clips[window.index - 1]
  // The sound's clock just before A's end (the camera's, the animated background's).
  const soundTime = a ? a.end - 1e-6 : still.screen
  placeholder ??= document.createElement('video')
  const target = alpha ? scratchTarget(rasterOf(scratch), w, h, true) : scratch
  const drawn = scene.alpha === alpha ? scene : { ...scene, alpha }
  drawFramePicture(target, w, h, still.screen, drawn, { screen: placeholder, webcam: null, background, screenFrame: stills.screen, webcamFrame: stills.camera }, { blurSamples: 1 }, soundTime)
  // drawFramePicture leaves the context saved once.
  target.restore()
  if (out.width !== w || out.height !== h) {
    out.width = w
    out.height = h
  }
  if (!alpha) {
    out.getContext('2d', { alpha: false })?.drawImage(scratch.canvas, 0, 0)
    return
  }
  const copy = out.getContext('2d', { alpha: true })
  if (!copy) return
  copy.clearRect(0, 0, w, h)
  copy.drawImage(target.canvas, 0, 0)
}
