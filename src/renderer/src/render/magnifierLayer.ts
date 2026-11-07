/**
 * Drawing magnifiers (docs/design/editing-polish.md §6.4): on the card's canvas, inside its clip,
 * between the cursor and the shapes. Each lens shows the recording again through a lens camera
 * from the full-resolution frame (fc.screen: the crop's copy, graded), with the privacy shapes and
 * the cursor drawn again through the same camera, so blurred and pixelated areas stay hidden at
 * any zoom and the cursor is magnified as a zoom would show it.
 */
import { intersectRect } from '../../../shared/engine/layout'
import { toOutput } from '../../../shared/engine/outputPoint'
import { calmOf } from '../../../shared/render/calloutData'
import { isMagnifier, lensBox, lensCamera, lensCentre, magnifierPhase, MAGNIFIER } from '../../../shared/render/magnifier'
import { cursorSpotlightPresence, projectSpotlights, visibleCursorAt } from '../../../shared/render/shapes'
import type { Spotlight } from '../../../shared/types'
import { viewSource } from './compositor'
import { drawCursorLayer } from './cursorLayer'
import type { FrameContext } from './frameContext'
import { drawPrivacyLayer } from './shapesLayer'

type Ctx = CanvasRenderingContext2D

/** A lens on screen (output px): its centre and half sizes. */
export interface LensBox {
  cx: number
  cy: number
  rx: number
  ry: number
}

/**
 * Adds the lens's outline to the current path (no beginPath): an ellipse (a circle when the box is
 * square in pixels), or a rounded rectangle with a corner radius of 0.18 of its shorter side.
 * `grow` px larger on every side.
 */
export function addLensPath(c: Ctx, box: LensBox, shape: Spotlight['shape'], grow = 0): void {
  const rx = Math.max(0, box.rx + grow)
  const ry = Math.max(0, box.ry + grow)
  if (shape === 'rect') {
    const radius = MAGNIFIER.corner * Math.min(2 * box.rx, 2 * box.ry) + grow
    c.roundRect(box.cx - rx, box.cy - ry, 2 * rx, 2 * ry, Math.max(0, Math.min(radius, rx, ry)))
  } else {
    c.ellipse(box.cx, box.cy, rx, ry, 0, 0, Math.PI * 2)
  }
}

/** One lens of this frame: what the spotlight layer's dimming needs too. */
export interface ActiveLens {
  spot: Spotlight
  box: LensBox
  /** Opacity (the cursor's presence included for a cursor magnifier). */
  alpha: number
  zoom: number
  centre: { x: number; y: number }
}

/**
 * The lens of magnifier `s` at fc.t, or null while it does not show (§6.2, §6.3): its box scaled
 * by r about its centre, through the frame's camera, at its zoom and opacity. A cursor magnifier
 * is centred on the cursor viewers see and fades while it is off the recording.
 */
export function activeLens(fc: FrameContext, s: Spotlight, cursor: { x: number; y: number } | null, presence: () => number): ActiveLens | null {
  if (!isMagnifier(s)) return null
  const phase = magnifierPhase(s, fc.t, fc.project.clips, calmOf(fc.project.effects))
  if (!phase) return null
  const alpha = s.mode === 'cursor' && cursor && phase.alpha > 0 ? phase.alpha * presence() : phase.alpha
  const centre = lensCentre(s, cursor)
  return { spot: s, box: lensBox(s, centre, fc.rect, fc.cam, phase.r, fc.toOut), alpha, zoom: phase.z, centre }
}

/** Where viewers see the cursor at fc.t (the spotlight layer's rule), and its presence on the recording, asked once. */
export function cursorOf(fc: FrameContext): { at: { x: number; y: number } | null; presence: () => number } {
  const { project, t } = fc
  const { samples } = fc.cursor
  const path = fc.scene.cursorPath
  const at = fc.cursor.valid ? visibleCursorAt(project, samples, path, t) : null
  let p = -1
  return {
    at,
    presence: () => {
      if (p < 0) p = cursorSpotlightPresence(project, samples, path, t)
      return p
    }
  }
}

