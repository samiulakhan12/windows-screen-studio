import { animationTime, isAnimated } from '../../../shared/engine/backgrounds'
import type { SmoothedTrack } from '../../../shared/engine/cursor'
import { croppedFrameSize, cropPixels } from '../../../shared/engine/crop'
import { frameOf, frameTitle, screenCornerRadius } from '../../../shared/engine/deviceFrames'
import { frameCamera, frameView, followGain } from '../../../shared/engine/frameView'
import { intersectRect, type Rect, type SceneLayout } from '../../../shared/engine/layout'
import { toOutput } from '../../../shared/engine/outputPoint'
import type { Camera } from '../../../shared/engine/zoom'
import type { CursorTrack, NormRect, Project } from '../../../shared/types'
import { blurSampleCount, cameraDisplacement, shutterTimes, speedAt } from '../../../shared/render/overlays'
import { textArea } from '../../../shared/render/safeZones'
import { drawCursorLayer } from './cursorLayer'
import type { FrameContext } from './frameContext'
import { cardGeometry, paintBackgroundLayer, paintCardLayer, paintStaticLayer, paintStillCard, roundRectPath, type CardSpec } from './staticLayer'
import { drawPrivacyLayer, drawShapesLayer } from './shapesLayer'
import { drawSpotlightLayer } from './spotlightLayer'
import { beginTiltedCard, drawTiltedCard } from './tiltLayer'
import { drawAnnotations, drawKeystrokes } from './textOverlays'
import { drawCaptionsLayer } from './captionsLayer'
import { drawGraphicsLayer } from './graphicsLayer'
import { noteStudioFrame } from './studioLayer'
import { drawTitleCardsLayer } from './titleCardLayer'
import { drawWatermarkLayer } from './watermarkLayer'
import { drawWebcamLayer } from './webcamLayer'
import { drawOverlaysLayer } from './overlayLayer'
import { planOf, videoTimeAt } from '../../../shared/engine/freeze'
import { punchedCamera, type JoinAt } from '../../../shared/render/joins'
import { beginJoin, endJoin } from './joinLayer'
import { drawMagnifierLayer } from './magnifierLayer'
import { drawChapterBar } from './chapterBarLayer'
import { gradeScreen } from './gradeLayer'
import { lutFor } from './lutCache'

export interface RenderScene {
  project: Project
  cursor: CursorTrack
  /** Visible cursor path. */
  cursorPath: SmoothedTrack
  /** Heavier-smoothed path the zoom camera follows. */
  focusPath: SmoothedTrack
  /** The crop of each decoded screen frame that is drawn (cropOf; the view's positions are relative to it); absent = all of it. */
  crop?: NormRect
  /** The preview's Compare (docs/design/editing-polish.md §2.5): the pictures drawn without their colour. Never saved, never set by the export. */
  compare?: boolean
}

/** A decoded frame and its display size. */
export interface FrameImage {
  image: CanvasImageSource
  width: number
  height: number
}

export interface RenderSources {
  screen: HTMLVideoElement
  webcam: HTMLVideoElement | null
  background: HTMLImageElement | null
  /** Decoded screen frame to draw instead of the screen element's current frame (export). */
  screenFrame?: FrameImage | null
  /** Decoded camera frame to draw instead of the webcam element's current frame (export). */
  webcamFrame?: FrameImage | null
}

export interface DrawOptions {
  /** Source seconds one output frame covers at 1x speed (1 / fps). Default 1/60. */
  frameInterval?: number
  /**
   * Most sub-frames used for motion blur; 1 disables it. Default 4 (interactive
   * preview); export passes more for smoother blur.
   */
  blurSamples?: number
}

const DEFAULT_OPTIONS: Required<DrawOptions> = { frameInterval: 1 / 60, blurSamples: 4 }

