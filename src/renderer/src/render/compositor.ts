import { animationTime, isAnimated } from '../../../shared/engine/backgrounds'
import type { SmoothedTrack } from '../../../shared/engine/cursor'
import { frameOf, frameTitle, screenCornerRadius } from '../../../shared/engine/deviceFrames'
import { styleContentRect, type Rect } from '../../../shared/engine/layout'
import { cameraAt, zoomStyleOf, type Camera, type ZoomStyle } from '../../../shared/engine/zoom'
import type { CursorTrack, Project } from '../../../shared/types'
import { blurSampleCount, cameraDisplacement, shutterTimes, speedAt } from '../../../shared/render/overlays'
import { drawCursorLayer } from './cursorLayer'
import type { FrameContext } from './frameContext'
import { cardGeometry, paintBackgroundLayer, paintCard, paintStaticLayer, roundRectPath, type CardSpec } from './staticLayer'
import { drawPrivacyLayer, drawShapesLayer } from './shapesLayer'
import { drawSpotlightLayer } from './spotlightLayer'
import { drawAnnotations, drawKeystrokes } from './textOverlays'
import { drawWatermarkLayer } from './watermarkLayer'
import { drawWebcamLayer } from './webcamLayer'

export interface RenderScene {
  project: Project
  cursor: CursorTrack
  /** Visible cursor path. */
  cursorPath: SmoothedTrack
  /** Heavier-smoothed path the zoom camera follows. */
  focusPath: SmoothedTrack
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
 * (t, scene, sources, options): preview and export call the same code.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  scene: RenderScene,
  src: RenderSources,
  options: DrawOptions = DEFAULT_OPTIONS
): void {
  const { project, cursor } = scene
  const { style } = project
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const k = Math.min(w, h) / 1080
  const screen = screenImage(src)
  const vw = screen?.width || src.screen.videoWidth || project.width
  const vh = screen?.height || src.screen.videoHeight || project.height

  ctx.save()
  const rect = styleContentRect(w, h, vw, vh, style)
  const radius = style.cornerRadius * k

  const focus = cursor.valid ? scene.focusPath : null
  const zoomStyle = zoomStyleOf(project)
  const cam = cameraAt(project.zooms, t, focus, zoomStyle)

  // Pulled back, the card shrinks onto the background: draw it (shadow, corners, device frame)
  // as vectors at its current size over the cached background. Otherwise use the cached static layer.
  const card = cardRect(rect, cam)
  const shrink = Math.min(1, cam.scale)
  const frame = frameOf(style)
  const spec: CardSpec = { style, rect: card, radius: radius * shrink, k: k * shrink, title: frame?.kind === 'browser' ? frameTitle(style, project.name) : '' }
  const geom = cardGeometry(spec)
  // Animated backgrounds run on output time, so they flow on smoothly across cuts.
  const bgTime = isAnimated(style.background) ? animationTime(project.clips, t) : 0
  if (cam.scale < 1) {
    const backdrop = paintBackgroundLayer(ctx, w, h, style, src.background, bgTime)
    paintCard(ctx, spec, geom, backdrop, { w, h })
  } else {
    paintStaticLayer(ctx, w, h, spec, geom, src.background, !!screen, bgTime)
  }

  ctx.save()
  roundRectPath(ctx, card, geom.screenRadii)
  ctx.clip()
  if (screen) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const drawView = (c: Camera): void => {
      const v = viewSource(c, rect)
      if (v) ctx.drawImage(screen.image, v.sx * vw, v.sy * vh, v.sw * vw, v.sh * vh, v.dx, v.dy, v.dw, v.dh)
    }
    const samples = motionSamples(project, t, cam, focus, rect, opts, zoomStyle)
    if (samples.length <= 1) {
      drawView(cam)
    } else {
      // Average the sub-frames: sample k is blended in with weight 1/(k+1). The largest view
      // goes first, so a shrinking card never averages in the black well at its edge.
      if (samples.some((c) => c.scale < 1)) samples.sort((a, b) => b.scale - a.scale)
      samples.forEach((c, i) => {
        ctx.globalAlpha = 1 / (i + 1)
        drawView(c)
      })
      ctx.globalAlpha = 1
    }
  }

  const viewX = cam.cx - 0.5 / cam.scale
  const viewY = cam.cy - 0.5 / cam.scale
  const fc: FrameContext = {
    ctx,
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
    screen,
    options: opts,
    // Normalised source coordinates -> output pixels, through the camera.
    toOut: (x, y) => ({ x: rect.x + (x - viewX) * cam.scale * rect.w, y: rect.y + (y - viewY) * cam.scale * rect.h })
  }

  drawPrivacyLayer(fc)
  drawCursorLayer(fc)
  drawShapesLayer(fc)
  drawSpotlightLayer(fc)
  ctx.restore()

  drawWebcamLayer(fc, project.webcam.show ? webcamImage(src) : null)

  drawKeystrokes(ctx, w, h, t, project, cursor)
  drawAnnotations(ctx, w, h, t, project)
  drawWatermarkLayer(fc)
  ctx.restore()
}

/**
 * Cameras to average for motion blur at `t`: one (no blur) while the camera is
 * still, otherwise enough sub-frames across the shutter interval that consecutive
 * samples are at most ~2 px apart. Static frames therefore cost nothing extra.
 */
function motionSamples(
  project: Project,
  t: number,
  cam: Camera,
  focus: SmoothedTrack | null,
  rect: Rect,
  opts: Required<DrawOptions>,
  style: ZoomStyle
): Camera[] {
  const strength = project.effects.motionBlur
  if (!(strength > 0) || opts.blurSamples <= 1 || project.zooms.length === 0) return [cam]
  // One output frame covers `speed` times more source time on a sped-up clip.
  const shutter = strength * opts.frameInterval * speedAt(project.clips, t)
  const a = cameraAt(project.zooms, t - shutter / 2, focus, style)
  const b = cameraAt(project.zooms, t + shutter / 2, focus, style)
  const n = blurSampleCount(cameraDisplacement(a, b, rect), opts.blurSamples)
  if (n <= 1) return [cam]
  return shutterTimes(t, shutter, n).map((st) => cameraAt(project.zooms, st, focus, style))
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
 */
export function viewSource(c: Camera, rect: Rect): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } | null {
  const viewX = c.cx - 0.5 / c.scale
  const viewY = c.cy - 0.5 / c.scale
  const sx = Math.max(0, viewX)
  const sy = Math.max(0, viewY)
  const ex = Math.min(1, viewX + 1 / c.scale)
  const ey = Math.min(1, viewY + 1 / c.scale)
  if (ex <= sx || ey <= sy) return null
  const px = c.scale * rect.w
  const py = c.scale * rect.h
  return { sx, sy, sw: ex - sx, sh: ey - sy, dx: rect.x + (sx - viewX) * px, dy: rect.y + (sy - viewY) * py, dw: (ex - sx) * px, dh: (ey - sy) * py }
}
