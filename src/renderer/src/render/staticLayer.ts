import { animatedById, animatedSpeed, backgroundBlur, blurRadius, drawAnimated, drawGradient, gradientById, isAnimated } from '../../../shared/engine/backgrounds'
import { cardLook, shadowPaint, shadowReach, type ShadowPaint } from '../../../shared/engine/cardStyle'
import { deviceFrameDrawing, frameOf, frameTakesBorder, type FrameDrawing, type FramePart, type Paint, type Radii } from '../../../shared/engine/deviceFrames'
import type { Rect } from '../../../shared/engine/layout'
import { drawWallpaper } from '../../../shared/engine/wallpapers'
import type { CardBorder, DeviceFrame, StyleSettings } from '../../../shared/types'

type Ctx = CanvasRenderingContext2D

/** One radius for every corner, or one per corner (top-left, top-right, bottom-right, bottom-left). */
export type Corners = number | Radii

const clampCorner = (v: number, r: Rect): number => Math.max(0, Math.min(v, r.w / 2, r.h / 2))

function addRoundRect(ctx: Ctx, r: Rect, radius: Corners): void {
  if (typeof radius === 'number') ctx.roundRect(r.x, r.y, r.w, r.h, clampCorner(radius, r))
  else ctx.roundRect(r.x, r.y, r.w, r.h, radius.map((v) => clampCorner(v, r)))
}

export function roundRectPath(ctx: Ctx, r: Rect, radius: Corners): void {
  ctx.beginPath()
  addRoundRect(ctx, r, radius)
}

const maxCorner = (radius: Corners): number => (typeof radius === 'number' ? radius : Math.max(...radius))

export function drawCover(ctx: Ctx, img: CanvasImageSource, iw: number, ih: number, r: Rect): void {
  const scale = Math.max(r.w / iw, r.h / ih)
  const sw = r.w / scale
  const sh = r.h / scale
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, r.x, r.y, r.w, r.h)
}

const canBlur = (): boolean => typeof document !== 'undefined'

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w))
  c.height = Math.max(1, Math.ceil(h))
  return c
}

/** Blurred backgrounds are blurred at a quarter of the frame's size (identical look at any size, far cheaper). */
const BLUR_SCALE = 0.25

/**
 * A blurred picture: `paint` draws the picture into a w x h frame. It is drawn small with a
 * margin around it (so the blur does not fade to transparent at the frame's edges), blurred
 * once, and returned with the part that maps onto the frame. Done when a cached layer is
 * built, never per frame.
 */
export interface Blurred {
  canvas: HTMLCanvasElement
  sx: number
  sy: number
  sw: number
  sh: number
}

function blurredPicture(w: number, h: number, sigma: number, paint: (c: Ctx, w: number, h: number) => void): Blurred | null {
  const sw = Math.max(1, Math.ceil(w * BLUR_SCALE))
  const sh = Math.max(1, Math.ceil(h * BLUR_SCALE))
  const s = Math.max(0.5, sigma * BLUR_SCALE)
  const m = Math.ceil(s * 3)
  const src = canvas(sw + m * 2, sh + m * 2)
  const sctx = src.getContext('2d')
  const out = canvas(sw + m * 2, sh + m * 2)
  const octx = out.getContext('2d')
  if (!sctx || !octx) return null
  paint(sctx, src.width, src.height)
  octx.filter = `blur(${s}px)`
  octx.drawImage(src, 0, 0)
  octx.filter = 'none'
  return { canvas: out, sx: m, sy: m, sw, sh }
}

const drawBlurred = (ctx: Ctx, b: Blurred, w: number, h: number): void => {
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(b.canvas, b.sx, b.sy, b.sw, b.sh, 0, 0, w, h)
}

/**
 * Paints the background over the whole frame, uncached (the layers below cache it). Animated
 * gradients are painted at `t`; an image that has not loaded yet shows the default gradient.
 */