/** What a frame needs beyond its time (docs/design/editing-polish.md §5.6). */
export interface FrameExtras {
  /** Video seconds of this frame (holds included). Absent: videoTimeAt(soundTime) (wrong only inside a pause hold). */
  video?: number
  /** The join this frame is in (joinAt) and A* as composed (composeJoinStill); a null still draws a hard cut. */
  join?: { at: JoinAt; still: CanvasImageSource | null } | null
}

function screenImage(src: RenderSources): FrameImage | null {
  if (src.screenFrame) return src.screenFrame
  const v = src.screen
  if (v.readyState < 2 || v.videoWidth === 0) return null
  return { image: v, width: v.videoWidth, height: v.videoHeight }
}

function webcamImage(src: RenderSources): FrameImage | null {
  if (src.webcamFrame) return src.webcamFrame
  const v = src.webcam
  if (!v || v.readyState < 2 || v.videoWidth === 0) return null
  return { image: v, width: v.videoWidth, height: v.videoHeight }
}

/**
 * Draws one output frame at recording (source) time `t`. Pure with respect to
 * (t, scene, sources, options): preview and export call the same code. What the frame shows (the
 * project as drawn, the layout and the camera) comes from frameView, so a view that follows the
 * action (docs/design/vertical-video.md) is drawn the same way in both.
 *
 * The picture (drawFramePicture) and what goes over it (drawFrameOverlays) are drawn in turn; a
 * frame inside a cut's join (docs/design/editing-polish.md §5.6) has the join drawn between them,
 * so captions, texts, titles and graphics are never faded, moved or doubled by it.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  scene: RenderScene,
  src: RenderSources,
  options: DrawOptions = DEFAULT_OPTIONS,
  /**
   * Source time of the sound at this frame (E-11 freeze frames): while the picture holds `t`, the
   * burned-in captions and the animated background follow it. Defaults to `t`.
   */
  soundTime: number = t,
  /** The frame's video time and its join (editing polish); absent for every frame outside a join. */
  extras?: FrameExtras
): void {
  const join = extras?.join ?? null
  if (join) beginJoin(ctx, w, h, join)
  const top = drawFramePicture(ctx, w, h, t, scene, src, options, soundTime)
  if (join) endJoin(ctx, w, h, join)
  // Only the progress bar reads the video time (a pause hold included): worked out for it alone.
  const video = extras?.video ?? (top.project.chapterBar?.show ? videoTimeAt(top.project.clips, planOf(top.project), soundTime) : soundTime)
  drawFrameOverlays(top, soundTime, video)
  ctx.restore()
}

/**
 * The frame's picture: the background, the card and the recording on it (graded, through the
 * camera, with privacy shapes, the cursor, magnifiers, shapes and spotlights), the 3D tilt and the
 * camera. Returns the frame context the overlays draw with. Leaves `ctx` saved once: drawFrame
 * restores it after the overlays (a caller drawing the picture alone, such as A* of a join,
 * restores it itself).
 */
