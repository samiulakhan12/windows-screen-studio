/**
 * Drawing animated callouts (docs/design/editing-polish.md §7.2): step badges, speech bubbles and
 * texts with a motion of their own (drawCallout, from drawAnnotations), and the poses of shapes and
 * title cards (applied by shapesLayer and titleCardLayer). Reached only for items with the new
 * fields: an old text, shape or card never comes here and draws as it always has.
 */
import { RTL_FIRST } from '../../../shared/captions/layout'
import { typewriterClip } from '../../../shared/captions/motion'
import { prefixDrawsSame, scriptsIn } from '../../../shared/captions/words'
import { isPrivacyKind } from '../../../shared/editor/shapes'
import { noFadeOutFrom, planOf } from '../../../shared/engine/freeze'
import { intersectRect, type Rect } from '../../../shared/engine/layout'
import type { Camera } from '../../../shared/engine/zoom'
import { calloutOf, calmOf, isCallout } from '../../../shared/render/calloutData'
import { bubbleOutlined, calloutPlace, calloutPose, graphemes, OLD_FADE, type CalloutFrame, type CalloutPlace, type CalloutPose } from '../../../shared/render/callouts'
import { ANNOTATION_FADE, ANNOTATION_FONT, annotationMetrics } from '../../../shared/render/overlays'
import { titleEm, titleMotionPose } from '../../../shared/render/titleCards'
import type { Annotation, CalloutMotion, Shape, TitleCard } from '../../../shared/types'
import { ensureCaptionFonts, fontGeneration, projectFontStack } from './fontLoader'
import type { FrameContext } from './frameContext'
import { calloutBubblePath } from './bubblePath'
import { CATALOG_FALLBACK } from './titleCardLayer'

type Ctx = CanvasRenderingContext2D

let calloutFont: string | null = null
/**
 * Badges' and bubbles' font stack after a font of the project's own (§7.6): the text font, then
 * Captions Studio's bundled script fonts and the colour emoji face (CATALOG_FALLBACK), which the
 * export loads before its first frame (editingFontIds). Built on first use: titleCardLayer, which
 * holds the fallback, imports this module too.
 */
export function CALLOUT_FONT(): string {
  return (calloutFont ??= `${ANNOTATION_FONT}, ${CATALOG_FALLBACK}`)
}

/* ---------- where the picture shows (§7.3) ---------- */

/** The card's rectangle at camera `cam` (compositor's cardRect: pulled back, the card shrinks about the view). */
function cardOf(rect: Rect, cam: Camera): Rect {
  if (cam.scale >= 1) return rect
  const viewX = cam.cx - 0.5 / cam.scale
  const viewY = cam.cy - 0.5 / cam.scale
  return { x: rect.x - viewX * cam.scale * rect.w, y: rect.y - viewY * cam.scale * rect.h, w: rect.w * cam.scale, h: rect.h * cam.scale }
}

const inside = (r: Rect, p: { x: number; y: number }): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

/**
 * What of the recording a frame shows (§7.3): the card (inside the slot while following), and
 * nothing in a layout whose camera covers the screen (camera only). A pin outside it is not on
 * the picture: a badge there is not drawn, and a bubble's tail is left out.
 */
export function visiblePicture(fc: Pick<FrameContext, 'rect' | 'cam' | 'layout' | 'project'>): { seen: Rect; visible: (p: { x: number; y: number }) => boolean } {
  const card = cardOf(fc.rect, fc.cam)
  const slot = fc.layout.follow?.slot
  const seen = slot ? intersectRect(slot, card) : card
  const cam = fc.project.webcam?.show && fc.project.hasWebcam ? fc.layout.camera : null
  const covered = !!cam && cam.opacity >= 0.5 && cam.rect.x <= seen.x && cam.rect.y <= seen.y && cam.rect.x + cam.rect.w >= seen.x + seen.w && cam.rect.y + cam.rect.h >= seen.y + seen.h
  return { seen, visible: (p) => !covered && seen.w > 0 && seen.h > 0 && inside(seen, p) }
}

/** The frame a badge or a bubble is placed in (calloutPlace). */
export function calloutFrame(fc: FrameContext): CalloutFrame {
  const { seen, visible } = visiblePicture(fc)
  return { w: fc.w, h: fc.h, area: fc.textArea, toOut: fc.toOut, visible, seen, crop: fc.scene.crop ?? null }
}

