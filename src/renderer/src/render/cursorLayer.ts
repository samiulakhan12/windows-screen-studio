import { activeClicks, clickPulse, cursorAt, cursorOpacity } from '../../../shared/engine/cursor'
import type { Project } from '../../../shared/types'
import { cursorHeight, shapeAt, speedAt } from '../../../shared/render/overlays'
import { drawCursorSprite } from './cursorSprites'
import { inVideo, type FrameContext } from './frameContext'

/**
 * Click effects and the synthetic cursor, drawn inside the recording card (clipped to it)
 * through the zoom camera.
 */
export function drawCursorLayer(fc: FrameContext): void {
  const { ctx, project, cursor, t, k, cam, rect, vh } = fc
  if (!cursor.valid) return
  // Ripples also mark clicks over the OS cursor baked into the video.
  if (project.cursor.clickEffect && cursor.clicks.length > 0) {
    const speed = speedAt(project.clips, t)
    for (const { click, progress } of activeClicks(cursor.clicks, t, 0.45 * speed)) {
      if (!inVideo(click)) continue
      const p = fc.toOut(click.x, click.y)
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
    const pos = fc.scene.cursorPath.at(t)
    // Hide as soon as the recorded position leaves the video (cursor outside a window or
    // area, or over a window covering the recorded one) instead of letting the smoothed
    // cursor slide to the edge first.
    const raw = cursorAt(cursor.samples, t)
    if (opacity > 0.01 && inVideo(pos) && (!raw || inVideo(raw))) {
      const p = fc.toOut(pos.x, pos.y)
      const height = cursorHeight(rect.h, vh, cursor.scale, cam.scale, project.cursor.size) * clickPulse(cursor.clicks, t)
      drawCursorSprite(ctx, shapeAt(cursor.shapes, t), p.x, p.y, height, opacity, t)
    }
  }
}

/**
 * Loads images the cursor layer needs (a custom cursor image) before frames are rendered.
 * CONTRACT: the exporter awaits this before its first frame; the editor may call it when the
 * project's cursor settings change. Implemented by the cursor builder (no-op today).
 */
export async function prepareCursorAssets(_project: Project, _mediaUrl: (file: string) => string): Promise<void> {
  // No assets yet.
}