export function drawFramePicture(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  scene: RenderScene,
  src: RenderSources,
  options: DrawOptions = DEFAULT_OPTIONS,
  soundTime: number = t
): FrameContext {
  const { cursor } = scene
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const k = Math.min(w, h) / 1080
  const full = screenImage(src)
  // A crop is drawn from a 1:1 copy of its pixels (cropFrame), so nothing outside it is ever sampled.
  const crop = scene.crop ?? null
  const cropped = full && crop ? cropFrame(ctx, full, crop) : full
  // The screen's colour (editing polish §9.1), graded once from that copy: everything below draws
  // the graded picture. Without a grade it is the picture itself.
  const grade = scene.project.grade?.screen
  const screen = cropped && grade ? gradeScreen(ctx, cropped, grade, lutFor(scene.project, 'screen'), scene.compare) : cropped
  const shown = croppedFrameSize(crop, src.screen.videoWidth, src.screen.videoHeight, scene.project)
  const vw = screen?.width || shown.width
  const vh = screen?.height || shown.height

  ctx.save()
  // While following: framed zooms, no device frame or tilt; the recording drawn into the virtual
  // rectangle around the screen's slot, the camera resting on the follow plan. A punch-in at a cut
  // (editing polish §5.6) shows the content closer: the camera, not the composition.
  const view = frameView(scene, w, h, vw, vh, t)
  const { project, layout } = view
  const cam = punchedCamera(view.cam, project, t)
  const { style } = project
  const rect = layout.screen
  const slot = layout.follow?.slot
  const radius = style.cornerRadius * k

  const focus = cursor.valid ? scene.focusPath : null

  // Pulled back, or moved by a camera layout change, the card is drawn (shadow, corners, device frame)
  // at its current size over the cached background, cached once it holds still (a layout change
  // stretches its shadow from a sprite: paintStillCard). Otherwise use the cached static layer.
  // Following, the card is what of the recording the slot shows: the slot itself unless pulled
  // back, at full size (the recording always spans the slot one way or the other).
  const card = slot ? intersectRect(slot, cardRect(rect, cam)) : cardRect(rect, cam)
  const shrink = slot ? 1 : Math.min(1, cam.scale)
  const frame = frameOf(style)
  const spec: CardSpec = { style, rect: card, radius: radius * shrink, k: k * shrink, title: frame?.kind === 'browser' ? frameTitle(style, project.name) : '' }
  const geom = cardGeometry(spec)
  // Animated backgrounds run on output time, so they flow on smoothly across cuts.
  const bgTime = isAnimated(style.background) ? animationTime(project.clips, soundTime) : 0
  // With the 3D tilt on, the card and everything on it is painted on a canvas of its own (`c`)
  // over the plain background, then warped onto the frame. Off (or flat at t), `c` is the frame.
  const tilted = beginTiltedCard(ctx, w, h, t, project, cam, focus, spec, geom, vw, vh)
  const c = tilted ? tilted.ctx : ctx
  const layoutMove = layout.moving
  const moving = cam.scale < 1 || layoutMove
  if (tilted) {
    const backdrop = paintBackgroundLayer(ctx, w, h, style, src.background, bgTime)
    if (moving) paintStillCard(c, w, h, spec, geom, backdrop, layoutMove)
    else paintCardLayer(c, w, h, spec, geom, backdrop, true)
  } else if (moving) {
    const backdrop = paintBackgroundLayer(ctx, w, h, style, src.background, bgTime)
    paintStillCard(ctx, w, h, spec, geom, backdrop, layoutMove)
  } else {
    paintStaticLayer(ctx, w, h, spec, geom, src.background, !!screen, bgTime)
  }

  c.save()
  roundRectPath(c, card, geom.screenRadii)
  c.clip()
  if (screen) {
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    let image = screen.image
    const drawView = (view: Camera): void => {
      const v = viewSource(view, rect, slot)
      if (v) c.drawImage(image, v.sx * vw, v.sy * vh, v.sw * vw, v.sh * vh, v.dx, v.dy, v.dw, v.dh)
    }
    const samples = motionSamples(scene, project, layout, t, cam, opts).map((s) => (s === cam ? s : punchedCamera(s, project, t)))
    if (samples.length <= 1) {
      drawView(cam)
    } else {
      // Average the sub-frames: sample k is blended in with weight 1/(k+1). The largest view
      // goes first, so a shrinking card never averages in the black well at its edge.
      if (samples.some((s) => s.scale < 1)) samples.sort((a, b) => b.scale - a.scale)
      // Each draw of a video frame converts it to RGB again (costly without a GPU): convert it once
      // (a crop's copy is one already). Bilinear from that copy matches the video draws (the
      // averaging softens them anyway); a canvas source with 'high' would take the slow cubic path.
      const copied = screen !== full
      const rgb = copied ? null : rgbCopy(c, screen, vw, vh)
      if (rgb) image = rgb
      if (rgb || copied) c.imageSmoothingQuality = 'low'
      samples.forEach((s, i) => {
        c.globalAlpha = 1 / (i + 1)
        drawView(s)
      })
      c.globalAlpha = 1
    }
  }

  const fc: FrameContext = {
    ctx: c,
    w,
    h,
    t,
    k,
    scene,
    project,
    cursor,
    focus,
    vw,
    vh,
    rect,
    radius: frame ? screenCornerRadius(frame, rect, radius) : radius,
    cam,
    layout,
    following: !!slot,
    textArea: textArea(project, w, h, vw, vh, t),
    fxGain: slot ? followGain(layout, w, h, vw, vh, style.padding) : 1,
    screen,
    sourceH: full?.height,
    options: opts,
    background: src.background,
    // Normalised source coordinates -> output pixels, through the camera (as the camera director measures them).
    toOut: toOutput(rect, cam)
  }

  drawPrivacyLayer(fc)
  drawCursorLayer(fc)
  // Magnifiers (editing polish §6.4): over the cursor, under the shapes; nothing without one.
  drawMagnifierLayer(fc)
  drawShapesLayer(fc)
  drawSpotlightLayer(fc)
  c.restore()

  // Everything from here on is drawn flat over the (tilted) card.
  let top = fc
  if (tilted) {
    drawTiltedCard(ctx, w, h, tilted)
    top = { ...fc, ctx }
  }

  drawWebcamLayer(top, project.webcam.show ? webcamImage(src) : null)
  return top
}