export function paintBackground(ctx: Ctx, w: number, h: number, style: StyleSettings, image: HTMLImageElement | null, t = 0): void {
  const bg = style.background
  if (bg.type === 'color') {
    ctx.fillStyle = bg.color
    ctx.fillRect(0, 0, w, h)
    return
  }
  const blur = backgroundBlur(bg)
  if (bg.type === 'image' && image && image.naturalWidth > 0) {
    const paint = (c: Ctx, cw: number, ch: number): void => drawCover(c, image, image.naturalWidth, image.naturalHeight, { x: 0, y: 0, w: cw, h: ch })
    const b = blur > 0 && canBlur() ? blurredPicture(w, h, blurRadius(blur, w, h), paint) : null
    if (b) drawBlurred(ctx, b, w, h)
    else paint(ctx, w, h)
    return
  }
  if (bg.type === 'wallpaper') {
    const paint = (c: Ctx, cw: number, ch: number): void => drawWallpaper(c, cw, ch, bg.id)
    const b = blur > 0 && canBlur() ? blurredPicture(w, h, blurRadius(blur, w, h), paint) : null
    if (b) drawBlurred(ctx, b, w, h)
    else paint(ctx, w, h)
    return
  }
  if (bg.type === 'animated') {
    drawAnimated(ctx, w, h, animatedById(bg.preset), t, animatedSpeed(bg))
    return
  }
  drawGradient(ctx, w, h, gradientById(bg.type === 'gradient' ? bg.preset : 'aurora'))
}

/* ---------- the card: shadow, border, device frame, content well ---------- */

/** What the card is drawn from: the style, where the recording is (output px) and its corner radius. */
export interface CardSpec {
  style: StyleSettings
  rect: Rect
  radius: number
  /** Scale of 1080p-referenced sizes (shadow, border); smaller while the card is pulled back. */
  k: number
  /** Address bar text of a browser frame. */
  title: string
}

export interface CardGeometry {
  frame: DeviceFrame | null
  drawing: FrameDrawing | null
  /** Shapes casting the shadow; the first is the body a border goes around. */
  outline: { rect: Rect; radii: Corners }[]
  /** Corners of the recording itself. */
  screenRadii: Corners
}

export function cardGeometry(spec: CardSpec): CardGeometry {
  const frame = frameOf(spec.style)
  if (!frame) return { frame: null, drawing: null, outline: [{ rect: spec.rect, radii: spec.radius }], screenRadii: spec.radius }
  const drawing = deviceFrameDrawing(frame, spec.rect, { radius: spec.radius, title: spec.title })
  return { frame, drawing, outline: drawing.outline, screenRadii: drawing.screenRadii }
}

const grow = (s: { rect: Rect; radii: Corners }, d: number): { rect: Rect; radii: Corners } => ({
  rect: { x: s.rect.x - d, y: s.rect.y - d, w: s.rect.w + d * 2, h: s.rect.h + d * 2 },
  radii: typeof s.radii === 'number' ? clampCorner(s.radii, s.rect) + d : (s.radii.map((v) => clampCorner(v, s.rect) + d) as Radii)
})

function shapesPath(ctx: Ctx, shapes: { rect: Rect; radii: Corners }[], dx = 0, dy = 0): void {
  ctx.beginPath()
  for (const s of shapes) addRoundRect(ctx, { x: s.rect.x + dx, y: s.rect.y + dy, w: s.rect.w, h: s.rect.h }, s.radii)
}

/**
 * The card's shadow. `outsideOnly` keeps it off the card itself (needed under a see-through
 * glass border); otherwise it is cast by a black copy of the card, which the card then covers.
 */
function paintShadow(ctx: Ctx, shapes: { rect: Rect; radii: Corners }[], paint: ShadowPaint, outsideOnly: boolean, w: number, h: number): void {
  ctx.save()
  if (outsideOnly) {
    ctx.beginPath()
    ctx.rect(-w, -h, w * 3, h * 3)
    for (const s of shapes) addRoundRect(ctx, s.rect, s.radii)
    ctx.clip('evenodd')
  }
  if (paint.kind === 'solid') {
    ctx.fillStyle = paint.color
    shapesPath(ctx, shapes, paint.offsetX, paint.offsetY)
    ctx.fill()
  } else {
    ctx.shadowColor = paint.color
    ctx.shadowBlur = paint.blur
    if (paint.offsetX) ctx.shadowOffsetX = paint.offsetX
    ctx.shadowOffsetY = paint.offsetY
    ctx.fillStyle = '#000'
    shapesPath(ctx, shapes)
    ctx.fill()
  }
  ctx.restore()
}

