import { animationTime, isAnimated } from '../../../shared/engine/backgrounds'
import { backgroundIsLight, luminance, titleColorOf, titleTextColorOf } from '../../../shared/editor/titles'
import { TITLE_FONT, titleLayout, titlePhase, type MeasureText, type TextBlock, type TitleLayout, type TitlePhase } from '../../../shared/render/titleCards'
import type { Rect } from '../../../shared/engine/layout'
import type { TitleCard } from '../../../shared/types'
import type { FrameContext } from './frameContext'
import { paintBackgroundLayer } from './staticLayer'

type Ctx = CanvasRenderingContext2D

/* ---------- measuring and layout (cached: only a new text or frame size measures again) ---------- */

/** Text is measured once at this size and scaled, so every frame size wraps the same words. */
const MEASURE_PX = 100
const widths = new Map<string, number>()

function measureOn(ctx: Ctx): MeasureText {
  return (text, px, weight) => {
    const key = `${weight}|${text}`
    let w = widths.get(key)
    if (w === undefined) {
      ctx.font = `${weight} ${MEASURE_PX}px ${TITLE_FONT}`
      w = ctx.measureText(text).width
      if (widths.size > 5000) widths.clear()
      widths.set(key, w)
    }
    return (w * px) / MEASURE_PX
  }
}

const layouts = new Map<string, TitleLayout>()

function layoutOf(ctx: Ctx, card: TitleCard, w: number, h: number): TitleLayout {
  const key = JSON.stringify([w, h, card.style, card.title, card.subtitle ?? ''])
  let l = layouts.get(key)
  if (!l) {
    ctx.save()
    l = titleLayout(card, w, h, measureOn(ctx))
    ctx.restore()
    if (layouts.size > 64) layouts.clear()
    layouts.set(key, l)
  }
  return l
}

/* ---------- the blurred frame under a card ---------- */

/** Long side of the blurred copy of the frame (the same for preview and export, so they look alike). */
const BLUR_SIDE = 256
/** Blur radius as a fraction of the copy's shorter side. */
const BLUR_SIGMA = 0.045

interface BlurredFrame {
  /** Work canvas (the frame with its edges stretched into a margin) and the blurred result. */
  padded: HTMLCanvasElement
  blurred: HTMLCanvasElement
  /** Where the frame is in `blurred`. */
  m: number
  sw: number
  sh: number
  /** The frame it was made for: one blur per frame, whatever number of cards uses it. */
  fc: FrameContext | null
}

const blurs = new WeakMap<Ctx, BlurredFrame>()

/**
 * The frame drawn so far, small and blurred. Made once per frame on two small canvases kept for
 * the output (never allocated per frame), reading the full-size frame only once: it is drawn
 * small, copied with its edges stretched into a margin (so the blur does not darken the edges),
 * then blurred.
 */
function blurredFrame(fc: FrameContext): BlurredFrame | null {
  if (typeof document === 'undefined') return null
  let b = blurs.get(fc.ctx)
  if (b && b.fc === fc) return b
  const s = BLUR_SIDE / Math.max(fc.w, fc.h)
  const sw = Math.max(2, Math.round(fc.w * s))
  const sh = Math.max(2, Math.round(fc.h * s))
  const sigma = Math.max(1, BLUR_SIGMA * Math.min(sw, sh))
  const m = Math.ceil(sigma * 2.5)
  if (!b) {
    b = { padded: document.createElement('canvas'), blurred: document.createElement('canvas'), m, sw, sh, fc: null }
    blurs.set(fc.ctx, b)
  }
  for (const c of [b.padded, b.blurred]) {
    if (c.width !== sw + 2 * m) c.width = sw + 2 * m
    if (c.height !== sh + 2 * m) c.height = sh + 2 * m
  }
  const p = b.padded.getContext('2d', { alpha: false })
  const o = b.blurred.getContext('2d', { alpha: false })
  if (!p || !o) return null
  const W = sw + 2 * m
  const H = sh + 2 * m
  // 1. The frame, small, into the middle of the result canvas (its only full-size read).
  o.imageSmoothingEnabled = true
  o.imageSmoothingQuality = 'medium'
  o.globalCompositeOperation = 'copy'
  o.drawImage(fc.ctx.canvas, 0, 0, fc.w, fc.h, m, m, sw, sh)
  // 2. Stretched over the whole work canvas (filling the margin from the edges), and exact in its middle.
  p.imageSmoothingEnabled = true
  p.drawImage(b.blurred, m, m, sw, sh, 0, 0, W, H)
  p.drawImage(b.blurred, m, m, sw, sh, m, m, sw, sh)
  // 3. Blurred back into the result.
  o.filter = `blur(${sigma}px)`
  o.drawImage(b.padded, 0, 0)
  o.filter = 'none'
  o.globalCompositeOperation = 'source-over'
  b.m = m
  b.sw = sw
  b.sh = sh
  b.fc = fc
  return b
}

/* ---------- the text as a picture (made once per card, text and size) ---------- */

