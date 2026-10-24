import { speedAt } from '../../../shared/render/overlays'
import {
  cursorSpotlightPresence,
  FEATHER_STOPS,
  featherRects,
  projectSpotlights,
  spotlightAlpha,
  spotlightArea,
  spotlightFeather,
  spotlightLevels,
  visibleCursorAt,
  type IntRect
} from '../../../shared/render/shapes'
import type { Spotlight } from '../../../shared/types'
import type { FrameContext } from './frameContext'

type Ctx = CanvasRenderingContext2D

/** Where a spotlight's lit area is on this frame (output pixels). */
interface Lit {
  shape: Spotlight['shape']
  cx: number
  cy: number
  rx: number
  ry: number
  feather: number
}

/** "How lit" (0..1) -> the colour painted there. */
type Paint = (lit: number) => string

/**
 * Darkens the recording outside the spotlights active at fc.t (inside the card's clip, over
 * the cursor and shapes). A cursor spotlight follows exactly the cursor viewers see (the one
 * the cursor layer draws, or the real one baked into the video), and fades out while that is
 * off the recording; a region spotlight stays on its content while the camera moves.
 * Spotlights fade in and out over SPOTLIGHT_FADE; several at once light up all their areas.
 */
export function drawSpotlightLayer(fc: FrameContext): void {
  const list = projectSpotlights(fc.project)
  if (list.length === 0) return
  const { t, project } = fc
  let first = -1
  let count = 0
  for (let i = 0; i < list.length; i++) {
    if (t >= list[i].start && t < list[i].end) {
      if (first < 0) first = i
      count++
    }
  }
  if (count === 0) return
  const speed = speedAt(project.clips, t)
  const { samples } = fc.cursor
  const path = fc.scene.cursorPath
  const cursor = fc.cursor.valid ? visibleCursorAt(project, samples, path, t) : null
  // A cursor spotlight fades out while the cursor is off the recording (the cursor layer hides it then).
  let presence = -1
  const alphaOf = (s: Spotlight): number => {
    const a = spotlightAlpha(s, t, speed)
    if (s.mode !== 'cursor' || !cursor || a <= 0) return a
    if (presence < 0) presence = cursorSpotlightPresence(project, samples, path, t)
    return a * presence
  }
  const { ctx } = fc
  ctx.save()
  if (count === 1) {
    // The usual case: one spotlight, painted straight onto the frame.
    const s = list[first]
    const dim = s.dim * alphaOf(s)
    if (dim > 0.002) paintField(ctx, litArea(fc, s, cursor), (lit) => `rgba(0,0,0,${(dim * (1 - lit)).toFixed(4)})`, { x0: 0, y0: 0, x1: fc.w, y1: fc.h })
    ctx.restore()
    return
  }
  // Several at once: darken a layer, clear every lit area out of it, then lay it over the frame.
  const active = list.filter((s) => t >= s.start && t < s.end)
  const levels = spotlightLevels(active.map((s) => ({ dim: s.dim, alpha: alphaOf(s) })))
  const layer = levels.dim > 0.002 ? layerFor(ctx, fc.w, fc.h) : null
  if (layer) {
    const l = layer.ctx
    l.globalCompositeOperation = 'source-over'
    l.clearRect(0, 0, fc.w, fc.h)
    l.fillStyle = '#000'
    l.fillRect(0, 0, fc.w, fc.h)
    l.globalCompositeOperation = 'destination-out'
    active.forEach((s, i) => {
      const clear = levels.clear[i]
      if (clear > 0.002) paintField(l, litArea(fc, s, cursor), (lit) => `rgba(0,0,0,${(clear * lit).toFixed(4)})`, null)
    })
    l.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = levels.dim
    ctx.drawImage(layer.canvas, 0, 0, fc.w, fc.h, 0, 0, fc.w, fc.h)
  }
  ctx.restore()
}

function litArea(fc: FrameContext, s: Spotlight, cursor: { x: number; y: number } | null): Lit {
  const area = spotlightArea(s, cursor)
  const a = fc.toOut(area.x, area.y)
  const b = fc.toOut(area.x + area.w, area.y + area.h)
  const rx = Math.max(1, Math.abs(b.x - a.x) / 2)
  const ry = Math.max(1, Math.abs(b.y - a.y) / 2)
  return { shape: s.shape, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, rx, ry, feather: spotlightFeather(s.feather, rx, ry) }
}

const layers = new WeakMap<Ctx, { canvas: HTMLCanvasElement; ctx: Ctx }>()

/** A frame-sized layer per target canvas, reused from frame to frame. */
function layerFor(target: Ctx, w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } | null {
  let layer = layers.get(target)
  if (layer && layer.canvas.width >= w && layer.canvas.height >= h) return layer
  if (typeof document === 'undefined') return null
  const canvas = layer?.canvas ?? document.createElement('canvas')
  canvas.width = Math.max(w, layer?.canvas.width ?? 0)
  canvas.height = Math.max(h, layer?.canvas.height ?? 0)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  layer = { canvas, ctx }
  layers.set(target, layer)
  return layer
}

/**
 * Paints how lit each pixel is (`paint`): fully lit inside the area, not at all outside it,
 * eased across the soft edge. With `cover`, the rest of that rectangle gets the unlit paint too.
 */
