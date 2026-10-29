import type { Rect } from '../../../shared/engine/layout'
import { clamp } from '../../../shared/engine/math'
import type { CursorTrack, Project } from '../../../shared/types'
import { noFadeOutFrom, planOf } from '../../../shared/engine/freeze'
import { ANNOTATION_FADE, ANNOTATION_FONT, annotationAlpha, annotationMetrics, keycaps, keystrokesAt, speedAt } from '../../../shared/render/overlays'
import { keepInArea, TEXT_INSET } from '../../../shared/render/safeZones'
import { captionBlockAt } from './captionsLayer'
import { projectFontStack } from './fontLoader'

type Ctx = CanvasRenderingContext2D

/**
 * Text annotations, in output-frame space (the zoom camera does not move them).
 * Geometry matches the editor's drag handle: centred on (x, y), padded box.
 */
export function drawAnnotations(ctx: Ctx, w: number, h: number, t: number, project: Project): void {
  if (project.annotations.length === 0) return
  const speed = speedAt(project.clips, t)
  // A pause freeze holding the edit's last moments (E-11): a text running to the end does not fade out there.
  const steady = noFadeOutFrom(project.clips, planOf(project), ANNOTATION_FADE)
  for (const a of project.annotations) {
    const alpha = annotationAlpha(a.end >= steady ? { ...a, end: a.end + ANNOTATION_FADE * speed } : a, t, speed)
    if (alpha <= 0.002 || !a.text.trim()) continue
    const m = annotationMetrics(a, w, h)
    const lines = a.text.split('\n')
    ctx.save()
    ctx.font = `${m.weight} ${m.px}px ${projectFontStack(project, a.font, ANNOTATION_FONT)}`
    const textW = Math.max(...lines.map((l) => ctx.measureText(l || ' ').width))
    const boxW = textW + m.padX * 2
    const boxH = m.lineHeight * lines.length + m.padY * 2
    const cx = a.x * w
    const cy = a.y * h
    // A small grow-in while fading, around the box centre.
    const s = 0.94 + 0.06 * alpha
    ctx.translate(cx, cy)
    ctx.scale(s, s)
    ctx.globalAlpha = alpha
    if (a.style === 'pill') {
      ctx.shadowColor = 'rgba(0,0,0,0.28)'
      ctx.shadowBlur = m.px * 0.6
      ctx.shadowOffsetY = m.px * 0.12
      ctx.beginPath()
      ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, Math.min(boxH / 2, m.px))
      ctx.fillStyle = 'rgba(17,17,24,0.8)'
      ctx.fill()
      ctx.shadowColor = 'transparent'
      ctx.lineWidth = Math.max(1, m.px * 0.04)
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'
      ctx.stroke()
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur = m.px * 0.35
      ctx.shadowOffsetY = m.px * 0.08
    }
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    lines.forEach((line, i) => ctx.fillText(line, 0, -boxH / 2 + m.padY + m.lineHeight * (i + 0.5)))
    ctx.restore()
  }
}

/**
 * Keystroke overlay: the latest shortcut(s) as keycap pills, bottom or top centre,
 * fading out ~1.2 s after the last press. Presses in quick succession stack in one row.
 * A caption at the same edge keeps its place and the keys move inside it, so neither covers the other.
 * In a text area (docs/design/vertical-video.md §6.3) the keys go to its top or bottom, kept inside it across,
 * and shrink into the room a caption leaves them when the area is too short for both.
 */