function paintBorder(ctx: Ctx, body: { rect: Rect; radii: Corners }, border: CardBorder, bw: number, k: number, backdrop: Blurred | null, w: number, h: number): void {
  const outer = grow(body, bw)
  const ring = (): void => {
    ctx.beginPath()
    addRoundRect(ctx, outer.rect, outer.radii)
    addRoundRect(ctx, body.rect, body.radii)
  }
  if (!border.glass) {
    ctx.fillStyle = border.color
    ring()
    ctx.fill('evenodd')
    return
  }
  // Frosted glass: the blurred background behind a milky, slightly brighter-at-the-top tint.
  ctx.save()
  ring()
  ctx.clip('evenodd')
  if (backdrop) drawBlurred(ctx, backdrop, w, h)
  const g = ctx.createLinearGradient(0, outer.rect.y, 0, outer.rect.y + outer.rect.h)
  g.addColorStop(0, 'rgba(255,255,255,0.42)')
  g.addColorStop(1, 'rgba(255,255,255,0.2)')
  ctx.fillStyle = g
  ctx.fillRect(outer.rect.x, outer.rect.y, outer.rect.w, outer.rect.h)
  ctx.restore()
  ctx.save()
  ctx.lineWidth = Math.max(1, k)
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'
  roundRectPath(ctx, outer.rect, outer.radii)
  ctx.stroke()
  ctx.restore()
}

function paintOf(ctx: Ctx, p: Paint): string | CanvasGradient {
  if (typeof p === 'string') return p
  const g = ctx.createLinearGradient(p.x0, p.y0, p.x1, p.y1)
  for (const [o, c] of p.stops) g.addColorStop(o, c)
  return g
}

/** `text` shortened with an ellipsis until it fits `max` px in the current font. */
function fitText(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : ''
}