function paintField(ctx: Ctx, g: Lit, paint: Paint, cover: IntRect | null): void {
  if (g.shape === 'ellipse') ellipseField(ctx, g, paint, cover)
  else rectField(ctx, g, paint, cover)
}

function addStops(grad: CanvasGradient, paint: Paint): CanvasGradient {
  for (const [offset, lit] of FEATHER_STOPS) grad.addColorStop(offset, paint(lit))
  return grad
}

/** One radial gradient, in a space where the ellipse is the unit circle. */
function ellipseField(ctx: Ctx, g: Lit, paint: Paint, cover: IntRect | null): void {
  // The soft edge, in unit-circle radii (at least a pixel, so the outline is anti-aliased).
  const f = Math.max(g.feather / Math.min(g.rx, g.ry), 1 / Math.min(g.rx, g.ry))
  const r0 = Math.max(0, 1 - f / 2)
  const r1 = 1 + f / 2
  // Past r1 the gradient is its last stop: with `cover`, the gradient fills only the whole-pixel
  // box around the soft edge and the rest is painted solid (a full-frame gradient is slow without a GPU).
  let box = { x0: -r1, y0: -r1, x1: r1, y1: r1 }
  if (cover) {
    const px = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
    const b = {
      x0: px(Math.floor(g.cx - g.rx * r1), cover.x0, cover.x1),
      y0: px(Math.floor(g.cy - g.ry * r1), cover.y0, cover.y1),
      x1: px(Math.ceil(g.cx + g.rx * r1), cover.x0, cover.x1),
      y1: px(Math.ceil(g.cy + g.ry * r1), cover.y0, cover.y1)
    }
    ctx.fillStyle = paint(0)
    const fill = (x0: number, y0: number, x1: number, y1: number): void => {
      if (x1 > x0 && y1 > y0) ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    }
    fill(cover.x0, cover.y0, cover.x1, b.y0)
    fill(cover.x0, b.y1, cover.x1, cover.y1)
    fill(cover.x0, b.y0, b.x0, b.y1)
    fill(b.x1, b.y0, cover.x1, b.y1)
    box = { x0: (b.x0 - g.cx) / g.rx, y0: (b.y0 - g.cy) / g.ry, x1: (b.x1 - g.cx) / g.rx, y1: (b.y1 - g.cy) / g.ry }
  }
  ctx.save()
  ctx.translate(g.cx, g.cy)
  ctx.scale(g.rx, g.ry)
  ctx.fillStyle = addStops(ctx.createRadialGradient(0, 0, r0, 0, 0, r1), paint)
  if (box.x1 > box.x0 && box.y1 > box.y0) ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0)
  ctx.restore()
}

/**
 * A rectangle with a soft edge, from whole-pixel pieces that meet without seams: the lit core,
 * four edge bands (linear gradients), four rounded corners (radial gradients) and, with
 * `cover`, the unlit surroundings.
 */
function rectField(ctx: Ctx, g: Lit, paint: Paint, cover: IntRect | null): void {
  const { inner: I, outer: O } = featherRects(g.cx, g.cy, g.rx, g.ry, g.feather)
  const fill = (x0: number, y0: number, x1: number, y1: number, style: string | CanvasGradient): void => {
    if (x1 <= x0 || y1 <= y0) return
    ctx.fillStyle = style
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
  }
  const linear = (x0: number, y0: number, x1: number, y1: number): CanvasGradient => addStops(ctx.createLinearGradient(x0, y0, x1, y1), paint)
  fill(I.x0, I.y0, I.x1, I.y1, paint(1))
  fill(I.x0, O.y0, I.x1, I.y0, linear(0, I.y0, 0, O.y0))
  fill(I.x0, I.y1, I.x1, O.y1, linear(0, I.y1, 0, O.y1))
  fill(O.x0, I.y0, I.x0, I.y1, linear(I.x0, 0, O.x0, 0))
  fill(I.x1, I.y0, O.x1, I.y1, linear(I.x1, 0, O.x1, 0))
  const corner = (cx: number, cy: number, sx: number, sy: number): void => {
    const rx = Math.abs(sx)
    const ry = Math.abs(sy)
    if (rx < 1 || ry < 1) return
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(sx, sy)
    ctx.fillStyle = addStops(ctx.createRadialGradient(0, 0, 0, 0, 0, 1), paint)
    ctx.fillRect(0, 0, 1, 1)
    ctx.restore()
  }
  corner(I.x0, I.y0, O.x0 - I.x0, O.y0 - I.y0)
  corner(I.x1, I.y0, O.x1 - I.x1, O.y0 - I.y0)
  corner(I.x0, I.y1, O.x0 - I.x0, O.y1 - I.y1)
  corner(I.x1, I.y1, O.x1 - I.x1, O.y1 - I.y1)
  if (!cover) return
  const out = paint(0)
  fill(cover.x0, cover.y0, cover.x1, O.y0, out)
  fill(cover.x0, O.y1, cover.x1, cover.y1, out)
  fill(cover.x0, Math.max(cover.y0, O.y0), O.x0, Math.min(cover.y1, O.y1), out)
  fill(O.x1, Math.max(cover.y0, O.y0), cover.x1, Math.min(cover.y1, O.y1), out)
}
