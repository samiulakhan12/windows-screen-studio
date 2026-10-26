import { isPrivacyKind, shapeBounds } from '../../../shared/editor/shapes'
import { cameraAt, zoomStyleOf, type Camera } from '../../../shared/engine/zoom'
import { speedAt } from '../../../shared/render/overlays'
import {
  arrowGeometry,
  blurPlan,
  blurSigma,
  clipToUnit,
  pixelCell,
  pixelGrid,
  projectShapes,
  shapeAlpha,
  sweptBox,
  type Box
} from '../../../shared/render/shapes'
import type { Shape } from '../../../shared/types'
import type { FrameImage } from './compositor'
import type { FrameContext } from './frameContext'

type Ctx = CanvasRenderingContext2D

/** Painted over a privacy box when there is no frame to blur yet: never the content itself. */
const PRIVACY_FALLBACK = '#24242e'

/**
 * Privacy shapes ('blur', 'pixelate') active at fc.t, drawn over the recording inside the
 * card's clip and under the cursor. They follow the content through the camera (fc.toOut),
 * never fade, and are blurred or pixelated from the frame itself (fc.screen), so preview and
 * export hide exactly the same content.
 */
export function drawPrivacyLayer(fc: FrameContext): void {
  const shapes = projectShapes(fc.project)
  if (shapes.length === 0) return
  // The frame shown at t can be the source frame up to half a frame later (export picks the
  // nearest one): cover that much (and a millisecond for timestamp rounding) early and late, so
  // the frame where a secret appears is never drawn uncovered, whichever frame preview or export shows.
  const slack = 0.5 / (fc.project.capture?.fps ?? 60) + 0.001
  let shutter: Camera[] | null = null
  for (const s of shapes) {
    if (!isPrivacyKind(s.kind) || !(fc.t + slack >= s.start && fc.t - slack < s.end)) continue
    let box = clipToUnit(shapeBounds(s))
    if (!box) continue
    // While motion blur averages several camera positions, cover the box in all of them.
    shutter ??= shutterCameras(fc)
    if (shutter.length > 0) box = clipToUnit(sweptBox(box, fc.cam, shutter)) ?? box
    const a = fc.toOut(box.x, box.y)
    const b = fc.toOut(box.x + box.w, box.y + box.h)
    const out = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
    if (!(out.w >= 0.5 && out.h >= 0.5)) continue
    const done = fc.screen && (s.kind === 'blur' ? drawBlurred(fc.ctx, fc.screen, box, out, s.strength, fc.sourceH) : drawPixelated(fc.ctx, fc.screen, box, out, s.strength, fc.sourceH))
    if (!done) {
      fc.ctx.save()
      fc.ctx.fillStyle = PRIVACY_FALLBACK
      fc.ctx.fillRect(out.x, out.y, out.w, out.h)
      fc.ctx.restore()
    }
  }
}

/** Cameras at both ends of this frame's motion-blur shutter (none when it has no motion blur). */
function shutterCameras(fc: FrameContext): Camera[] {
  const { project, t } = fc
  const strength = project.effects.motionBlur
  const opts = fc.options ?? { frameInterval: 1 / 60, blurSamples: 4 }
  if (!(strength > 0) || opts.blurSamples <= 1 || project.zooms.length === 0) return []
  const half = (strength * opts.frameInterval * speedAt(project.clips, t)) / 2
  const style = zoomStyleOf(project)
  return [cameraAt(project.zooms, t - half, fc.focus, style), cameraAt(project.zooms, t + half, fc.focus, style)]
}

/* ---------- blur and pixelate ---------- */

interface Scratch {
  canvas: HTMLCanvasElement
  ctx: Ctx
}

/** Reused work canvases: they only ever grow (in steps), so drawing allocates nothing per frame. */
const scratch: { grab: Scratch | null; soft: Scratch | null; mosaic: Scratch | null } = { grab: null, soft: null, mosaic: null }

