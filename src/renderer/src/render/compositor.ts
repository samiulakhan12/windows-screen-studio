import type { SmoothedTrack } from '../../../shared/engine/cursor'
import { contentRect } from '../../../shared/engine/layout'
import { cameraAt, type Camera } from '../../../shared/engine/zoom'
import type { CursorTrack, Project } from '../../../shared/types'
import { blurSampleCount, cameraDisplacement, shutterTimes, speedAt } from '../../../shared/render/overlays'
import { drawCursorLayer } from './cursorLayer'
import type { FrameContext } from './frameContext'
import { paintStaticLayer, roundRectPath } from './staticLayer'
import { drawAnnotations, drawKeystrokes } from './textOverlays'
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
  const rect = contentRect(w, h, vw, vh, style.padding)
  const radius = style.cornerRadius * k
  paintStaticLayer(ctx, w, h, style, src.background, rect, radius, k, !!screen)

  const focus = cursor.valid ? scene.focusPath : null
  const cam = cameraAt(project.zooms, t, focus)

  ctx.save()
  roundRectPath(ctx, rect, radius)
  ctx.clip()
  if (screen) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const drawView = (c: Camera): void => {
      const viewX = c.cx - 0.5 / c.scale
      const viewY = c.cy - 0.5 / c.scale
      ctx.drawImage(screen.image, viewX * vw, viewY * vh, vw / c.scale, vh / c.scale, rect.x, rect.y, rect.w, rect.h)
    }
    const samples = motionSamples(project, t, cam, focus, rect, opts)
    if (samples.length <= 1) {
      drawView(cam)
    } else {
      // Average the sub-frames: sample k is blended in with weight 1/(k+1).
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
    radius,
    cam,
    // Normalised source coordinates -> output pixels, through the camera.
    toOut: (x, y) => ({ x: rect.x + (x - viewX) * cam.scale * rect.w, y: rect.y + (y - viewY) * cam.scale * rect.h })
  }

  drawCursorLayer(fc)
  ctx.restore()

  drawWebcamLayer(fc, project.webcam.show ? webcamImage(src) : null)

  drawKeystrokes(ctx, w, h, t, project, cursor)
  drawAnnotations(ctx, w, h, t, project)
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
  rect: { x: number; y: number; w: number; h: number },
  opts: Required<DrawOptions>
): Camera[] {
  const strength = project.effects.motionBlur
  if (!(strength > 0) || opts.blurSamples <= 1 || project.zooms.length === 0) return [cam]
  // One output frame covers `speed` times more source time on a sped-up clip.
  const shutter = strength * opts.frameInterval * speedAt(project.clips, t)
  const a = cameraAt(project.zooms, t - shutter / 2, focus)
  const b = cameraAt(project.zooms, t + shutter / 2, focus)
  const n = blurSampleCount(cameraDisplacement(a, b, rect), opts.blurSamples)
  if (n <= 1) return [cam]
  return shutterTimes(t, shutter, n).map((st) => cameraAt(project.zooms, st, focus))
}
