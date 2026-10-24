import type { PresetLook } from '../../../../shared/editor/stylePresets'
import { ANIMATED_GRADIENTS, drawAnimated } from '../../../../shared/engine/backgrounds'
import { styleContentRect, type Rect } from '../../../../shared/engine/layout'
import { drawWallpaper } from '../../../../shared/engine/wallpapers'
import type { DeviceFrame, StyleSettings } from '../../../../shared/types'
import { cardGeometry, paintBackground, paintCard, roundRectPath, type CardSpec, type Corners } from '../../render/staticLayer'

/**
 * Small pictures for the Style panel, drawn with the real render code (so a tile shows what
 * the video will look like) and kept as data URLs: each is drawn once per session.
 */

const cache = new Map<string, string>()
const SCALE = 2

function render(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): string {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const c = document.createElement('canvas')
  c.width = w * SCALE
  c.height = h * SCALE
  const ctx = c.getContext('2d')
  let url = ''
  if (ctx) {
    draw(ctx, c.width, c.height)
    url = c.toDataURL('image/png')
  }
  cache.set(key, url)
  return url
}

export const wallpaperThumb = (id: string): string => render(`wp:${id}`, 64, 40, (ctx, w, h) => drawWallpaper(ctx, w, h, id))

export const animatedThumb = (id: string): string =>
  render(`an:${id}`, 64, 40, (ctx, w, h) => drawAnimated(ctx, w, h, ANIMATED_GRADIENTS.find((a) => a.id === id) ?? ANIMATED_GRADIENTS[0], 3))

/** A stand-in app on the recording's screen: a light window with a sidebar and a few lines. */
function mockScreen(ctx: CanvasRenderingContext2D, r: Rect, radii: Corners): void {
  ctx.save()
  roundRectPath(ctx, r, radii)
  ctx.clip()
  ctx.fillStyle = '#f8fafc'
  ctx.fillRect(r.x, r.y, r.w, r.h)
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(r.x, r.y, r.w * 0.24, r.h)
  ctx.fillStyle = '#cbd5e1'
  for (let i = 0; i < 4; i++) ctx.fillRect(r.x + r.w * 0.32, r.y + r.h * (0.18 + i * 0.17), r.w * (i % 2 ? 0.4 : 0.55), Math.max(1, r.h * 0.07))
  ctx.fillStyle = '#8b5cf6'
  ctx.fillRect(r.x + r.w * 0.04, r.y + r.h * 0.14, r.w * 0.16, Math.max(1, r.h * 0.08))
  ctx.restore()
}

const BASE_STYLE: StyleSettings = { background: { type: 'gradient', preset: 'aurora' }, padding: 0.07, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' }

/** A whole look in miniature: background, card (shadow, border, frame) and a mock app on it. */
export function lookThumb(look: PresetLook): string {
  return render(`look:${JSON.stringify(look.style)}`, 112, 63, (ctx, w, h) => {
    const style: StyleSettings = { ...BASE_STYLE, ...look.style }
    paintBackground(ctx, w, h, style, null, 3)
    // A 16:9 recording; sizes as they would be on a 1080p video, scaled down.
    const k = Math.min(w, h) / 1080
    const rect = styleContentRect(w, h, 1600, 900, style)
    const spec: CardSpec = { style, rect, radius: style.cornerRadius * k, k, title: '' }
    const geom = cardGeometry(spec)
    paintCard(ctx, spec, geom, null, { w, h })
    mockScreen(ctx, rect, geom.screenRadii)
  })
}

/** A device frame on its own (no background), for the frame tiles. */
export function frameThumb(frame: DeviceFrame, portrait = false): string {
  return render(`frame:${frame.kind}:${frame.theme}:${portrait}`, 64, 40, (ctx, w, h) => {
    const style: StyleSettings = { ...BASE_STYLE, padding: 0.06, shadow: 0, frame }
    const rect = styleContentRect(w, h, portrait ? 900 : 1600, portrait ? 1600 : 900, style)
    const k = Math.min(w, h) / 360
    const spec: CardSpec = { style, rect, radius: 10 * k, k, title: '' }
    const geom = cardGeometry(spec)
    paintCard(ctx, spec, geom, null, { w, h })
    mockScreen(ctx, rect, geom.screenRadii)
  })
}