function ensure(name: keyof typeof scratch, w: number, h: number): Scratch | null {
  const cur = scratch[name]
  if (cur && cur.canvas.width >= w && cur.canvas.height >= h) return cur
  if (typeof document === 'undefined') return null
  const canvas = cur?.canvas ?? document.createElement('canvas')
  const step = (v: number, have: number): number => Math.max(have, Math.ceil(v / 64) * 64)
  canvas.width = step(w, cur?.canvas.width ?? 0)
  canvas.height = step(h, cur?.canvas.height ?? 0)
  const ctx = canvas.getContext('2d')
  scratch[name] = ctx ? { canvas, ctx } : null
  return scratch[name]
}

interface Blurred {
  canvas: HTMLCanvasElement
  /** The box's rectangle in `canvas`. */
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * The content of `box` (normalised) blurred with radius `sigma` (source pixels), on a reduced
 * scratch copy. Surrounding content is included as a margin (the recording's edge pixels
 * repeated beyond its border), so the blur never fades to transparent at the box's edges.
 */
function blurBox(img: FrameImage, box: Box, sigma: number): Blurred | null {
  const W = img.width
  const H = img.height
  if (!(W > 0 && H > 0)) return null
  const bw = box.w * W
  const bh = box.h * H
  const plan = blurPlan(sigma, bw, bh)
  const d = plan.scale
  const pad = plan.margin / d
  const sx0 = box.x * W - pad
  const sy0 = box.y * H - pad
  const sx1 = (box.x + box.w) * W + pad
  const sy1 = (box.y + box.h) * H + pad
  const sw = Math.ceil((sx1 - sx0) * d)
  const sh = Math.ceil((sy1 - sy0) * d)
  const grab = ensure('grab', sw, sh)
  const soft = ensure('soft', sw, sh)
  if (!grab || !soft) return null
  const g = grab.ctx
  g.clearRect(0, 0, sw, sh)
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'medium'
  // The recording's part of the area, then its edge rows and columns stretched over the rest.
  const cx0 = Math.max(0, sx0)
  const cy0 = Math.max(0, sy0)
  const cx1 = Math.min(W, sx1)
  const cy1 = Math.min(H, sy1)
  const X = [0, (cx0 - sx0) * d, (cx1 - sx0) * d, (sx1 - sx0) * d]
  const Y = [0, (cy0 - sy0) * d, (cy1 - sy0) * d, (sy1 - sy0) * d]
  // Source column/row ranges for the three bands across: before, inside, after the recording.
  const SX = [[0, 1], [cx0, cx1 - cx0], [W - 1, 1]]
  const SY = [[0, 1], [cy0, cy1 - cy0], [H - 1, 1]]
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const dw = X[i + 1] - X[i]
      const dh = Y[j + 1] - Y[j]
      if (dw > 0.01 && dh > 0.01 && SX[i][1] > 0 && SY[j][1] > 0) g.drawImage(img.image, SX[i][0], SY[j][0], SX[i][1], SY[j][1], X[i], Y[j], dw, dh)
    }
  }
  const q = soft.ctx
  q.clearRect(0, 0, sw, sh)
  q.filter = `blur(${plan.sigma.toFixed(2)}px)`
  q.drawImage(grab.canvas, 0, 0, sw, sh, 0, 0, sw, sh)
  q.filter = 'none'
  return { canvas: soft.canvas, sx: plan.margin, sy: plan.margin, sw: bw * d, sh: bh * d }
}

/** `sourceH`: height of the whole recording frame (`img` can be a crop of it), which the strength is relative to. */
function drawBlurred(ctx: Ctx, img: FrameImage, box: Box, out: Box, strength: number, sourceH = img.height): boolean {
  const b = blurBox(img, box, blurSigma(strength, sourceH))
  if (!b) return false
  ctx.drawImage(b.canvas, b.sx, b.sy, b.sw, b.sh, out.x, out.y, out.w, out.h)
  return true
}

/**
 * A mosaic of the box: each cell is the (Gaussian-weighted) average colour around it, taken
 * from a blurred copy so cells are stable from frame to frame, then scaled up without smoothing.
 * The grid is laid out on the content, so it moves and scales with it.
 */