export function drawKeystrokes(
  ctx: Ctx,
  w: number,
  h: number,
  t: number,
  project: Project,
  cursor: CursorTrack,
  /** The text area (shared/render/safeZones.ts textArea) the keys keep to; absent or null: the whole frame, as always. */
  area?: Rect | null
): void {
  const settings = project.effects.keystrokes
  if (!settings.show) return
  const view = keystrokesAt(cursor.keys, project.clips, t)
  if (!view || view.alpha <= 0.002) return
  const px = Math.max(8, settings.size * Math.min(w, h))
  const capH = px * 1.75
  const capPad = px * 0.55
  const capGap = px * 0.3
  const groupGap = px * 0.9
  const pad = px * 0.45
  ctx.save()
  ctx.font = `600 ${px}px ${ANNOTATION_FONT}`

  // Measure each group: keycaps plus an optional "×n".
  const groups = view.groups.map((g) => {
    const caps = keycaps(g.label).map((c) => ({ text: c, w: Math.max(capH, ctx.measureText(c).width + capPad * 2) }))
    const countText = g.count > 1 ? `×${g.count}` : ''
    const countW = countText ? ctx.measureText(countText).width + capGap : 0
    const width = caps.reduce((s, c) => s + c.w, 0) + capGap * (caps.length - 1) + countW
    return { caps, countText, width }
  })
  const innerW = groups.reduce((s, g) => s + g.width, 0) + groupGap * (groups.length - 1)
  const boxW = innerW + pad * 2
  const boxH = capH + pad * 2
  const margin = Math.min(w, h) * 0.05
  let x0 = (w - boxW) / 2
  let y0 = settings.position === 'top' ? margin : h - margin - boxH
  // The area keeps clear of the apps already: a small inset from its edge (never nearer the frame's
  // edge than today, where the area's edge is the frame's); centred on the frame as far as the area allows.
  const inset = Math.min(w, h) * TEXT_INSET
  if (area) {
    y0 = settings.position === 'top' ? Math.max(y0, area.y + inset) : Math.min(y0, area.y + area.h - inset - boxH)
    x0 = boxW > area.w ? area.x + (area.w - boxW) / 2 : clamp(x0, area.x, area.x + area.w - boxW)
  }
  // A caption at the same edge stays put; the keys show just inside it.
  const caption = captionBlockAt(ctx, project, t, w, h, area)
  const gap = Math.min(w, h) * 0.015
  if (caption?.position === 'bottom' && settings.position === 'bottom') y0 = Math.min(y0, caption.top - gap - boxH)
  if (caption?.position === 'top' && settings.position === 'top') y0 = Math.max(y0, caption.bottom + gap)
  if (area) {
    // An area too short for the keys beside the caption (a large camera band, big text): like the
    // logo, they shrink into the room the caption leaves on their side, never covering the camera or the caption.
    let top = area.y + inset
    let bottom = area.y + area.h - inset
    if (caption?.position === 'bottom' || (caption?.position === 'middle' && settings.position === 'top')) bottom = Math.min(bottom, caption.top - gap)
    else if (caption) top = Math.max(top, caption.bottom + gap)
    // (Placed at the area's edge above, the box may miss it by a rounding error: that is not leaving it.)
    if (bottom > top && (y0 < top - 1e-6 || y0 + boxH > bottom + 1e-6)) {
      const fit = keepInArea({ x: x0, y: y0, w: boxW, h: boxH }, { x: x0, y: top, w: boxW, h: bottom - top }, 0)
      const cx = x0 + boxW / 2
      const cy = y0 + boxH / 2
      ctx.translate(cx + fit.dx, cy + fit.dy)
      ctx.scale(fit.scale, fit.scale)
      ctx.translate(-cx, -cy)
    }
  }

  ctx.globalAlpha = view.alpha
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = px * 0.8
  ctx.shadowOffsetY = px * 0.15
  ctx.beginPath()
  ctx.roundRect(x0, y0, boxW, boxH, Math.min(boxH / 2, px * 0.75))
  ctx.fillStyle = 'rgba(16,16,22,0.84)'
  ctx.fill()
  ctx.shadowColor = 'transparent'

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let x = x0 + pad
  const capY = y0 + pad
  groups.forEach((g, gi) => {
    const newest = gi === groups.length - 1
    ctx.save()
    if (!newest) ctx.globalAlpha = view.alpha * 0.55
    if (newest && view.pop > 0) {
      // A short pop on the key that was just pressed.
      const s = 1 + 0.12 * view.pop
      const cx = x + g.width / 2
      const cy = capY + capH / 2
      ctx.translate(cx, cy)
      ctx.scale(s, s)
      ctx.translate(-cx, -cy)
    }
    let cx = x
    for (const cap of g.caps) {
      ctx.beginPath()
      ctx.roundRect(cx, capY + px * 0.08, cap.w, capH, px * 0.32)
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fill()
      ctx.beginPath()
      ctx.roundRect(cx, capY, cap.w, capH - px * 0.06, px * 0.32)
      ctx.fillStyle = 'rgba(255,255,255,0.16)'
      ctx.fill()
      ctx.lineWidth = Math.max(1, px * 0.05)
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.fillText(cap.text, cx + cap.w / 2, capY + (capH - px * 0.06) / 2)
      cx += cap.w + capGap
    }
    if (g.countText) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.textAlign = 'left'
      ctx.fillText(g.countText, cx, capY + capH / 2)
      ctx.textAlign = 'center'
    }
    ctx.restore()
    x += g.width + groupGap
  })
  ctx.restore()
}
