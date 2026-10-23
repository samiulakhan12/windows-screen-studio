import { activeClicks, clickPulse, cursorOpacity, type SmoothedTrack } from '../../../shared/engine/cursor'
import { contentRect, webcamRect } from '../../../shared/engine/layout'
import { cameraAt, type Camera } from '../../../shared/engine/zoom'
import type { CursorTrack, Project } from '../../../shared/types'
import { drawCursorSprite } from './cursorSprites'
import { blurSampleCount, cameraDisplacement, cursorHeight, shapeAt, shutterTimes, speedAt } from '../../../shared/render/overlays'
import { drawCover, paintStaticLayer, roundRectPath } from './staticLayer'
import { drawAnnotations, drawKeystrokes } from './textOverlays'

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
  // Normalised source coordinates -> output pixels, through the camera.
  const toOut = (x: number, y: number): { x: number; y: number } => ({
    x: rect.x + (x - viewX) * cam.scale * rect.w,
    y: rect.y + (y - viewY) * cam.scale * rect.h
  })

  if (cursor.valid) {
    // Ripples also mark clicks over the OS cursor baked into the video.
    if (project.cursor.clickEffect && cursor.clicks.length > 0) {
      const speed = speedAt(project.clips, t)
      for (const { click, progress } of activeClicks(cursor.clicks, t, 0.45 * speed)) {
        const p = toOut(click.x, click.y)
        ctx.beginPath()
        ctx.arc(p.x, p.y, (8 + 34 * progress) * k * cam.scale * 0.8, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,255,255,${0.35 * (1 - progress)})`
        ctx.fill()
        ctx.lineWidth = 2.5 * k
        ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - progress)})`
        ctx.stroke()
      }
    }
    // With the OS cursor baked into the video (Chromium capture), a synthetic cursor
    // and idle-hiding would only draw a second, lagging cursor next to it.
    if (project.cursor.show && !project.capture?.cursorInVideo && cursor.samples.length > 0) {
      const opacity = project.cursor.hideWhenIdle ? cursorOpacity(cursor.samples, t) : 1
      if (opacity > 0.01) {
        const pos = scene.cursorPath.at(t)
        const p = toOut(pos.x, pos.y)
        const height = cursorHeight(rect.h, vh, cursor.scale, cam.scale, project.cursor.size) * clickPulse(cursor.clicks, t)
        drawCursorSprite(ctx, shapeAt(cursor.shapes, t), p.x, p.y, height, opacity, t)
      }
    }
  }
  ctx.restore()

  const camera = project.webcam.show ? webcamImage(src) : null
  if (camera) {
    const r = webcamRect(w, h, project.webcam)
    const camRadius = project.webcam.shape === 'circle' ? r.w / 2 : r.w * 0.18
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.4)'
    ctx.shadowBlur = 30 * k
    ctx.shadowOffsetY = 10 * k
    ctx.fillStyle = '#000'
    roundRectPath(ctx, r, camRadius)
    ctx.fill()
    ctx.restore()
    ctx.save()
    roundRectPath(ctx, r, camRadius)
    ctx.clip()
    // Mirror the camera like a selfie view.
    ctx.translate(r.x * 2 + r.w, 0)
    ctx.scale(-1, 1)
    drawCover(ctx, camera.image, camera.width, camera.height, r)
    ctx.restore()
    ctx.save()
    roundRectPath(ctx, r, camRadius)
    ctx.lineWidth = 3 * k
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.stroke()
    ctx.restore()
  }

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