function drawPixelated(ctx: Ctx, img: FrameImage, box: Box, out: Box, strength: number, sourceH = img.height): boolean {
  const cell = pixelCell(strength, sourceH)
  const { cols, rows } = pixelGrid(box.w * img.width, box.h * img.height, cell)
  const b = blurBox(img, box, cell * 0.5)
  const mosaic = b && ensure('mosaic', cols, rows)
  if (!b || !mosaic) return false
  const m = mosaic.ctx
  m.imageSmoothingEnabled = true
  m.imageSmoothingQuality = 'low'
  m.clearRect(0, 0, cols, rows)
  m.drawImage(b.canvas, b.sx, b.sy, b.sw, b.sh, 0, 0, cols, rows)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(mosaic.canvas, 0, 0, cols, rows, out.x, out.y, out.w, out.h)
  ctx.restore()
  return true
}

/* ---------- arrows, lines, boxes, ellipses and highlights ---------- */

/**
 * Arrows, lines, boxes, ellipses and highlights active at fc.t, drawn over the recording and
 * the cursor. Positions are on the content (fc.toOut) and stroke widths scale with the output
 * and the camera, so a shape stays on what it marks while the camera zooms. Each fades in and
 * out over SHAPE_FADE of viewing time.
 */
export function drawShapesLayer(fc: FrameContext): void {
  const shapes = projectShapes(fc.project)
  if (shapes.length === 0) return
  let speed = 0
  for (const s of shapes) {
    if (isPrivacyKind(s.kind) || !(fc.t >= s.start && fc.t < s.end)) continue
    speed ||= speedAt(fc.project.clips, fc.t)
    const alpha = shapeAlpha(s, fc.t, speed) * s.opacity
    if (alpha > 0.003) drawShape(fc, s, alpha)
  }
}

function drawShape(fc: FrameContext, s: Shape, alpha: number): void {
  const { ctx } = fc
  // Output pixels per 1080p-referenced pixel, following the camera.
  const u = fc.k * fc.cam.scale
  const lw = Math.max(0.75, s.strokeWidth * u)
  const a = fc.toOut(s.x, s.y)
  const b = fc.toOut(s.x + s.w, s.y + s.h)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = s.color
  ctx.strokeStyle = s.color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (s.kind === 'highlight') {
    // A highlighter: tints what is under it (white turns yellow, dark text stays dark).
    ctx.globalCompositeOperation = 'multiply'
    ctx.beginPath()
    ctx.roundRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.min(4 * u, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2))
    ctx.fill()
    ctx.restore()
    return
  }
  // A soft drop shadow lifts the mark off busy content.
  ctx.shadowColor = 'rgba(0, 0, 0, 0.32)'
  ctx.shadowBlur = 8 * u
  ctx.shadowOffsetY = 2 * u
  if (s.kind === 'arrow') {
    const g = arrowGeometry(a, b, lw, 14 * u)
    if (g) {
      ctx.beginPath()
      ctx.moveTo(g.points[0].x, g.points[0].y)
      for (let i = 1; i < g.points.length; i++) ctx.lineTo(g.points[i].x, g.points[i].y)
      ctx.arc(g.tail.x, g.tail.y, g.radius, g.angle + Math.PI / 2, g.angle + (Math.PI * 3) / 2)
      ctx.closePath()
      ctx.fill()
      // Rounds the arrowhead's corners off a little (no second shadow).
      ctx.shadowColor = 'transparent'
      ctx.lineWidth = lw * 0.45
      ctx.beginPath()
      ctx.moveTo(g.head[0].x, g.head[0].y)
      ctx.lineTo(g.head[1].x, g.head[1].y)
      ctx.lineTo(g.head[2].x, g.head[2].y)
      ctx.closePath()
      ctx.stroke()
    }
  } else if (s.kind === 'line') {
    ctx.lineWidth = lw
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  } else {
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(b.x - a.x)
    const h = Math.abs(b.y - a.y)
    ctx.beginPath()
    if (s.kind === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    else ctx.roundRect(x, y, w, h, Math.min(6 * u, w / 2, h / 2))
    if (s.fill) {
      ctx.fill()
    } else {
      ctx.lineWidth = lw
      ctx.stroke()
    }
  }
  ctx.restore()
}
