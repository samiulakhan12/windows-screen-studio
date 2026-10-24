import { webcamRect } from '../../../shared/engine/layout'
import type { FrameImage } from './compositor'
import type { FrameContext } from './frameContext'
import { drawCover, roundRectPath } from './staticLayer'

/** The webcam bubble, drawn over the whole frame (not affected by the zoom camera). */
export function drawWebcamLayer(fc: FrameContext, camera: FrameImage | null): void {
  const { ctx, project, w, h, k } = fc
  if (!project.webcam.show || !camera) return
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