/* ---------- measuring ---------- */

const widths = new Map<string, number>()

/** Measures in `stack` (cached by font and text: a bubble is laid out once per text, font and width). */
export function measurer(c: Ctx, stack: string): (text: string, px: number, weight: number) => number {
  const gen = fontGeneration()
  return (text, px, weight) => {
    const font = `${weight} ${px}px ${stack}`
    const key = `${gen}|${font}|${text}`
    let w = widths.get(key)
    if (w === undefined) {
      c.font = font
      w = c.measureText(text).width
      if (widths.size > 4000) widths.clear()
      widths.set(key, w)
    }
    return w
  }
}

/** The callout font stack of an annotation: its own font first, else the text font, then the script fonts. */
export const calloutStack = (project: FrameContext['project'], a: Annotation): string => projectFontStack(project, a.font, CALLOUT_FONT())

/* ---------- poses ---------- */

/** No exit: a text running to the end of an edit whose last moments a pause freeze holds does not go out there (E-11). */
const NO_EXIT: CalloutMotion = { kind: 'none', duration: 0.1, strength: 0 }

function annotationPose(top: FrameContext, a: Annotation, em: number): CalloutPose | null {
  const c = calloutOf(a)
  const { project } = top
  const steady = noFadeOutFrom(project.clips, planOf(project), ANNOTATION_FADE)
  return calloutPose(a.start, a.end, top.t, project.clips, c.enter, a.end >= steady ? NO_EXIT : c.exit, em, calmOf(project.effects), OLD_FADE.text)
}

/** Moves, turns and scales the context about `o` by `pose`. */
function aboutPoint(c: Ctx, o: { x: number; y: number }, pose: CalloutPose): void {
  c.translate(o.x + pose.dx, o.y + pose.dy)
  if (pose.rotate) c.rotate((pose.rotate * Math.PI) / 180)
  c.scale(pose.scale * pose.scaleX, pose.scale)
  c.translate(-o.x, -o.y)
}

/* ---------- typewriter and wipe (§7.2) ---------- */

const advances = new Map<string, number[]>()

/** The widths of the first 1, 2, … graphemes of `line` where a prefix draws as in the line, else undefined (k / n of its width then). */
function prefixAdvances(c: Ctx, line: string, font: string): number[] | undefined {
  if (![...scriptsIn([line])].every(prefixDrawsSame)) return undefined
  const key = `${fontGeneration()}|${font}|${line}`
  let adv = advances.get(key)
  if (!adv) {
    c.font = font
    adv = []
    let acc = ''
    for (const g of graphemes(line)) {
      acc += g
      adv.push(c.measureText(acc).width)
    }
    if (advances.size > 4000) advances.clear()
    advances.set(key, adv)
  }
  return adv
}

/**
 * How much of each line a typewriter at `reveal` shows, px from its reading start: whole
 * graphemes only, in reading order across the lines (k of n, n the text's graphemes).
 */
export function typewriterWidths(c: Ctx, lines: readonly string[], widthsOf: readonly number[], font: string, reveal: number): number[] {
  const counts = lines.map((l) => graphemes(l).length)
  const n = counts.reduce((s, k) => s + k, 0)
  let k = Math.max(0, Math.min(n, Math.round(reveal * n)))
  return lines.map((line, i) => {
    const here = Math.min(k, counts[i])
    k -= here
    const adv = prefixAdvances(c, line, font)
    return typewriterClip({ graphemes: counts[i], ...(adv ? { prefixAdvances: adv } : {}), width: widthsOf[i] }, here)
  })
}

/* ---------- drawing ---------- */

/**
 * Draws `a` as a callout (§7.2): a step badge, a speech bubble, or a text with a motion of its own.
 * False when it is not one (today's code draws it). `label` is an automatic badge's number.
 */
