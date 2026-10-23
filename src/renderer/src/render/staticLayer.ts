import { gradientById } from '../../../shared/engine/backgrounds'
import type { Rect } from '../../../shared/engine/layout'
import type { StyleSettings } from '../../../shared/types'

type Ctx = CanvasRenderingContext2D

export function roundRectPath(ctx: Ctx, r: Rect, radius: number): void {
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.max(0, Math.min(radius, r.w / 2, r.h / 2)))
}

export function drawCover(ctx: Ctx, img: CanvasImageSource, iw: number, ih: number, r: Rect): void {
  const scale = Math.max(r.w / iw, r.h / ih)
  const sw = r.w / scale
  const sh = r.h / scale
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, r.x, r.y, r.w, r.h)
}

function drawBackground(ctx: Ctx, w: number, h: number, style: StyleSettings, image: HTMLImageElement | null): void {
  const bg = style.background
  if (bg.type === 'color') {
    ctx.fillStyle = bg.color
    ctx.fillRect(0, 0, w, h)
    return
  }
  if (bg.type === 'image' && image && image.naturalWidth > 0) {
    drawCover(ctx, image, image.naturalWidth, image.naturalHeight, { x: 0, y: 0, w, h })
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

/** Everything behind the recording: background, drop shadow and the black content well. */
function paintStatic(ctx: Ctx, w: number, h: number, style: StyleSettings, image: HTMLImageElement | null, rect: Rect, radius: number, k: number): void {
  drawBackground(ctx, w, h, style, image)
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
  ctx.fillStyle = '#000'
  roundRectPath(ctx, rect, radius)
  ctx.fill()
}

interface CachedLayer {
  key: string
  image: HTMLImageElement | null
  canvas: HTMLCanvasElement
}

const layers = new WeakMap<Ctx, CachedLayer>()

/**
 * Paints the static part of a frame. The gradient and the large shadow blur are the
 * most expensive things in a frame (the shadow alone is a 140 px blur at 4K), and
 * they never change during playback or an export, so they are rendered once per
 * target canvas and reused until the size or style changes.
 */
export function paintStaticLayer(ctx: Ctx, w: number, h: number, style: StyleSettings, image: HTMLImageElement | null, rect: Rect, radius: number, k: number): void {
  if (typeof document === 'undefined') {
    paintStatic(ctx, w, h, style, image, rect, radius, k)
    return
  }
  const key = JSON.stringify([w, h, style.background, style.padding, style.shadow, radius, rect.x, rect.y, rect.w, rect.h, image?.naturalWidth ?? 0])
  let layer = layers.get(ctx)
  if (!layer || layer.key !== key || layer.image !== image) {
    const canvas = layer?.canvas ?? document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const lctx = canvas.getContext('2d', { alpha: false })
    if (!lctx) {
      paintStatic(ctx, w, h, style, image, rect, radius, k)
      return
    }
    paintStatic(lctx, w, h, style, image, rect, radius, k)
    layer = { key, image, canvas }
    layers.set(ctx, layer)
  }
  ctx.drawImage(layer.canvas, 0, 0)
}
