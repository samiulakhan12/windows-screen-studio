import { gradientById } from '../../../shared/engine/backgrounds'
import { activeClicks, clickPulse, cursorOpacity, type SmoothedTrack } from '../../../shared/engine/cursor'
import { contentRect, webcamRect, type Rect } from '../../../shared/engine/layout'
import { cameraAt } from '../../../shared/engine/zoom'
import type { CursorTrack, Project } from '../../../shared/types'

export interface RenderScene {
  project: Project
  cursor: CursorTrack
  /** Visible cursor path. */
  cursorPath: SmoothedTrack
  /** Heavier-smoothed path the zoom camera follows. */
  focusPath: SmoothedTrack
}

export interface RenderSources {
  screen: HTMLVideoElement
  webcam: HTMLVideoElement | null
  background: HTMLImageElement | null
}

// Arrow cursor outline, tip at (0,0), in units of 1/24 of the cursor height.
const ARROW = new Path2D('M0 0 L0 19 L4.6 14.6 L7.6 21.6 L10.8 20.2 L7.9 13.4 L14 13.4 Z')

function roundRectPath(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(radius, r.w / 2, r.h / 2))
}

function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource, iw: number, ih: number, r: Rect): void {
  const scale = Math.max(r.w / iw, r.h / ih)
  const sw = r.w / scale
  const sh = r.h / scale
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, r.x, r.y, r.w, r.h)
}

function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number, scene: RenderScene, src: RenderSources): void {
  const bg = scene.project.style.background
  if (bg.type === 'color') {
    ctx.fillStyle = bg.color
    ctx.fillRect(0, 0, w, h)
    return
  }
  if (bg.type === 'image' && src.background && src.background.naturalWidth > 0) {
    drawCover(ctx, src.background, src.background.naturalWidth, src.background.naturalHeight, { x: 0, y: 0, w, h })
    return
  }
  const preset = gradientById(bg.type === 'gradient' ? bg.preset : 'aurora')
  // CSS-style angle: 0deg points up, 90deg points right.
  const a = ((preset.angle - 90) * Math.PI) / 180
  const len = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))
  const dx = (Math.cos(a) * len) / 2
  const dy = (Math.sin(a) * len) / 2
  const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy)
  preset.stops.forEach((c, i) => g.addColorStop(i / (preset.stops.length - 1), c))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

/** Draws one output frame at recording time `t`. Pure with respect to (t, scene, sources). */
export function drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, scene: RenderScene, src: RenderSources): void {
  const { project, cursor } = scene
  const { style } = project
  const k = Math.min(w, h) / 1080
  const vw = src.screen.videoWidth || project.width
  const vh = src.screen.videoHeight || project.height

  ctx.save()
  ctx.clearRect(0, 0, w, h)
  drawBackground(ctx, w, h, scene, src)

  const rect = contentRect(w, h, vw, vh, style.padding)
  const radius = style.cornerRadius * k

  if (style.shadow > 0 && style.padding > 0) {
    ctx.save()
    ctx.shadowColor = `rgba(0,0,0,${0.55 * style.shadow})`
    ctx.shadowBlur = 70 * k * style.shadow
    ctx.shadowOffsetY = 22 * k * style.shadow
    ctx.fillStyle = '#000'
    roundRectPath(ctx, rect, radius)
    ctx.fill()
    ctx.restore()
  }

  const cam = cameraAt(project.zooms, t, cursor.valid ? scene.focusPath : null)
  const viewX = cam.cx - 0.5 / cam.scale
  const viewY = cam.cy - 0.5 / cam.scale

  ctx.save()
  roundRectPath(ctx, rect, radius)
  ctx.clip()
  ctx.fillStyle = '#000'
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
  if (src.screen.readyState >= 2) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src.screen, viewX * vw, viewY * vh, vw / cam.scale, vh / cam.scale, rect.x, rect.y, rect.w, rect.h)
  }

  // Normalised source coordinates -> output pixels, through the camera.
  const toOut = (x: number, y: number): { x: number; y: number } => ({
    x: rect.x + (x - viewX) * cam.scale * rect.w,
    y: rect.y + (y - viewY) * cam.scale * rect.h
  })

  if (project.cursor.show && cursor.valid && cursor.samples.length > 0) {
    if (project.cursor.clickEffect) {
      for (const { click, progress } of activeClicks(cursor.clicks, t)) {
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
    const opacity = project.cursor.hideWhenIdle ? cursorOpacity(cursor.samples, t) : 1
    if (opacity > 0.01) {
      const pos = scene.cursorPath.at(t)
      const p = toOut(pos.x, pos.y)
      // A real cursor is ~24px on the captured display; scale it with the content and the zoom.
      const size = (24 / vh) * rect.h * cam.scale * project.cursor.size * clickPulse(cursor.clicks, t)
      ctx.save()
      ctx.globalAlpha = opacity
      ctx.translate(p.x, p.y)
      ctx.scale(size / 24, size / 24)
      ctx.shadowColor = 'rgba(0,0,0,0.35)'
      ctx.shadowBlur = 4
      ctx.shadowOffsetY = 1.5
      ctx.fillStyle = '#111'
      ctx.fill(ARROW)
      ctx.shadowColor = 'transparent'
      ctx.lineJoin = 'round'
      ctx.lineWidth = 1.6
      ctx.strokeStyle = '#fff'
      ctx.stroke(ARROW)
      ctx.restore()
    }
  }
  ctx.restore()

  if (project.webcam.show && src.webcam && src.webcam.readyState >= 2 && src.webcam.videoWidth > 0) {
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
    drawCover(ctx, src.webcam, src.webcam.videoWidth, src.webcam.videoHeight, r)
    ctx.restore()
    ctx.save()
    roundRectPath(ctx, r, camRadius)
    ctx.lineWidth = 3 * k
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.stroke()
    ctx.restore()
  }
  ctx.restore()
}
