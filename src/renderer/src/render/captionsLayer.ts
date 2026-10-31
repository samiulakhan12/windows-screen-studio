import { captionAlpha, captionIndexAt, captionLayout, CAPTION_FONT, chunkIndexAt, placeChunk, spokenToken, wordDirection, type CaptionChunk, type CaptionLayout, type MeasureText } from '../../../shared/captions/layout'
import { DEFAULT_CAPTIONS } from '../../../shared/captions/settings'
import { speakerCaption } from '../../../shared/captions/speakers'
import { luminance } from '../../../shared/editor/titles'
import type { Rect } from '../../../shared/engine/layout'
import type { CaptionSegment, CaptionSettings, Project } from '../../../shared/types'
import { fontGeneration, projectFontStack } from './fontLoader'
import type { FrameContext } from './frameContext'

type Ctx = CanvasRenderingContext2D

/* ---------- measuring and layout (cached: only a new caption, look or frame size lays out again) ---------- */

/** Text is measured once at this size and scaled, so every frame size breaks the same words. */
const MEASURE_PX = 100
const widths = new Map<string, number>()

/** The captions' font stack: their brand font, else the caption font. */
const captionFont = (project: Pick<Project, 'id' | 'fonts'>, settings: CaptionSettings): string => projectFontStack(project, settings.font, CAPTION_FONT)

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

interface CachedLayout {
  w: number
  h: number
  /** The text area it was laid out in (null: the whole frame). */
  area: Rect | null
  settings: CaptionSettings
  /** fontKey of the font it was measured with. */
  font: string
  layout: CaptionLayout
}

/** Captions are replaced (never changed in place) by an edit, so a caption object keeps its layout. */
const layouts = new WeakMap<CaptionSegment, CachedLayout>()
/** A number per caption object, for the sprite keys. */
const serials = new WeakMap<CaptionSegment, number>()
let nextSerial = 1

const sameLook = (a: CaptionSettings, b: CaptionSettings): boolean =>
  a === b || (a.size === b.size && a.preset === b.preset && a.background === b.background && a.maxLines === b.maxLines)

/** Whether two text areas are the same (null: none). */
const sameArea = (a: Rect | null, b: Rect | null): boolean => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)

/** A cache key part for a text area. */
const areaKey = (area: Rect | null): string => (area ? `${area.x},${area.y},${area.w},${area.h}` : '')

function layoutOf(ctx: Ctx, seg: CaptionSegment, settings: CaptionSettings, w: number, h: number, font: string, area: Rect | null): CaptionLayout {
  const hit = layouts.get(seg)
  if (hit && hit.w === w && hit.h === h && sameArea(hit.area, area) && hit.font === fontKey(font) && sameLook(hit.settings, settings)) return hit.layout
  ctx.save()
  const layout = captionLayout(seg, settings, w, h, measureOn(ctx, font), area)
  ctx.restore()
  layouts.set(seg, { w, h, area, settings, font: fontKey(font), layout })
  return layout
}

/* ---------- the lines as a picture (made once per chunk, spoken word, look and size) ---------- */

interface Sprite {
  canvas: HTMLCanvasElement
  x: number
  y: number
}

/**
 * A caption's chunk with its background, outline and shadow, drawn once on a canvas of its own;
 * every frame of it then copies it with its fade as the alpha (perf audit, wave-3 rules 4 and 6).
 * With karaoke there is one per spoken word, so the few most recent are kept and their canvases
 * reused: playing never allocates a canvas once a few exist.
 */
const MAX_SPRITES = 6
const sprites = new Map<string, Sprite>()

function spriteOf(key: string, box: { x: number; y: number; w: number; h: number }, paint: (c: Ctx) => void): Sprite | null {
  const hit = sprites.get(key)
  if (hit) {
    // The most recently used last: the oldest one goes first.
    sprites.delete(key)
    sprites.set(key, hit)
    return hit
  }
  if (typeof document === 'undefined') return null
  let canvas: HTMLCanvasElement
  if (sprites.size >= MAX_SPRITES) {
    const [oldest, gone] = sprites.entries().next().value!
    sprites.delete(oldest)
    canvas = gone.canvas
  } else canvas = document.createElement('canvas')
  const x = Math.floor(box.x)
  const y = Math.floor(box.y)
  // Setting the size clears a reused canvas.
  canvas.width = Math.max(1, Math.ceil(box.x + box.w) - x)
  canvas.height = Math.max(1, Math.ceil(box.y + box.h) - y)
  const c = canvas.getContext('2d')
  if (!c) return null
  c.translate(-x, -y)
  paint(c)
  const sprite = { canvas, x, y }
  sprites.set(key, sprite)
  return sprite
}

