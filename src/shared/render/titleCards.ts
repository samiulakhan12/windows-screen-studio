/**
 * Timing and text layout of title cards (render/titleCardLayer.ts draws them). Pure: text is
 * measured through a function the renderer passes, so the wrapping is unit-tested here.
 * Every size is a fraction of the frame, and widths are measured at one reference size and
 * scaled, so the preview and the export wrap the same words onto the same lines.
 */
import type { Rect } from '../engine/layout'
import { clamp, easeOutCubic } from '../engine/math'
import { keptBounds, outputToSource } from '../engine/timeline'
import type { Clip, TitleCard, TitleCardStyle } from '../types'
import { viewingTime } from './overlays'

/** Seconds (of viewing time) a card takes to fade and rise in, and to fade out. */
export const TITLE_FADE = 0.35

export const TITLE_FONT = "'Segoe UI Variable Display', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"

export interface TitlePhase {
  /** Opacity of the card's background, 0..1. */
  background: number
  /** Opacity of its text (and of a lower third's band), 0..1. */
  text: number
  /** Vertical offset of the text, in units of the rise distance: 1 below its place, 0 in place, negative above. */
  rise: number
}

/** Viewing (output) time at which source time `t` is on screen; source time itself without clips. */
const viewAt = (clips: Clip[], t: number): number => (clips.length ? viewingTime(clips, t) : t)

/**
 * The card's fades in viewing time: when it starts and stops showing, and how long each fade
 * lasts (TITLE_FADE, at most half of what shows of the card).
 */
function titleTiming(card: Pick<TitleCard, 'start' | 'end'>, clips: Clip[]): { from: number; to: number; fade: number } {
  const from = viewAt(clips, card.start)
  const to = viewAt(clips, card.end)
  return { from, to, fade: Math.max(1e-3, Math.min(TITLE_FADE, (to - from) / 2)) }
}

/**
 * How far a card has faded in or out at source time `t`, or null when it is not shown. Fades last
 * TITLE_FADE seconds of viewing time, measured from where the card starts and stops showing (a
 * cut or a speed change inside a fade neither jumps nor stretches it), at most half the card. A
 * full-frame card that starts the video shows its background from the first frame (the text
 * still rises in), and one that ends the video stays until the last frame.
 */
export function titlePhase(card: Pick<TitleCard, 'start' | 'end' | 'style'>, t: number, clips: Clip[]): TitlePhase | null {
  if (!(t >= card.start && t < card.end)) return null
  const { from, to, fade } = titleTiming(card, clips)
  const now = viewAt(clips, t)
  const kept = clips.length ? keptBounds(clips) : { start: 0, end: Infinity }
  const fullFrame = card.style !== 'lower-third'
  const opensVideo = card.start <= kept.start + 1e-6
  const closesVideo = card.end >= kept.end - 1e-6
  const inP = clamp((now - from) / fade, 0, 1)
  const outP = closesVideo ? 1 : clamp((to - now) / fade, 0, 1)
  if (outP < inP) {
    // Fading out: the text drifts up a little as it goes.
    const a = easeOutCubic(outP)
    return { background: a, text: a, rise: -0.5 * (1 - a) }
  }
  const a = easeOutCubic(inP)
  return { background: fullFrame && opensVideo ? 1 : a, text: a, rise: 1 - a }
}

/**
 * Where a playhead at source time `t` goes to show `card` fully on the preview (past its fade-in,
 * before its fade-out, as titlePhase fades it): `t` itself when the frame shown there already
 * does, else just past the fade-in (the middle of a card too short to hold).
 */
export function titleShowTime(card: Pick<TitleCard, 'start' | 'end'>, t: number, clips: Clip[]): number {
  const { from, to, fade } = titleTiming(card, clips)
  const lo = from + fade + 0.01
  const hi = to - fade - 0.01
  const now = viewAt(clips, t)
  if (now >= lo && now <= hi) return t
  const at = lo <= hi ? lo : (from + to) / 2
  return clips.length ? outputToSource(clips, at).time : at
}

/* ---------- text layout ---------- */

/** Width of `text` at `px` pixels in `weight` (the renderer measures with the title font). */
export type MeasureText = (text: string, px: number, weight: number) => number