/**
 * Draws every magnifier active at fc.t, in list order (§6.4): its shadow, then inside the lens the
 * screen through the lens camera, the privacy shapes and the cursor through the same camera, then
 * a white ring and a faint dark line just outside it, so the lens shows on white pages too. The
 * privacy shapes inside a lens are drawn fully opaque even while the lens fades, so nothing they
 * hide shows through the half-transparent magnified picture. Returns at once when no spotlight is
 * a magnifier (every project from before).
 */
export function drawMagnifierLayer(fc: FrameContext): void {
  if (!(fc.project.spotlights ?? []).some((s) => s.magnify !== undefined)) return
  const screen = fc.screen
  if (!screen) return
  const list = projectSpotlights(fc.project)
  const t = fc.t
  let cursor: ReturnType<typeof cursorOf> | null = null
  for (const s of list) {
    if (!isMagnifier(s) || !(t >= s.start && t < s.end)) continue
    cursor ??= cursorOf(fc)
    const lens = activeLens(fc, s, cursor.at, cursor.presence)
    if (!lens || lens.alpha <= 0.002 || !(lens.box.rx >= 0.5 && lens.box.ry >= 0.5)) continue
    drawLens(fc, lens)
  }
}

function drawLens(fc: FrameContext, lens: ActiveLens): void {
  const c = fc.ctx
  const { box, alpha, spot } = lens
  const S = Math.min(fc.w, fc.h)
  const screen = fc.screen!
  c.save()

  // 1. The shadow, outside the lens only (the lens covers the rest of it).
  c.save()
  c.beginPath()
  c.rect(-fc.w, -fc.h, 3 * fc.w, 3 * fc.h)
  addLensPath(c, box, spot.shape)
  c.clip('evenodd')
  c.globalAlpha = 1
  c.shadowColor = `rgba(0, 0, 0, ${(MAGNIFIER.shadowAlpha * alpha).toFixed(4)})`
  c.shadowBlur = MAGNIFIER.shadowBlur * S
  c.shadowOffsetX = 0
  c.shadowOffsetY = MAGNIFIER.shadowY * S
  c.fillStyle = '#000'
  c.beginPath()
  addLensPath(c, box, spot.shape)
  c.fill()
  c.restore()

  // 2. Inside the lens: the recording through the lens camera, then privacy shapes and the cursor.
  const cam = lensCamera(fc.cam, lens.centre, lens.zoom)
  c.save()
  c.beginPath()
  addLensPath(c, box, spot.shape)
  c.clip()
  c.globalAlpha = alpha
  c.imageSmoothingEnabled = true
  c.imageSmoothingQuality = 'high'
  const bounds = { x: box.cx - box.rx, y: box.cy - box.ry, w: 2 * box.rx, h: 2 * box.ry }
  const slot = fc.layout.follow?.slot
  const v = viewSource(cam, fc.rect, slot ? intersectRect(slot, bounds) : bounds)
  const vw = screen.width
  const vh = screen.height
  if (v) c.drawImage(screen.image, v.sx * vw, v.sy * vh, v.sw * vw, v.sh * vh, v.dx, v.dy, v.dw, v.dh)
  // No shutter inside the lens: a privacy box is never swept with the frame's cameras of another scale.
  const options = { frameInterval: fc.options?.frameInterval ?? 1 / 60, blurSamples: 1 }
  const inside: FrameContext = { ...fc, cam, toOut: toOutput(fc.rect, cam), options }
  c.globalAlpha = 1
  drawPrivacyLayer(inside)
  c.globalAlpha = alpha
  drawCursorLayer(inside)
  c.restore()

  // 3. The ring, and a 1 px dark line just outside it.
  const ring = Math.max(2, MAGNIFIER.ring * S)
  c.globalAlpha = alpha
  c.lineWidth = ring
  c.strokeStyle = '#ffffff'
  c.beginPath()
  addLensPath(c, box, spot.shape)
  c.stroke()
  c.lineWidth = 1
  c.strokeStyle = 'rgba(0, 0, 0, 0.25)'
  c.beginPath()
  addLensPath(c, box, spot.shape, ring / 2 + 0.5)
  c.stroke()
  c.restore()
}