/* ---------- drawing ---------- */

/** Draws `chunk` of `layout` at its place, with token `spoken` lit (karaoke), at full opacity. */
function paintChunk(c: Ctx, layout: CaptionLayout, chunk: CaptionChunk, settings: CaptionSettings, spoken: number, w: number, h: number, fontStackOf: string, area: Rect | null): void {
  const { look, px, lineHeight, padX, padY, radius } = layout
  const placed = placeChunk(layout, chunk, settings.position, w, h, area)
  // Dark text gets a light box and outline, so it stays readable too.
  const darkText = luminance(settings.color) < 0.35
  const edge = darkText ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.82)'
  const font = `${look.weight} ${px}px ${fontStackOf}`
  c.save()
  c.font = font
  c.textAlign = 'left'
  // x is still each word's left edge; the direction (set per word) puts punctuation on the right side of an RTL word.
  c.textBaseline = 'middle'
  c.lineJoin = 'round'
  if (settings.background === 'box') {
    // One rounded box per line, like subtitles on TV; a small gap between lines.
    const gap = px * 0.08
    c.fillStyle = darkText ? 'rgba(255, 255, 255, 0.9)' : 'rgba(10, 10, 16, 0.68)'
    for (const l of placed.lines) {
      c.beginPath()
      c.roundRect(l.x - padX, l.y - lineHeight / 2 - padY + gap / 2, l.width + padX * 2, lineHeight + padY * 2 - gap, radius)
      c.fill()
    }
  }
  const karaokePill = settings.preset === 'karaoke'
  const words = chunk.lines.flatMap((line, i) => line.words.map((wd) => ({ ...wd, x: placed.lines[i].x + wd.x, y: placed.lines[i].y })))
  // The spoken word's pill (karaoke): behind the text, a little larger than the word.
  if (karaokePill && spoken >= 0) {
    c.fillStyle = settings.highlightColor
    for (const wd of words) {
      if (wd.token !== spoken) continue
      c.beginPath()
      c.roundRect(wd.x - px * 0.16, wd.y - px * 0.62, wd.w + px * 0.32, px * 1.24, px * 0.22)
      c.fill()
    }
  }
  // An outline keeps text without a box readable on any picture; the bold preset's is thick.
  const outline = look.outline > 0 ? look.outline : settings.background === 'box' ? 0 : settings.background === 'none' ? 0.08 : 0.05
  if (outline > 0) {
    c.strokeStyle = edge
    c.lineWidth = outline * px * 2
    for (const wd of words) {
      if (karaokePill && wd.token === spoken) continue
      c.direction = wordDirection(layout, wd.token)
      c.strokeText(wd.text, wd.x, wd.y)
    }
  }
  const shadow = settings.background === 'shadow' ? (darkText ? 'rgba(255, 255, 255, 0.6)' : 'rgba(0, 0, 0, 0.7)') : null
  if (shadow) {
    c.shadowBlur = px * 0.3
    c.shadowOffsetY = px * 0.05
  }
  for (const wd of words) {
    const lit = wd.token === spoken
    // On the pill the word is dark (or white on a dark pill) and needs no shadow.
    if (shadow) c.shadowColor = lit && karaokePill ? 'transparent' : shadow
    c.fillStyle = !lit ? settings.color : karaokePill ? (luminance(settings.highlightColor) > 0.5 ? '#0b0b10' : '#ffffff') : settings.highlightColor
    c.direction = wordDirection(layout, wd.token)
    c.fillText(wd.text, wd.x, wd.y)
  }
  c.restore()
}