interface StyleMetrics {
  /** Title size, its smallest (when shrinking long text) and line height, as fractions of the frame's shorter side / of the size. */
  title: number
  titleMin: number
  titleLine: number
  titleWeight: number
  sub: number
  subMin: number
  subLine: number
  subWeight: number
  /** Most lines each gets before shrinking further. */
  titleLines: number
  subLines: number
  /** Space between title and subtitle, in title sizes. */
  gap: number
  /** Widest the text may be, as a fraction of the frame's width (full frame) or of the band's room. */
  maxWidth: number
  /** Tallest the text block may be, as a fraction of the frame's height. */
  maxHeight: number
}

const METRICS: Record<TitleCardStyle, StyleMetrics> = {
  centered: { title: 0.085, titleMin: 0.03, titleLine: 1.16, titleWeight: 700, sub: 0.038, subMin: 0.022, subLine: 1.35, subWeight: 500, titleLines: 3, subLines: 3, gap: 0.42, maxWidth: 0.78, maxHeight: 0.72 },
  big: { title: 0.165, titleMin: 0.05, titleLine: 1.04, titleWeight: 800, sub: 0.042, subMin: 0.022, subLine: 1.35, subWeight: 500, titleLines: 3, subLines: 2, gap: 0.3, maxWidth: 0.86, maxHeight: 0.8 },
  'lower-third': { title: 0.05, titleMin: 0.028, titleLine: 1.2, titleWeight: 700, sub: 0.03, subMin: 0.02, subLine: 1.3, subWeight: 500, titleLines: 2, subLines: 2, gap: 0.22, maxWidth: 0.62, maxHeight: 0.3 }
}

/** Distance from the frame's edges kept clear (title-safe area), as a fraction of the shorter side. */
export const TITLE_SAFE = 0.06

export interface TextBlock {
  lines: string[]
  /** Width of each line, px. */
  widths: number[]
  px: number
  lineHeight: number
  weight: number
}

export interface TitleLayout {
  title: TextBlock
  /** Null when the card has no subtitle. */
  subtitle: TextBlock | null
  /** Space between the two, px. */
  gap: number
  /** Size of the whole text block, px. */
  width: number
  height: number
  /** Lower third: the band around the text (output px, before the rise), its padding and accent bar. */
  band: { x: number; y: number; w: number; h: number; radius: number; padX: number; padY: number; accent: number } | null
  /** How far the text rises in (px). */
  rise: number
}

/**
 * Greedy word wrapping of `text` into lines no wider than `maxWidth` (`width(s)` measures a
 * string). Line breaks in the text are kept; a word wider than a line is broken between letters.
 */
export function wrapText(text: string, maxWidth: number, width: (s: string) => number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if (width(next) <= maxWidth) {
        line = next
        continue
      }
      if (line) out.push(line)
      line = ''
      if (width(word) <= maxWidth) {
        line = word
        continue
      }
      // A word longer than a whole line: as many letters per line as fit.
      let part = ''
      for (const ch of Array.from(word)) {
        if (part && width(part + ch) > maxWidth) {
          out.push(part)
          part = ''
        }
        part += ch
      }
      line = part
    }
    if (line) out.push(line)
  }
  // Blank lines at the ends take room and show nothing.
  while (out.length && !out[0]) out.shift()
  while (out.length && !out[out.length - 1]) out.pop()
  return out
}

/** `line` with an ellipsis at its end (more text follows), shortened until it fits `maxWidth`. */
function withEllipsis(line: string, maxWidth: number, width: (s: string) => number): string {
  const chars = Array.from(line.trimEnd())
  while (chars.length && width(`${chars.join('').trimEnd()}…`) > maxWidth) chars.pop()
  return `${chars.join('').trimEnd()}…`
}

/**
 * One block of text at the largest size from `px` down to `minPx` that wraps into `maxLines`
 * lines within `maxWidth`; at the smallest size, lines past the last are dropped and it ends
 * with an ellipsis.
 */