/**
 * What a card draws over its background at full opacity: its text (with the soft shadow), and
 * for a lower third the accent bar (and a solid band with its shadow). Drawn once on a canvas
 * of its own; every frame of the card then copies it with its fade as the alpha, instead of
 * laying out the glyphs and blurring their shadow again (perf audit, wave-3 rules 4 and 6).
 */
interface Sprite {
  canvas: HTMLCanvasElement
  /** Where the canvas goes while the card holds still (whole pixels). */
  x: number
  y: number
}

/** Cards on screen at once are few; a 4K sprite is tens of MB, so only the latest are kept. */
const MAX_SPRITES = 4
const sprites = new Map<string, Sprite>()

/**
 * The picture `paint` draws in output coordinates within `pad` px around `box`, made once per
 * `key` (its fractional position kept inside the canvas). Null without a DOM: draw directly.
 */
function spriteOf(key: string, box: Rect, pad: number, paint: (c: Ctx) => void): Sprite | null {
  const hit = sprites.get(key)
  if (hit) {
    // The most recently used last: the oldest one goes first.
    sprites.delete(key)
    sprites.set(key, hit)
    return hit
  }
  if (typeof document === 'undefined') return null
  const x = Math.floor(box.x) - pad
  const y = Math.floor(box.y) - pad
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(box.x + box.w) + pad - x)
  canvas.height = Math.max(1, Math.ceil(box.y + box.h) + pad - y)
  const c = canvas.getContext('2d')
  if (!c) return null
  c.translate(-x, -y)
  paint(c)
  if (sprites.size >= MAX_SPRITES) {
    const [oldest, gone] = sprites.entries().next().value!
    sprites.delete(oldest)
    gone.canvas.width = gone.canvas.height = 0
  }
  const sprite = { canvas, x, y }
  sprites.set(key, sprite)
  return sprite
}

/**
 * Copies `sprite` moved down by `dy` (the rise) at whole pixels: exactly what drawing the card
 * directly gives while it holds still, and crisp (the glyphs land on whole pixels anyway) and
 * cheap while it rises.
 */
function drawSprite(ctx: Ctx, sprite: Sprite, dy: number): void {
  ctx.drawImage(sprite.canvas, sprite.x, Math.round(sprite.y + dy))
}

/** Room around a text block for glyphs reaching past their line (accents, descenders, overhangs). */
const glyphPad = (l: TitleLayout): number => Math.ceil(Math.max(l.title.px, l.subtitle?.px ?? 0) * 0.35)

/* ---------- drawing ---------- */

/** Darkening over the blurred video (and a project background picture), so white text reads on any picture. */
const BLUR_TINT = 'rgba(10, 10, 16, 0.42)'
const BAND_TINT = 'rgba(12, 12, 18, 0.5)'

/** Fills the frame (clipped by the caller) with the card's background. */
function paintCardBackground(fc: FrameContext, card: TitleCard, tint: string): void {
  const { ctx, w, h, project } = fc
  if (card.background === 'solid') {
    ctx.fillStyle = titleColorOf(card)
    ctx.fillRect(0, 0, w, h)
  } else if (card.background === 'style') {
    const t = isAnimated(project.style.background) ? animationTime(project.clips, fc.t) : 0
    paintBackgroundLayer(ctx, w, h, project.style, fc.background ?? null, t)
    // Colours and wallpapers pick the text colour (titleTextColorOf); an image of unknown brightness is darkened like the video.
    if (backgroundIsLight(project.style.background) === null) {
      ctx.fillStyle = tint
      ctx.fillRect(0, 0, w, h)
    }
  } else {
    const b = blurredFrame(fc)
    if (b) {
      // Bilinear is enough to scale up a picture this soft.
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'low'
      ctx.drawImage(b.blurred, b.m, b.m, b.sw, b.sh, 0, 0, w, h)
    }
    ctx.fillStyle = b ? tint : '#14141c'
    ctx.fillRect(0, 0, w, h)
  }
}

/** Draws the lines of `block` from `top`, at `x` (aligned as `align`). */
function drawBlock(ctx: Ctx, block: TextBlock, x: number, top: number, align: CanvasTextAlign): void {
  ctx.font = `${block.weight} ${block.px}px ${TITLE_FONT}`
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  block.lines.forEach((line, i) => {
    if (line) ctx.fillText(line, x, top + block.lineHeight * (i + 0.5))
  })
}

/** Title and subtitle from `top`; the subtitle a little softer. */
function drawText(ctx: Ctx, l: TitleLayout, x: number, top: number, align: CanvasTextAlign, color: string, alpha: number): void {
  ctx.fillStyle = color
  ctx.globalAlpha = alpha
  drawBlock(ctx, l.title, x, top, align)
  if (l.subtitle) {
    ctx.globalAlpha = alpha * 0.8
    drawBlock(ctx, l.subtitle, x, top + l.title.lines.length * l.title.lineHeight + l.gap, align)
  }
}