/**
 * What goes over the picture, in order: image overlays, key presses, texts, graphics, captions,
 * title cards, the progress bar (at video time `video`) and the watermark. Captions and graphics
 * run on the sound's clock, `soundTime`.
 */
export function drawFrameOverlays(top: FrameContext, soundTime: number, video: number): void {
  const { ctx, w, h, t, project, cursor } = top
  drawOverlaysLayer(top)

  // Captions and graphics run on the sound's clock (E-11 freezes; Captions Studio §9.1 rule 6).
  const spoken = soundTime === t ? top : { ...top, t: soundTime }
  // Key presses ask where a Captions Studio block is before it is drawn: it is placed with this frame's obstacles.
  noteStudioFrame(spoken)
  drawKeystrokes(ctx, w, h, t, project, cursor, top.textArea)
  drawAnnotations(ctx, w, h, t, project, top)
  drawGraphicsLayer(spoken)
  drawCaptionsLayer(spoken)
  drawTitleCardsLayer(top)
  // The progress bar (editing polish §8): under the watermark; nothing without chapterBar.show.
  drawChapterBar(top, video)
  drawWatermarkLayer(top)
}

const cropCopies = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>()

/**
 * The crop's pixels of `frame` copied 1:1 into a reused canvas (per target), or null without a
 * DOM (the frame is then treated as not decoded yet). Drawing from the copy keeps every sample
 * inside the crop: filtering a source rectangle may read pixels beyond it (the edge of a hidden
 * taskbar would bleed into the card), and privacy blur would pull them in.
 */
function cropFrame(target: CanvasRenderingContext2D, frame: FrameImage, crop: NormRect): FrameImage | null {
  if (typeof document === 'undefined') return null
  const px = cropPixels(crop, frame.width, frame.height)
  let canvas = cropCopies.get(target)
  if (!canvas) {
    canvas = document.createElement('canvas')
    cropCopies.set(target, canvas)
  }
  if (canvas.width !== px.w || canvas.height !== px.h) {
    canvas.width = px.w
    canvas.height = px.h
  }
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(frame.image, px.x, px.y, px.w, px.h, 0, 0, px.w, px.h)
  return { image: canvas, width: px.w, height: px.h }
}

const rgbCopies = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>()