function fitBlock(text: string, px: number, minPx: number, maxLines: number, maxWidth: number, weight: number, line: number, measure: MeasureText): TextBlock {
  let size = px
  for (;;) {
    const width = (s: string): number => measure(s, size, weight)
    let lines = wrapText(text, maxWidth, width)
    const fits = lines.length <= maxLines
    if (fits || size <= minPx + 1e-9) {
      if (!fits) {
        lines = lines.slice(0, maxLines)
        lines[maxLines - 1] = withEllipsis(lines[maxLines - 1], maxWidth, width)
      }
      return { lines, widths: lines.map(width), px: size, lineHeight: size * line, weight }
    }
    size = Math.max(minPx, size * 0.9)
  }
}

const blockHeight = (b: TextBlock | null): number => (b ? b.lines.length * b.lineHeight : 0)
const blockWidth = (b: TextBlock | null): number => (b && b.widths.length ? Math.max(...b.widths) : 0)

/**
 * Where the text of `card` goes in a `w` x `h` frame: sizes relative to the frame, wrapped
 * within the title-safe area, and shrunk (title and subtitle together) until it fits. In a text
 * area (docs/design/vertical-video.md §6.3) a lower third's band keeps to it: its bottom at the
 * area's, its left at the area's (or the title-safe margin), no wider than the area.
 */
export function titleLayout(
  card: Pick<TitleCard, 'title' | 'subtitle' | 'style'>,
  w: number,
  h: number,
  measure: MeasureText,
  /** The text area (safeZones.ts textArea, output px) a lower third keeps to; absent or null: the whole frame, as always. */
  area?: Rect | null
): TitleLayout {
  const m = METRICS[card.style] ?? METRICS.centered
  const u = Math.min(w, h)
  const safe = TITLE_SAFE * u
  const lower = card.style === 'lower-third'
  // Centred and big cards wrap to the frame whatever the area.
  const inArea = lower && area ? area : null
  const left = inArea ? Math.max(safe, inArea.x) : safe
  // A lower third's text sits in a band with padding and an accent bar; the band stays in the safe area.
  const bandPad = (px: number): { x: number; y: number; accent: number } => ({ x: px * 0.62, y: px * 0.48, accent: Math.max(2, px * 0.09) })
  // On a tall (portrait) frame a lower third may use the whole width.
  const frameW = lower && w < h ? w - safe * 2 : Math.min(w * m.maxWidth, w - safe * 2)
  const roomW = inArea ? Math.min(frameW, inArea.x + inArea.w - left) : frameW
  const title = card.title.trim() ? card.title : ''
  const sub = card.subtitle?.trim() ? card.subtitle : ''

  let scale = 1
  let t: TextBlock
  let s: TextBlock | null
  for (let i = 0; ; i++) {
    const titlePx = m.title * u * scale
    const pad = bandPad(titlePx)
    const textW = lower ? roomW - pad.x * 2 - pad.accent * 2.4 : roomW
    t = fitBlock(title, titlePx, m.titleMin * u, m.titleLines, textW, m.titleWeight, m.titleLine, measure)
    s = sub ? fitBlock(sub, m.sub * u * scale, m.subMin * u, m.subLines, textW, m.subWeight, m.subLine, measure) : null
    const height = blockHeight(t) + (s && t.lines.length ? t.px * m.gap : 0) + blockHeight(s) + (lower ? pad.y * 2 : 0)
    if (height <= h * m.maxHeight || i >= 6) break
    scale *= Math.max(0.6, Math.sqrt((h * m.maxHeight) / height))
  }
  const gap = s && t.lines.length && s.lines.length ? t.px * m.gap : 0
  const width = Math.max(blockWidth(t), blockWidth(s))
  const height = blockHeight(t) + gap + blockHeight(s)
  let band: TitleLayout['band'] = null
  if (lower) {
    const pad = bandPad(t.lines.length ? t.px : (s?.px ?? m.title * u))
    const bw = width + pad.x * 2 + pad.accent * 2.4
    const bh = height + pad.y * 2
    band = { x: left, y: inArea ? inArea.y + inArea.h - bh : h - safe - bh, w: bw, h: bh, radius: Math.min(bh / 2, pad.y * 1.4), padX: pad.x, padY: pad.y, accent: pad.accent }
  }
  return { title: t, subtitle: s && s.lines.length ? s : null, gap, width, height, band, rise: (lower ? 0.018 : 0.028) * h }
}
