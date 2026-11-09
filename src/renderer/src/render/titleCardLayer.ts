import { animationTime, isAnimated } from '../../../shared/engine/backgrounds'
import { backgroundIsLight, luminance, titleColorOf, titleTextColorOf } from '../../../shared/editor/titles'
import { captionLanguage } from '../../../shared/captions/captionTracks'
import { maskBleeped } from '../../../shared/captions/cleanup'
import { catalogFamily, catalogId } from '../../../shared/captions/fontCatalog'
import { STUDIO_BASE } from '../../../shared/captions/studioPresets'
import { withWordDigits } from '../../../shared/captions/words'
import { quoteName, quotePanel, TITLE_FONT, titleLayout, titlePhase, type MeasureText, type TextBlock, type TitleLayout, type TitlePhase } from '../../../shared/render/titleCards'
import { CALLOUT_FALLBACK_IDS } from '../../../shared/render/editingFonts'
import type { Rect } from '../../../shared/engine/layout'
import type { TitleCard } from '../../../shared/types'
import type { Project } from '../../../shared/types'
import { ensureCaptionFonts, fontGeneration, projectFontStack } from './fontLoader'
import type { FrameContext } from './frameContext'
import { RTL_FIRST } from '../../../shared/captions/layout'
import { graphemes, type CalloutPose } from '../../../shared/render/callouts'
import { titleCalloutPose, typewriterWidths } from './calloutLayer'
import { paintBackgroundLayer } from './staticLayer'

type Ctx = CanvasRenderingContext2D

/* ---------- measuring and layout (cached: only a new text or frame size measures again) ---------- */

/** Text is measured once at this size and scaled, so every frame size wraps the same words. */
const MEASURE_PX = 100
const widths = new Map<string, number>()

/** The quote style's font (captions-studio.md §10.1). */
const QUOTE_FONT = 'instrument-serif-italic'
/** After a catalogue font: the bundled script fonts and the colour emoji face (§6.6), then the title font. */
export const CATALOG_FALLBACK = CALLOUT_FALLBACK_IDS.map((id) => `"${catalogFamily(id)}"`).join(', ')

const BENGALI = /\p{Script=Bengali}/u

/**
 * The font stack of a card: a catalogue font (`cat:`, and the quote style's), its brand font, else
 * the title font. Cards without a `cat:` font and of the older styles draw exactly as before.
 * Bangla on a card without a font of its own (BANGLA-NOTES): a quote's in Noto Serif Bengali, an
 * automatic lower third's or chapter title's in the caption look's Bangla font (§0.2).
 */
export function cardFont(project: Pick<Project, 'id' | 'fonts' | 'captions'>, card: TitleCard): string {
  const quote = card.style === 'quote' && !card.font
  const cat = catalogId(card.font) ?? (quote ? QUOTE_FONT : null)
  if (cat) return `"${catalogFamily(cat)}", ${quote ? `"${catalogFamily('noto-serif-bengali')}", ` : ''}${CATALOG_FALLBACK}, ${TITLE_FONT}`
  const bangla = card.auto && !card.font && BENGALI.test(`${card.title}\n${card.subtitle ?? ''}`) ? catalogId((project.captions?.studio ?? STUDIO_BASE).text.scripts?.bengali?.font) : null
  // After Segoe UI, which has no Bangla, so the other letters draw as before.
  if (bangla) return `'Segoe UI Variable Display', 'Segoe UI', "${catalogFamily(bangla)}", ${TITLE_FONT}`
  return projectFontStack(project, card.font, TITLE_FONT)
}

/** A cache key part for a font: the stack and the font generation (widths measured while it loaded are dropped). */
const fontKey = (font: string): string => `${fontGeneration()}|${font}`

function measureOn(ctx: Ctx, font: string): MeasureText {
  return (text, px, weight) => {
    const key = `${fontKey(font)}|${weight}|${text}`
    let w = widths.get(key)
    if (w === undefined) {
      ctx.font = `${weight} ${MEASURE_PX}px ${font}`
      w = ctx.measureText(text).width
      if (widths.size > 5000) widths.clear()
      widths.set(key, w)
    }
    return (w * px) / MEASURE_PX
  }
}

const layouts = new Map<string, TitleLayout>()