export function drawCallout(c: Ctx, top: FrameContext, a: Annotation, label: string | null): boolean {
  if (!isCallout(a)) return false
  if (!(top.t >= a.start && top.t < a.end)) return true
  const co = calloutOf(a)
  if (co.style === 'badge' || co.style === 'bubble') {
    // The bundled script fonts (editingFontIds): the export waits for them; the preview starts them here.
    ensureCaptionFonts(top.project)
    const stack = calloutStack(top.project, a)
    c.save()
    const place = calloutPlace(a, co.style === 'badge' ? label : null, calloutFrame(top), measurer(c, stack))
    c.restore()
    if (!place) return true
    const pose = annotationPose(top, a, place.px)
    if (!pose || pose.alpha <= 0.002) return true
    if (place.kind === 'badge') drawBadge(c, top, place, pose, stack)
    else drawBubble(c, top, place, pose, stack, co.enter?.kind === 'typewriter')
    return true
  }
  drawMovingText(c, top, a)
  return true
}

/** A step badge (§7.3): a filled circle or pill with a white ring and a soft shadow, its label in white or #111111. */
function drawBadge(c: Ctx, top: FrameContext, place: CalloutPlace, pose: CalloutPose, stack: string): void {
  const S = Math.min(top.w, top.h)
  const { box } = place
  c.save()
  aboutPoint(c, place.origin, pose)
  c.globalAlpha = pose.alpha
  c.shadowColor = 'rgba(0, 0, 0, 0.35)'
  c.shadowOffsetY = 0.004 * S
  c.shadowBlur = 0.012 * S
  c.beginPath()
  c.roundRect(box.x, box.y, box.w, box.h, place.radius)
  c.fillStyle = place.fill
  c.fill()
  c.shadowColor = 'transparent'
  c.lineWidth = 0.004 * S
  c.strokeStyle = '#ffffff'
  c.stroke()
  c.font = `700 ${place.px}px ${stack}`
  c.fillStyle = place.text
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.fillText(place.lines[0] ?? '', box.x + box.w / 2, box.y + box.h / 2)
  c.restore()
}

/** A speech bubble (§7.4): one path for body and tail, a soft shadow, an outline on light fills, the text wrapped inside. */
function drawBubble(c: Ctx, top: FrameContext, place: CalloutPlace, pose: CalloutPose, stack: string, typewriter: boolean): void {
  const S = Math.min(top.w, top.h)
  const { box } = place
  const m = annotationMetrics({ size: place.px, style: 'bubble' }, 1, 1)
  c.save()
  aboutPoint(c, place.origin, pose)
  c.globalAlpha = pose.alpha
  c.shadowColor = 'rgba(0, 0, 0, 0.25)'
  c.shadowOffsetY = 0.006 * S
  c.shadowBlur = 0.02 * S
  calloutBubblePath(c, box, place.radius, place.tail)
  c.fillStyle = place.fill
  c.fill()
  c.shadowColor = 'transparent'
  if (bubbleOutlined(place.fill)) {
    c.lineWidth = 1
    c.strokeStyle = 'rgba(0, 0, 0, 0.15)'
    c.stroke()
  }
  const font = `600 ${place.px}px ${stack}`
  c.font = font
  c.fillStyle = place.text
  c.textBaseline = 'middle'
  const rtl = RTL_FIRST.test(place.lines.join(' '))
  c.direction = rtl ? 'rtl' : 'ltr'
  c.textAlign = rtl ? 'right' : 'left'
  const x = rtl ? box.x + box.w - m.padX : box.x + m.padX
  const reveal = Math.max(0, Math.min(1, pose.reveal))
  const lineWidths = place.lines.map((l) => c.measureText(l).width)
  const shown = reveal < 0.999 ? (typewriter ? typewriterWidths(c, place.lines, lineWidths, font, reveal) : lineWidths.map((w) => w * reveal)) : null
  c.font = font
  place.lines.forEach((line, i) => {
    const y = box.y + m.padY + place.lineHeight * (i + 0.5)
    if (!shown) return c.fillText(line, x, y)
    if (shown[i] <= 0) return
    c.save()
    c.beginPath()
    c.rect(rtl ? x - shown[i] : x, y - place.lineHeight, shown[i], place.lineHeight * 2)
    c.clip()
    c.fillText(line, x, y)
    c.restore()
  })
  c.restore()
}

/**
 * A text with a motion of its own (§7.2): measured and boxed as today's texts, then moved, scaled
 * and faded by its pose about the box's centre, and revealed from its reading start (wipe), or
 * grapheme by grapheme (typewriter).
 */