/** The frame copied once into a reused canvas of its own size (per target), or null without one. */
function rgbCopy(target: CanvasRenderingContext2D, frame: FrameImage, vw: number, vh: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  let canvas = rgbCopies.get(target)
  if (!canvas) {
    canvas = document.createElement('canvas')
    rgbCopies.set(target, canvas)
  }
  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width = vw
    canvas.height = vh
  }
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null
  ctx.drawImage(frame.image, 0, 0, vw, vh)
  return canvas
}

/**
 * Cameras to average for motion blur at `t`: one (no blur) while the camera is
 * still, otherwise enough sub-frames across the shutter interval that consecutive
 * samples are at most ~2 px apart. Static frames therefore cost nothing extra.
 * While following, the view pans without zooms too, and the movement is measured at the
 * slot's corners (what is shown) rather than the larger virtual rectangle's; every sub-frame
 * reads the view of the frame's own clip (`at` = t), never the next one's across a cut.
 */
function motionSamples(scene: RenderScene, project: Project, layout: SceneLayout, t: number, cam: Camera, opts: Required<DrawOptions>): Camera[] {
  const strength = project.effects.motionBlur
  const slot = layout.follow?.slot
  if (!(strength > 0) || opts.blurSamples <= 1 || (!slot && project.zooms.length === 0)) return [cam]
  // One output frame covers `speed` times more source time on a sped-up clip.
  const shutter = strength * opts.frameInterval * speedAt(project.clips, t)
  const a = frameCamera(scene, layout, t - shutter / 2, t)
  const b = frameCamera(scene, layout, t + shutter / 2, t)
  const n = blurSampleCount(cameraDisplacement(a, b, layout.screen, slot), opts.blurSamples)
  if (n <= 1) return [cam]
  return shutterTimes(t, shutter, n).map((st) => frameCamera(scene, layout, st, t))
}

/**
 * Where the recording card is on screen: the layout rectangle, or while pulled back
 * (scale < 1) the smaller rectangle the whole recording occupies inside it.
 */
export function cardRect(rect: Rect, cam: Camera): Rect {
  if (cam.scale >= 1) return rect
  const viewX = cam.cx - 0.5 / cam.scale
  const viewY = cam.cy - 0.5 / cam.scale
  return { x: rect.x - viewX * cam.scale * rect.w, y: rect.y - viewY * cam.scale * rect.h, w: rect.w * cam.scale, h: rect.h * cam.scale }
}

/**
 * The part of the source (normalised) a camera shows and where it lands (output px),
 * clipped to the source itself: pulled back, the viewport is larger than the recording.
 * `clip`: also clipped to this part of the frame (the slot of a view that follows the action,
 * docs/design/vertical-video.md §8.2); absent, as always.
 */
export function viewSource(c: Camera, rect: Rect, clip?: Rect): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } | null {
  const viewX = c.cx - 0.5 / c.scale
  const viewY = c.cy - 0.5 / c.scale
  const px = c.scale * rect.w
  const py = c.scale * rect.h
  let sx = Math.max(0, viewX)
  let sy = Math.max(0, viewY)
  let ex = Math.min(1, viewX + 1 / c.scale)
  let ey = Math.min(1, viewY + 1 / c.scale)
  if (clip) {
    // The source under the clip's edges (where the output's pixels are), so no more is sampled than is shown.
    sx = Math.max(sx, viewX + (clip.x - rect.x) / px)
    sy = Math.max(sy, viewY + (clip.y - rect.y) / py)
    ex = Math.min(ex, viewX + (clip.x + clip.w - rect.x) / px)
    ey = Math.min(ey, viewY + (clip.y + clip.h - rect.y) / py)
  }
  if (ex <= sx || ey <= sy) return null
  return { sx, sy, sw: ex - sx, sh: ey - sy, dx: rect.x + (sx - viewX) * px, dy: rect.y + (sy - viewY) * py, dw: (ex - sx) * px, dh: (ey - sy) * py }
}