/** `area`: the text area a lower third keeps to (null: the whole frame). */
function layoutOf(ctx: Ctx, card: TitleCard, w: number, h: number, font: string, area: Rect | null): TitleLayout {
  const key = JSON.stringify([w, h, card.style, card.title, card.subtitle ?? '', fontKey(font), area])
  let l = layouts.get(key)
  if (!l) {
    ctx.save()
    // A quote card's name line reads "— Name" (§10.1), measured as drawn.
    l = titleLayout(card.style === 'quote' ? { ...card, subtitle: quoteName(card.subtitle) } : card, w, h, measureOn(ctx, font), area)
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
 * Blurs the `fw` x `fh` frame of `ctx` into `b`'s small canvases (`size` px on its long side),
 * reading the full-size frame only once: it is drawn small, copied with its edges stretched into a
 * margin (so the blur does not darken the edges), then blurred. Only these small canvases are
 * filtered, never the frame.
 */
function blurInto(ctx: Ctx, fw: number, fh: number, size: number, b: BlurredFrame): boolean {
  const s = size / Math.max(fw, fh)
  const sw = Math.max(2, Math.round(fw * s))
  const sh = Math.max(2, Math.round(fh * s))
  const sigma = Math.max(1, BLUR_SIGMA * Math.min(sw, sh))
  const m = Math.ceil(sigma * 2.5)
  for (const c of [b.padded, b.blurred]) {
    if (c.width !== sw + 2 * m) c.width = sw + 2 * m
    if (c.height !== sh + 2 * m) c.height = sh + 2 * m
  }
  const p = b.padded.getContext('2d', { alpha: false })
  const o = b.blurred.getContext('2d', { alpha: false })
  if (!p || !o) return false
  const W = sw + 2 * m
  const H = sh + 2 * m
  // 1. The frame, small, into the middle of the result canvas (its only full-size read).
  o.imageSmoothingEnabled = true
  o.imageSmoothingQuality = 'medium'
  o.globalCompositeOperation = 'copy'
  o.drawImage(ctx.canvas, 0, 0, fw, fh, m, m, sw, sh)
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
  return true
}

/**
 * The frame drawn so far, small and blurred. Made once per frame on two small canvases kept for
 * the output (never allocated per frame).
 */
function blurredFrame(fc: FrameContext): BlurredFrame | null {
  if (typeof document === 'undefined') return null
  let b = blurs.get(fc.ctx)
  if (b && b.fc === fc) return b
  if (!b) {
    b = { padded: document.createElement('canvas'), blurred: document.createElement('canvas'), m: 0, sw: 0, sh: 0, fc: null }
    blurs.set(fc.ctx, b)
  }
  if (!blurInto(fc.ctx, fc.w, fc.h, BLUR_SIDE, b)) return null
  b.fc = fc
  return b
}

/** The canvases blurredFrameOf keeps per frame canvas and size (never allocated per frame), and the copy it returns. */
const frameBlurs = new WeakMap<Ctx, Map<number, { b: BlurredFrame; out: HTMLCanvasElement }>>()

/**
 * A blurred copy of the frame drawn so far into `ctx`, made off the frame canvas at `size` px on
 * its long side (Captions Studio §9.7: the title cards' blur, shared with the Glass look): the
 * whole frame, small, with no margin. The frame canvas itself is never filtered.
 */
export function blurredFrameOf(ctx: CanvasRenderingContext2D, size: 256 | 128): HTMLCanvasElement {
  let bySize = frameBlurs.get(ctx)
  if (!bySize) frameBlurs.set(ctx, (bySize = new Map()))
  let e = bySize.get(size)
  if (!e) bySize.set(size, (e = { b: { padded: document.createElement('canvas'), blurred: document.createElement('canvas'), m: 0, sw: 0, sh: 0, fc: null }, out: document.createElement('canvas') }))
  const { b, out } = e
  if (!blurInto(ctx, ctx.canvas.width, ctx.canvas.height, size, b)) return out
  if (out.width !== b.sw) out.width = b.sw
  if (out.height !== b.sh) out.height = b.sh
  const r = out.getContext('2d', { alpha: false })
  if (r) {
    r.globalCompositeOperation = 'copy'
    r.drawImage(b.blurred, b.m, b.m, b.sw, b.sh, 0, 0, b.sw, b.sh)
  }
  return out
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

/**
 * How a card's text comes in while it wipes or types (docs/design/editing-polish.md §7.2): from its
 * reading start, the right edge for right-to-left text. `rtl`: the card's first letter is from a
 * right-to-left script (where Wipe starts). `lines` (Typewriter): the px shown of each line, the
 * title's and then the subtitle's, whole graphemes in reading order, each text from its own reading
 * start (drawBlock); null: the whole card wipes.
 */
interface CardReveal {
  rtl: boolean
  lines: number[] | null
}

function cardReveal(ctx: Ctx, card: TitleCard, l: TitleLayout, font: string, reveal: number): CardReveal {
  const blocks = l.subtitle ? [l.title, l.subtitle] : [l.title]
  const rtl = RTL_FIRST.test(blocks.flatMap((b) => b.lines).join(' '))
  if (card.enter?.kind !== 'typewriter') return { rtl, lines: null }
  const counts = blocks.map((b) => b.lines.reduce((n, line) => n + graphemes(line).length, 0))
  let k = Math.round(Math.max(0, Math.min(1, reveal)) * counts.reduce((a, b) => a + b, 0))
  ctx.save()
  const lines = blocks.flatMap((b, i) => {
    const here = Math.min(k, counts[i])
    k -= here
    return typewriterWidths(ctx, b.lines, b.widths, `${b.weight} ${b.px}px ${font}`, counts[i] ? here / counts[i] : 0)
  })
  ctx.restore()
  return { rtl, lines }
}

/**
 * A card's motion of its own (docs/design/editing-polish.md §7.2): its text (and a lower third's
 * band) moved, scaled and turned about `box`'s centre, and wiped in from its reading start (a
 * typewriter clips each line as it is drawn instead); nothing without a pose.
 */
function applyPose(ctx: Ctx, box: Rect, pose: CalloutPose | null, reveal: CardReveal | null = null): void {
  if (!pose) return
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  ctx.translate(cx + pose.dx, cy + pose.dy)
  if (pose.rotate) ctx.rotate((pose.rotate * Math.PI) / 180)
  ctx.scale(pose.scale * pose.scaleX, pose.scale)
  ctx.translate(-cx, -cy)
  if (pose.reveal < 1 && !reveal?.lines) {
    const shown = box.w * Math.max(0, pose.reveal)
    ctx.beginPath()
    ctx.rect(reveal?.rtl ? box.x + box.w - shown : box.x, box.y - box.h, shown, box.h * 3)
    ctx.clip()
  }
}

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

/**
 * Draws the lines of `block` from `top`, at `x` (aligned as `align`); with `shown` (a typewriter),
 * each line only as far as its px shown, from the block's own reading start (a title and its
 * subtitle may be in different scripts).
 */
function drawBlock(ctx: Ctx, block: TextBlock, x: number, top: number, align: CanvasTextAlign, font: string, shown: readonly number[] | null = null): void {
  ctx.font = `${block.weight} ${block.px}px ${font}`
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  const rtl = shown !== null && RTL_FIRST.test(block.lines.join(' '))
  block.lines.forEach((line, i) => {
    if (!line) return
    const y = top + block.lineHeight * (i + 0.5)
    if (!shown) return ctx.fillText(line, x, y)
    const s = shown[i] ?? 0
    if (!(s > 0)) return
    const w = block.widths[i] ?? 0
    const left = align === 'center' ? x - w / 2 : x
    ctx.save()
    ctx.beginPath()
    ctx.rect(rtl ? left + w - s : left, y - block.lineHeight, s, block.lineHeight * 2)
    ctx.clip()
    ctx.fillText(line, x, y)
    ctx.restore()
  })
}

/** Title and subtitle from `top`; the subtitle a little softer. `reveal`: a typewriter's lines shown. */
function drawText(ctx: Ctx, l: TitleLayout, x: number, top: number, align: CanvasTextAlign, color: string, alpha: number, font: string, reveal: CardReveal | null = null): void {
  const shown = reveal?.lines ?? null
  ctx.fillStyle = color
  ctx.globalAlpha = alpha
  drawBlock(ctx, l.title, x, top, align, font, shown)
  if (l.subtitle) {
    ctx.globalAlpha = alpha * 0.8
    drawBlock(ctx, l.subtitle, x, top + l.title.lines.length * l.title.lineHeight + l.gap, align, font, shown && shown.slice(l.title.lines.length))
  }
}

function drawFullFrame(fc: FrameContext, card: TitleCard, phase: TitlePhase, l: TitleLayout, font: string, pose: CalloutPose | null = null, reveal: CardReveal | null = null): void {
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
  const paint = (c: Ctx, alpha: number, rise: number, typed: CardReveal | null = null): void => {
    c.save()
    if (shadowed) {
      c.shadowColor = 'rgba(0, 0, 0, 0.35)'
      c.shadowBlur = blur
      c.shadowOffsetY = drop
    }
    drawText(c, l, w / 2, top + rise, 'center', color, alpha, font, typed)
    c.restore()
  }
  const key = JSON.stringify(['full', w, h, card.style, card.title, card.subtitle ?? '', color, shadowed, fontKey(font)])
  const pad = glyphPad(l) + (shadowed ? Math.ceil(blur * 1.5 + drop) : 0)
  const box = { x: (w - l.width) / 2, y: top, w: l.width, h: l.height }
  // While a typewriter types, its lines are drawn as far as they are shown, not from the picture.
  const sprite = reveal?.lines ? null : spriteOf(key, box, pad, (c) => paint(c, 1, 0))
  if (!sprite) {
    if (pose) ctx.save()
    applyPose(ctx, box, pose, reveal)
    paint(ctx, phase.text, phase.rise * l.rise, reveal)
    if (pose) ctx.restore()
    return
  }
  ctx.save()
  applyPose(ctx, box, pose, reveal)
  ctx.globalAlpha = phase.text
  drawSprite(ctx, sprite, phase.rise * l.rise)
  ctx.restore()
}

function drawLowerThird(fc: FrameContext, card: TitleCard, phase: TitlePhase, l: TitleLayout, font: string, pose: CalloutPose | null = null, reveal: CardReveal | null = null): void {
  const { ctx, w, h } = fc
  const band = l.band
  if (!band || phase.text <= 0.002 || l.height <= 0) return
  const solid = card.background === 'solid'
  const color = titleTextColorOf(card, fc.project.style.background)
  const blur = band.h * 0.35
  const drop = band.h * 0.06
  // A solid band with its shadow, the accent bar and the text: the same in every frame of the card.
  const paint = (c: Ctx, alpha: number, y: number, typed: CardReveal | null = null): void => {
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
    drawText(c, l, band.x + band.padX + band.accent * 2.4, y + band.padY, 'left', color, alpha, font, typed)
    c.restore()
  }
  const y = band.y + phase.rise * l.rise
  ctx.save()
  applyPose(ctx, band, pose, reveal)
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
  // The card in this frame size, its colours and its whole layout (the band, the lines and their
  // sizes, which a text area changes; one that moves only away from the band pictures nothing new).
  const key = JSON.stringify(['lower', w, h, card.title, card.subtitle ?? '', color, solid ? titleColorOf(card) : '', fontKey(font), l])
  const pad = glyphPad(l) + (solid ? Math.ceil(blur * 1.5 + drop) : 0)
  // While a typewriter types, its lines are drawn as far as they are shown, not from the picture.
  const sprite = reveal?.lines ? null : spriteOf(key, band, pad, (c) => paint(c, 1, band.y))
  if (sprite) drawSprite(ctx, sprite, phase.rise * l.rise)
  else paint(ctx, phase.text, y, reveal)
  ctx.restore()
}

/**
 * Title cards active at fc.t, drawn over the finished frame (under the watermark): full-frame
 * cards over their background (the blurred frame, a colour or the project's background), lower
 * thirds in a band at the bottom (of the text area, fc.textArea, when there is one). They fade and rise in and fade out (shared/render/titleCards).
 */
/**
 * A card as drawn: a chapter title made from the chapters (Captions Studio §10.1) writes its digits
 * in the captions' Digits choice (§0.2), a Latin word keeping its own as in captions ("MP3"); a
 * quote card masks a bleeped word as the captions do, also when it was made before the bleep
 * (§11.7); every other card is the card itself.
 */
function drawnCard(project: Project, card: TitleCard): TitleCard {
  const digits = project.captions?.digits
  let title = card.title
  if (digits && card.auto?.by === 'chapter') title = withWordDigits(title, digits, captionLanguage(project))
  if (card.style === 'quote') title = maskBleeped(title, project.bleeps)
  return title === card.title ? card : { ...card, title }
}

export function drawTitleCardsLayer(fc: FrameContext): void {
  const titles = fc.project.titles
  if (!titles?.length) return
  let active: { card: TitleCard; phase: TitlePhase }[] | null = null
  for (const card of titles) {
    const phase = titlePhase(card, fc.t, fc.project.clips)
    if (phase) (active ??= []).push({ card: drawnCard(fc.project, card), phase })
  }
  if (!active) return
  // Later cards on top.
  active.sort((a, b) => a.card.start - b.card.start)
  // Catalogue fonts (cat: and quote cards) load as the editor draws; the export waits for them (prepareCaptionFonts).
  if (titles.some((c) => c.style === 'quote' || c.auto || catalogId(c.font))) ensureCaptionFonts(fc.project)
  for (const { card, phase } of active) {
    const font = cardFont(fc.project, card)
    const lower = card.style === 'lower-third'
    const l = layoutOf(fc.ctx, card, fc.w, fc.h, font, lower ? fc.textArea : null)
    // A card with a motion of its own (editing polish §7.2): its text and a lower third's band take
    // the pose; a full-frame card's background keeps titlePhase's fade. Null: today's fade and rise.
    const pose = card.enter || card.exit ? titleCalloutPose(fc, card) : null
    const shown = pose ? { ...phase, text: pose.alpha, rise: 0 } : phase
    // Wipe and Typewriter come in from the text's reading start; a typewriter by whole graphemes, line by line.
    const reveal = pose && pose.reveal < 1 ? cardReveal(fc.ctx, card, l, font, pose.reveal) : null
    if (lower) drawLowerThird(fc, card, shown, l, font, pose, reveal)
    else if (card.style === 'quote') drawQuote(fc, card, shown, l, font, pose, reveal)
    else drawFullFrame(fc, card, shown, l, font, pose, reveal)
  }
}

/** #rrggbb's relative luminance is above the middle: dark text on it. */
const lightColour = (hex: string): boolean => luminance(hex) > 0.45

/**
 * A quote card (Captions Studio §10.1): a pull quote on a panel in the caption look's box colour
 * at α 0.85 (radius 0.3 em), the quote in Instrument Serif Italic, an opening “ in the emphasis
 * colour at 1.6×, and "— Name" under it at 0.6×; no full-frame background. It fades over
 * TITLE_FADE (at least 0.2 s, §9.6) and rises in like the other cards.
 */
function drawQuote(fc: FrameContext, card: TitleCard, phase: TitlePhase, l: TitleLayout, font: string, pose: CalloutPose | null = null, reveal: CardReveal | null = null): void {
  const { ctx, w, h } = fc
  if (phase.text <= 0.002 || l.height <= 0) return
  const look = fc.project.captions?.studio ?? STUDIO_BASE
  const panelColour = card.color ?? look.theme.box
  const textColour = card.textColor ?? (lightColour(panelColour) ? '#111111' : '#ffffff')
  const markColour = look.theme.emphasis
  const q = quotePanel(l, w, h)
  const paint = (c: Ctx, alpha: number, rise: number, typed: CardReveal | null = null): void => {
    c.save()
    c.globalAlpha = alpha * 0.85
    c.fillStyle = panelColour
    c.beginPath()
    c.roundRect(q.panel.x, q.panel.y + rise, q.panel.w, q.panel.h, q.radius)
    c.fill()
    c.globalAlpha = alpha
    c.fillStyle = markColour
    c.font = `${l.title.weight} ${q.mark.px}px ${font}`
    c.textAlign = 'left'
    c.textBaseline = 'middle'
    c.fillText('\u201c', q.mark.x, q.mark.y + q.mark.px * 0.18 + rise)
    drawText(c, l, q.textX, q.textTop + rise, 'left', textColour, alpha, font, typed)
    c.restore()
  }
  const key = JSON.stringify(['quote', w, h, card.title, card.subtitle ?? '', panelColour, textColour, markColour, fontKey(font), l])
  // While a typewriter types, its lines are drawn as far as they are shown, not from the picture.
  const sprite = reveal?.lines ? null : spriteOf(key, q.panel, Math.ceil(q.mark.px * 0.5), (c) => paint(c, 1, 0))
  if (!sprite) {
    if (pose) ctx.save()
    applyPose(ctx, q.panel, pose, reveal)
    paint(ctx, phase.text, phase.rise * l.rise, reveal)
    if (pose) ctx.restore()
    return
  }
  ctx.save()
  applyPose(ctx, q.panel, pose, reveal)
  ctx.globalAlpha = phase.text
  drawSprite(ctx, sprite, phase.rise * l.rise)
  ctx.restore()
}

/**
 * The lower-third title cards' bands (output px, at rest) with their times: Captions Studio
 * captions keep clear of them (captions-studio.md §8.6).
 */
export function lowerThirdBoxes(ctx: Ctx, project: Project, w: number, h: number, area: Rect | null): { start: number; end: number; box: Rect }[] {
  const out: { start: number; end: number; box: Rect }[] = []
  for (const raw of project.titles ?? []) {
    if (raw.style !== 'lower-third') continue
    const card = drawnCard(project, raw)
    const font = cardFont(project, card)
    const band = layoutOf(ctx, card, w, h, font, area).band
    if (band) out.push({ start: card.start, end: card.end, box: { x: band.x, y: band.y, w: band.w, h: band.h } })
  }
  return out
}