function drawMovingText(c: Ctx, top: FrameContext, a: Annotation): void {
  if (!a.text.trim()) return
  const { w, h, project } = top
  const m = annotationMetrics(a, w, h)
  const pose = annotationPose(top, a, m.px)
  if (!pose || pose.alpha <= 0.002) return
  const lines = a.text.split('\n')
  c.save()
  const font = `${m.weight} ${m.px}px ${projectFontStack(project, a.font, ANNOTATION_FONT)}`
  c.font = font
  const lineWidths = lines.map((l) => c.measureText(l || ' ').width)
  const textW = Math.max(...lineWidths)
  const boxW = textW + m.padX * 2
  const boxH = m.lineHeight * lines.length + m.padY * 2
  const cx = a.x * w
  const cy = a.y * h
  c.translate(cx + pose.dx, cy + pose.dy)
  if (pose.rotate) c.rotate((pose.rotate * Math.PI) / 180)
  c.scale(pose.scale * pose.scaleX, pose.scale)
  c.globalAlpha = pose.alpha
  const reveal = Math.max(0, Math.min(1, pose.reveal))
  const rtl = RTL_FIRST.test(a.text)
  const typewriter = calloutOf(a).enter?.kind === 'typewriter'
  if (reveal < 0.999 && !typewriter) {
    // Wipe: the box and its text from the reading start (the right edge for right-to-left text).
    c.beginPath()
    c.rect(rtl ? boxW / 2 - boxW * reveal : -boxW / 2, -boxH, boxW * reveal, boxH * 2)
    c.clip()
  }
  if (a.style === 'pill') {
    c.shadowColor = 'rgba(0,0,0,0.28)'
    c.shadowBlur = m.px * 0.6
    c.shadowOffsetY = m.px * 0.12
    c.beginPath()
    c.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, Math.min(boxH / 2, m.px))
    c.fillStyle = 'rgba(17,17,24,0.8)'
    c.fill()
    c.shadowColor = 'transparent'
    c.lineWidth = Math.max(1, m.px * 0.04)
    c.strokeStyle = 'rgba(255,255,255,0.1)'
    c.stroke()
  } else {
    c.shadowColor = 'rgba(0,0,0,0.55)'
    c.shadowBlur = m.px * 0.35
    c.shadowOffsetY = m.px * 0.08
  }
  c.fillStyle = '#fff'
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  const shown = reveal < 0.999 && typewriter ? typewriterWidths(c, lines, lineWidths, font, reveal) : null
  c.font = font
  lines.forEach((line, i) => {
    const y = -boxH / 2 + m.padY + m.lineHeight * (i + 0.5)
    if (!shown) return c.fillText(line, 0, y)
    const lw = lineWidths[i]
    if (shown[i] <= 0) return
    c.save()
    c.beginPath()
    c.rect(rtl ? lw / 2 - shown[i] : -lw / 2, y - m.lineHeight, shown[i], m.lineHeight * 2)
    c.clip()
    c.fillText(line, 0, y)
    c.restore()
  })
  c.restore()
}

/** A shape's pose at fc.t (it has a motion), or null: today's fade. Privacy shapes never move. */
export function shapeCalloutPose(fc: FrameContext, s: Shape): CalloutPose | null {
  if (isPrivacyKind(s.kind) || (!s.enter && !s.exit)) return null
  const a = fc.toOut(s.x, s.y)
  const b = fc.toOut(s.x + s.w, s.y + s.h)
  const u = Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  return calloutPose(s.start, s.end, fc.t, fc.project.clips, s.enter, s.exit, u, calmOf(fc.project.effects), OLD_FADE.shape)
}

/**
 * A title card's pose at fc.t (it has a motion), or null: today's fade and rise. A typewriter
 * reveals whole graphemes of the card's text (k of n).
 */
export function titleCalloutPose(fc: FrameContext, card: TitleCard): CalloutPose | null {
  const pose = titleMotionPose(card, fc.t, fc.project.clips, titleEm(card, fc.w, fc.h), calmOf(fc.project.effects))
  if (!pose || card.enter?.kind !== 'typewriter' || pose.reveal >= 1) return pose
  const n = Math.max(1, graphemes(`${card.title}${card.subtitle ?? ''}`).length)
  return { ...pose, reveal: Math.round(pose.reveal * n) / n }
}