/** Captions with the speaker's name first (Show speaker names), one object per caption so their layout stays cached. */
const withNames = new WeakMap<CaptionSegment, CaptionSegment>()
function named(seg: CaptionSegment): CaptionSegment {
  let out = withNames.get(seg)
  if (!out) withNames.set(seg, (out = speakerCaption(seg)))
  return out
}

interface Shown {
  /** The font stack the caption draws with. */
  font: string
  seg: CaptionSegment
  settings: CaptionSettings
  layout: CaptionLayout
  ci: number
  chunk: CaptionChunk
  alpha: number
  placed: ReturnType<typeof placeChunk>
}

/** The caption chunk on screen at source time `t` in a `w` x `h` frame (in `area` when given), or null when none shows. */
function shownAt(ctx: Ctx, project: Project, t: number, w: number, h: number, area: Rect | null): Shown | null {
  const segments = project.transcript?.segments
  if (!segments?.length) return null
  const settings = project.captions ?? DEFAULT_CAPTIONS
  if (!settings.show) return null
  const i = captionIndexAt(segments, t)
  if (i < 0) return null
  const alpha = captionAlpha(segments, i, t, project.clips)
  if (alpha <= 0.002) return null
  const seg = settings.showSpeaker ? named(segments[i]) : segments[i]
  const font = captionFont(project, settings)
  const layout = layoutOf(ctx, seg, settings, w, h, font, area)
  const ci = chunkIndexAt(layout, t)
  if (ci < 0) return null
  const chunk = layout.chunks[ci]
  return { font, seg, settings, layout, ci, chunk, alpha, placed: placeChunk(layout, chunk, settings.position, w, h, area) }
}

/**
 * Where the caption showing at source time `t` is (its lines with their box padding, px) and at
 * which edge, or null without one: the keystroke overlay keeps clear of it (textOverlays.ts).
 */
export function captionBlockAt(
  ctx: Ctx,
  project: Project,
  t: number,
  w: number,
  h: number,
  /** The text area (shared/render/safeZones.ts textArea); absent or null: the whole frame, as always. */
  area?: Rect | null
): { position: CaptionSettings['position']; top: number; bottom: number } | null {
  const shown = shownAt(ctx, project, t, w, h, area ?? null)
  if (!shown) return null
  const { placed, settings } = shown
  return { position: settings.position, top: placed.top, bottom: placed.top + placed.height }
}

/**
 * Captions of the transcript at fc.t, drawn over the finished frame (under title cards and the
 * watermark): the caption showing then, broken into lines that fit the safe area, a long one
 * shown chunk after chunk, the spoken word lit in the karaoke looks, fading in and out in
 * viewing time (shared/captions/layout.ts). Nothing at all without a transcript or with
 * captions hidden.
 */
export function drawCaptionsLayer(fc: FrameContext): void {
  const { ctx, w, h, textArea: area } = fc
  const shown = shownAt(ctx, fc.project, fc.t, w, h, area)
  if (!shown) return
  const { font, seg, settings, layout, ci, chunk, alpha, placed } = shown
  const spoken = layout.look.karaoke ? spokenToken(layout, chunk, fc.t) : -1
  let serial = serials.get(seg)
  if (serial === undefined) serials.set(seg, (serial = nextSerial++))
  const key = `${serial}|${ci}|${spoken}|${w}x${h}|${settings.preset}|${settings.position}|${settings.size}|${settings.color}|${settings.highlightColor}|${settings.background}|${settings.maxLines}|${fontKey(font)}|${areaKey(area)}`
  // Room for the box padding, the outline, the shadow and glyphs reaching past their line.
  const pad = Math.ceil(layout.px * 0.7 + layout.padX)
  const box = { x: Math.min(...placed.lines.map((l) => l.x)) - pad, y: placed.top - pad, w: chunk.width + pad * 2, h: placed.height + pad * 2 }
  ctx.save()
  ctx.globalAlpha = alpha
  const sprite = spriteOf(key, box, (c) => paintChunk(c, layout, chunk, settings, spoken, w, h, font, area))
  if (sprite) ctx.drawImage(sprite.canvas, sprite.x, sprite.y)
  else paintChunk(ctx, layout, chunk, settings, spoken, w, h, font, area)
  ctx.restore()
}