function paintParts(ctx: Ctx, parts: FramePart[]): void {
  for (const p of parts) {
    if (p.type === 'rrect') {
      ctx.fillStyle = paintOf(ctx, p.fill)
      roundRectPath(ctx, p.rect, p.radii)
      ctx.fill()
    } else if (p.type === 'circle') {
      ctx.fillStyle = paintOf(ctx, p.fill)
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.save()
      ctx.font = `500 ${p.size}px 'Segoe UI', system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = p.color
      const text = fitText(ctx, p.text, p.maxWidth)
      if (text) ctx.fillText(text, p.x, p.y)
      ctx.restore()
    }
  }
}

/** True when the card's look needs the blurred background (a glass border). */
const needsBackdrop = (style: StyleSettings): boolean => {
  const b = cardLook(style).border
  return !!b?.glass && frameTakesBorder(frameOf(style))
}

/**
 * The recording's card: its shadow (soft, hard or glow), border, device frame and the black
 * content well. `spec.k` scales the 1080p-referenced sizes; a pulled-back card passes a smaller
 * one so everything shrinks with it. `backdrop` is the blurred background a glass border shows.
 */
export function paintCard(ctx: Ctx, spec: CardSpec, geom: CardGeometry = cardGeometry(spec), backdrop: Blurred | null = null, size?: { w: number; h: number }): void {
  const { style, k } = spec
  const look = cardLook(style)
  const border = frameTakesBorder(geom.frame) ? look.border : null
  const bw = border ? border.width * k : 0
  const w = size?.w ?? ctx.canvas?.width ?? 0
  const h = size?.h ?? ctx.canvas?.height ?? 0
  // With a border the card casts its shadow from the border's outer edge.
  const casting = bw > 0 ? [grow(geom.outline[0], bw), ...geom.outline.slice(1)] : geom.outline
  const shadow = style.padding > 0 ? shadowPaint(look, style.shadow, k) : null
  if (shadow) paintShadow(ctx, casting, shadow, !!border?.glass, w, h)
  if (border) paintBorder(ctx, geom.outline[0], border, bw, k, backdrop, w, h)
  if (geom.drawing) paintParts(ctx, geom.drawing.parts)
  ctx.fillStyle = '#000'
  roundRectPath(ctx, spec.rect, geom.screenRadii)
  ctx.fill()
}

/** Bounding box of the card's shapes: the outline and the device chrome (no border or shadow). */
function shapesBox(geom: CardGeometry): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const rects = [...geom.outline.map((o) => o.rect), ...(geom.drawing ? [geom.drawing.outer] : [])]
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  return { x0, y0, x1, y1 }
}

/**
 * The card itself (output px): device chrome and border included, shadow left out. The 3D tilt
 * turns the card about its centre and keeps its corners inside the frame.
 */
export function cardBody(spec: CardSpec, geom: CardGeometry): Rect {
  const border = frameTakesBorder(geom.frame) ? cardLook(spec.style).border : null
  const bw = border ? border.width * spec.k : 0
  const b = shapesBox(geom)
  return { x: b.x0 - bw, y: b.y0 - bw, w: b.x1 - b.x0 + bw * 2, h: b.y1 - b.y0 + bw * 2 }
}

/**
 * Pixel-aligned output rectangle the card (with its shadow and border) can touch, wherever it
 * is, also past the frame's edges (a tilted card can bring that part of its shadow into view).
 */
export function cardExtent(spec: CardSpec, geom: CardGeometry): Rect {
  const look = cardLook(spec.style)
  const reach = shadowReach(spec.style.padding > 0 ? shadowPaint(look, spec.style.shadow, spec.k) : null) + (look.border ? look.border.width * spec.k : 0) + 2
  const b = shapesBox(geom)
  const x = Math.floor(b.x0 - reach)
  const y = Math.floor(b.y0 - reach)
  return { x, y, w: Math.ceil(b.x1 + reach) - x, h: Math.ceil(b.y1 + reach) - y }
}

/** Output pixels the card (with its shadow and border) can touch, for drawing only that part of a cached card layer. */
function cardBounds(spec: CardSpec, geom: CardGeometry, w: number, h: number): Rect {
  const e = cardExtent(spec, geom)
  const bx = Math.max(0, e.x)
  const by = Math.max(0, e.y)
  return { x: bx, y: by, w: Math.max(0, Math.min(w, e.x + e.w) - bx), h: Math.max(0, Math.min(h, e.y + e.h) - by) }
}

/* ---------- cached layers ---------- */

interface CachedLayer {
  key: string
  image: HTMLImageElement | null
  canvas: HTMLCanvasElement
  /** Blurred copy of the background for a glass border, made when first needed. */
  backdrop?: Blurred | null
}

const layers = new WeakMap<Ctx, CachedLayer>()

function backdropOf(layer: HTMLCanvasElement, w: number, h: number): Blurred | null {
  return blurredPicture(w, h, 0.03 * Math.min(w, h), (c, cw, ch) => {
    // The background stretched under the margins, then exactly where it is.
    c.drawImage(layer, 0, 0, w, h, 0, 0, cw, ch)
    const mx = (cw - Math.ceil(w * BLUR_SCALE)) / 2
    const my = (ch - Math.ceil(h * BLUR_SCALE)) / 2
    c.drawImage(layer, 0, 0, w, h, mx, my, cw - mx * 2, ch - my * 2)
  })
}

function paintStatic(ctx: Ctx, w: number, h: number, spec: CardSpec, geom: CardGeometry, image: HTMLImageElement | null): void {
  paintBackground(ctx, w, h, spec.style, image)
  const backdrop = needsBackdrop(spec.style) && canBlur() ? backdropOf(ctx.canvas, w, h) : null
  paintCard(ctx, spec, geom, backdrop, { w, h })
}

/**
 * Paints the static part of a frame. The background and the large shadow blur are the
 * most expensive things in a frame (the shadow alone is a 140 px blur at 4K), and
 * they never change during playback or an export, so they are rendered once per
 * target canvas and reused until the size or style changes.
 *
 * `opaque`: when the recording is about to be drawn over `spec.rect`, only the bands around it
 * are copied; the interior would be painted over anyway, and copying it costs about as much
 * as drawing the recording.
 *
 * Animated backgrounds change every frame: the gradient is drawn small and scaled up, and
 * the card (with its shadow) comes from a separate cached layer composited over it.
 */
export function paintStaticLayer(
  ctx: Ctx,
  w: number,
  h: number,
  spec: CardSpec,
  geom: CardGeometry,
  image: HTMLImageElement | null,
  opaque = false,
  /** Seconds into the video, for backgrounds that move (animated gradients). */
  t = 0
): void {
  if (isAnimated(spec.style.background)) {
    paintAnimatedBackground(ctx, w, h, spec.style, t)
    paintCardLayer(ctx, w, h, spec, geom)
    return
  }
  if (typeof document === 'undefined') {
    paintStatic(ctx, w, h, spec, geom, image)
    return
  }
  const key = JSON.stringify([w, h, spec.style, spec.rect, spec.radius, spec.k, spec.title, image?.naturalWidth ?? 0, image?.naturalHeight ?? 0])
  let layer = layers.get(ctx)
  if (!layer || layer.key !== key || layer.image !== image) {
    const c = layer?.canvas ?? document.createElement('canvas')
    c.width = w
    c.height = h
    const lctx = c.getContext('2d', { alpha: false })
    if (!lctx) {
      paintStatic(ctx, w, h, spec, geom, image)
      return
    }
    paintStatic(lctx, w, h, spec, geom, image)
    layer = { key, image, canvas: c }
    layers.set(ctx, layer)
  }
  if (!opaque) {
    ctx.drawImage(layer.canvas, 0, 0)
    return
  }
  // Pixels at least the corner radius (+1 px of anti-aliasing) inside the content are fully covered.
  const rect = spec.rect
  const r = Math.max(0, Math.min(maxCorner(geom.screenRadii), rect.w / 2, rect.h / 2)) + 1
  const x0 = Math.min(w, Math.max(0, Math.ceil(rect.x + r)))
  const y0 = Math.min(h, Math.max(0, Math.ceil(rect.y + r)))
  const x1 = Math.max(x0, Math.min(w, Math.floor(rect.x + rect.w - r)))
  const y1 = Math.max(y0, Math.min(h, Math.floor(rect.y + rect.h - r)))
  const band = (x: number, y: number, bw: number, bh: number): void => {
    if (bw > 0 && bh > 0) ctx.drawImage(layer!.canvas, x, y, bw, bh, x, y, bw, bh)
  }
  band(0, 0, w, y0)
  band(0, y1, w, h - y1)
  band(0, y0, x0, y1 - y0)
  band(x1, y0, w - x1, y1 - y0)
}

/* ---------- animated backgrounds ---------- */

/** Longest side of the small canvas an animated gradient is drawn on before being scaled up. */
const ANIMATED_SIZE = 480
const animatedCanvases = new WeakMap<Ctx, HTMLCanvasElement>()

/**
 * An animated gradient at `t`: soft shapes only, so it is drawn on a small canvas (one per
 * target, reused every frame) and scaled up, which looks the same and costs a fraction.
 */
function paintAnimatedBackground(ctx: Ctx, w: number, h: number, style: StyleSettings, t: number): void {
  const bg = style.background
  if (bg.type !== 'animated') return
  const preset = animatedById(bg.preset)
  const speed = animatedSpeed(bg)
  if (typeof document === 'undefined') {
    drawAnimated(ctx, w, h, preset, t, speed)
    return
  }
  const s = Math.min(1, ANIMATED_SIZE / Math.max(w, h))
  const sw = Math.max(2, Math.round(w * s))
  const sh = Math.max(2, Math.round(h * s))
  let small = animatedCanvases.get(ctx)
  if (!small) {
    small = document.createElement('canvas')
    animatedCanvases.set(ctx, small)
  }
  if (small.width !== sw || small.height !== sh) {
    small.width = sw
    small.height = sh
  }
  const sctx = small.getContext('2d', { alpha: false })
  if (!sctx) {
    drawAnimated(ctx, w, h, preset, t, speed)
    return
  }
  drawAnimated(sctx, sw, sh, preset, t, speed)
  ctx.imageSmoothingEnabled = true
  // Soft blobs: a bilinear upscale looks the same as a cubic one and costs ~9x less without a GPU.
  ctx.imageSmoothingQuality = 'low'
  ctx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h)
}

interface CardLayer {
  key: string
  canvas: HTMLCanvasElement
  bounds: Rect
  backdrop: Blurred | null
}

const cardLayers = new WeakMap<Ctx, CardLayer>()

/**
 * The card (shadow, border, frame, well) on its own: painted once on a transparent canvas just
 * big enough for it, then composited every frame, so the large shadow blur is never redrawn
 * while an animated gradient moves, or while the 3D tilt draws the card on its own canvas.
 * `backdrop` is the blurred background a glass border shows; `extent` paints the card's whole
 * extent (cardExtent) instead of only its part inside the frame.
 */
export function paintCardLayer(ctx: Ctx, w: number, h: number, spec: CardSpec, geom: CardGeometry, backdrop: Blurred | null = null, extent = false): void {
  if (typeof document === 'undefined') {
    paintCard(ctx, spec, geom, backdrop, { w, h })
    return
  }
  const { background: _bg, ...rest } = spec.style
  void _bg
  const key = JSON.stringify([w, h, rest, spec.rect, spec.radius, spec.k, spec.title, extent])
  let layer = cardLayers.get(ctx)
  if (!layer || layer.key !== key || layer.backdrop !== backdrop) {
    const bounds = extent ? cardExtent(spec, geom) : cardBounds(spec, geom, w, h)
    const c = layer?.canvas ?? document.createElement('canvas')
    c.width = Math.max(1, bounds.w)
    c.height = Math.max(1, bounds.h)
    const lctx = c.getContext('2d')
    if (!lctx) {
      paintCard(ctx, spec, geom, backdrop, { w, h })
      return
    }
    lctx.clearRect(0, 0, c.width, c.height)
    lctx.save()
    lctx.translate(-bounds.x, -bounds.y)
    paintCard(lctx, spec, geom, backdrop, { w, h })
    lctx.restore()
    layer = { key, canvas: c, bounds, backdrop }
    cardLayers.set(ctx, layer)
  }
  const b = layer.bounds
  if (b.w > 0 && b.h > 0) ctx.drawImage(layer.canvas, 0, 0, b.w, b.h, b.x, b.y, b.w, b.h)
}

/** Key of the last card paintStillCard painted as vectors, per target. */
const lastCards = new WeakMap<Ctx, string>()

/**
 * A pulled-back card. During the zoom transition it moves and shrinks every frame and is painted as
 * vectors (crisp at every size); for the rest of the pull-back it holds still, and repainting its
 * large shadow blur every frame is wasted: once the same card comes twice in a row it is drawn
 * from a cached layer (paintCardLayer with its whole extent), which looks the same.
 */
export function paintStillCard(ctx: Ctx, w: number, h: number, spec: CardSpec, geom: CardGeometry, backdrop: Blurred | null): void {
  const key = JSON.stringify([w, h, spec.style, spec.rect, spec.radius, spec.k, spec.title])
  if (lastCards.get(ctx) === key) {
    paintCardLayer(ctx, w, h, spec, geom, backdrop, true)
    return
  }
  lastCards.set(ctx, key)
  paintCard(ctx, spec, geom, backdrop, { w, h })
}

/* ---------- background only (pulled-back camera) ---------- */

const backgrounds = new WeakMap<Ctx, CachedLayer>()

/**
 * Paints only the background (no card), cached like paintStaticLayer. Used while the camera
 * pulls back: the card then moves and shrinks every frame, so it is drawn on top with
 * paintStillCard (vector shapes stay crisp at any size) while the gradient or image is reused.
 * Returns the blurred backdrop a glass border needs (made once), or null.
 */
export function paintBackgroundLayer(ctx: Ctx, w: number, h: number, style: StyleSettings, image: HTMLImageElement | null, t = 0): Blurred | null {
  if (isAnimated(style.background)) {
    paintAnimatedBackground(ctx, w, h, style, t)
    return null
  }
  if (typeof document === 'undefined') {
    paintBackground(ctx, w, h, style, image)
    return null
  }
  const key = JSON.stringify([w, h, style.background, image?.naturalWidth ?? 0, image?.naturalHeight ?? 0])
  let layer = backgrounds.get(ctx)
  if (!layer || layer.key !== key || layer.image !== image) {
    const c = layer?.canvas ?? document.createElement('canvas')
    c.width = w
    c.height = h
    const lctx = c.getContext('2d', { alpha: false })
    if (!lctx) {
      paintBackground(ctx, w, h, style, image)
      return null
    }
    paintBackground(lctx, w, h, style, image)
    layer = { key, image, canvas: c }
    backgrounds.set(ctx, layer)
  }
  ctx.drawImage(layer.canvas, 0, 0)
  if (!needsBackdrop(style)) return null
  if (layer.backdrop === undefined) layer.backdrop = backdropOf(layer.canvas, w, h)
  return layer.backdrop
}