function drawFullFrame(fc: FrameContext, card: TitleCard, phase: TitlePhase, l: TitleLayout): void {
  const { ctx, w, h } = fc
  if (phase.background > 0.002) {
    ctx.save()
    ctx.globalAlpha = phase.background
    paintCardBackground(fc, card, BLUR_TINT)
    ctx.restore()
  }
  if (phase.text <= 0.002 || l.height <= 0) return
  const color = titleTextColorOf(card, fc.project.style.background)
  // A soft shadow keeps light text readable on a picture; a solid colour and dark text do not need one.
  const shadowed = card.background !== 'solid' && luminance(color) > 0.2
  const blur = l.title.px * 0.28
  const drop = l.title.px * 0.04
  const top = (h - l.height) / 2
  const paint = (c: Ctx, alpha: number, rise: number): void => {
    c.save()
    if (shadowed) {
      c.shadowColor = 'rgba(0, 0, 0, 0.35)'
      c.shadowBlur = blur
      c.shadowOffsetY = drop
    }
    drawText(c, l, w / 2, top + rise, 'center', color, alpha)
    c.restore()
  }
  const key = JSON.stringify(['full', w, h, card.style, card.title, card.subtitle ?? '', color, shadowed])
  const pad = glyphPad(l) + (shadowed ? Math.ceil(blur * 1.5 + drop) : 0)
  const sprite = spriteOf(key, { x: (w - l.width) / 2, y: top, w: l.width, h: l.height }, pad, (c) => paint(c, 1, 0))
  if (!sprite) {
    paint(ctx, phase.text, phase.rise * l.rise)
    return
  }
  ctx.save()
  ctx.globalAlpha = phase.text
  drawSprite(ctx, sprite, phase.rise * l.rise)
  ctx.restore()
}

function drawLowerThird(fc: FrameContext, card: TitleCard, phase: TitlePhase, l: TitleLayout): void {
  const { ctx, w, h } = fc
  const band = l.band
  if (!band || phase.text <= 0.002 || l.height <= 0) return
  const solid = card.background === 'solid'
  const color = titleTextColorOf(card, fc.project.style.background)
  const blur = band.h * 0.35
  const drop = band.h * 0.06
  // A solid band with its shadow, the accent bar and the text: the same in every frame of the card.
  const paint = (c: Ctx, alpha: number, y: number): void => {
    c.save()
    c.globalAlpha = alpha
    if (solid) {
      c.save()
      c.shadowColor = 'rgba(0, 0, 0, 0.3)'
      c.shadowBlur = blur
      c.shadowOffsetY = drop
      c.fillStyle = titleColorOf(card)
      c.beginPath()
      c.roundRect(band.x, y, band.w, band.h, band.radius)
      c.fill()
      c.restore()
    }
    // An accent bar beside the text.
    c.fillStyle = color
    c.globalAlpha = alpha * 0.9
    c.beginPath()
    c.roundRect(band.x + band.padX, y + band.padY, band.accent, l.height, band.accent / 2)
    c.fill()
    drawText(c, l, band.x + band.padX + band.accent * 2.4, y + band.padY, 'left', color, alpha)
    c.restore()
  }
  const y = band.y + phase.rise * l.rise
  ctx.save()
  ctx.globalAlpha = phase.text
  if (!solid) {
    // The band shows the frame (or the project's background) behind it, so it is drawn every frame.
    ctx.beginPath()
    ctx.roundRect(band.x, y, band.w, band.h, band.radius)
    ctx.save()
    ctx.clip()
    paintCardBackground(fc, card, BAND_TINT)
    ctx.restore()
    // The background may have drawn paths of its own: the band's outline again for its edge.
    ctx.beginPath()
    ctx.roundRect(band.x, y, band.w, band.h, band.radius)
    ctx.lineWidth = Math.max(1, band.h * 0.012)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
    ctx.stroke()
  }
  const key = JSON.stringify(['lower', w, h, card.title, card.subtitle ?? '', color, solid ? titleColorOf(card) : ''])
  const pad = glyphPad(l) + (solid ? Math.ceil(blur * 1.5 + drop) : 0)
  const sprite = spriteOf(key, band, pad, (c) => paint(c, 1, band.y))
  if (sprite) drawSprite(ctx, sprite, phase.rise * l.rise)
  else paint(ctx, phase.text, y)
  ctx.restore()
}

/**
 * Title cards active at fc.t, drawn over the finished frame (under the watermark): full-frame
 * cards over their background (the blurred frame, a colour or the project's background), lower
 * thirds in a band at the bottom. They fade and rise in and fade out (shared/render/titleCards).
 */
export function drawTitleCardsLayer(fc: FrameContext): void {
  const titles = fc.project.titles
  if (!titles?.length) return
  let active: { card: TitleCard; phase: TitlePhase }[] | null = null
  for (const card of titles) {
    const phase = titlePhase(card, fc.t, fc.project.clips)
    if (phase) (active ??= []).push({ card, phase })
  }
  if (!active) return
  // Later cards on top.
  active.sort((a, b) => a.card.start - b.card.start)
  for (const { card, phase } of active) {
    const l = layoutOf(fc.ctx, card, fc.w, fc.h)
    if (card.style === 'lower-third') drawLowerThird(fc, card, phase, l)
    else drawFullFrame(fc, card, phase, l)
  }
}
