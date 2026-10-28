/**
 * Timing and text layout of captions (render/captionsLayer.ts draws them). Pure: text is measured
 * through a function the renderer passes, so line breaking, chunking and the karaoke word are
 * unit-tested here. Sizes are fractions of the frame and widths are measured at one reference
 * size and scaled (as shared/render/titleCards.ts does), so the preview and the export break
 * the same words onto the same lines.
 */
import type { Rect } from '../engine/layout'
import { clamp, easeOutCubic } from '../engine/math'
import { viewingTime } from '../render/overlays'
import { TEXT_INSET } from '../render/safeZones'
import type { CaptionSegment, CaptionSettings, Clip } from '../types'
import { captionLook, type CaptionLook } from './settings'

export const CAPTION_FONT = "'Segoe UI Variable Display', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"

/** Seconds (of viewing time) a caption takes to fade in and out. */
export const CAPTION_FADE = 0.12
/** Captions closer than this (viewing seconds) follow each other without fading out and in. */
export const CAPTION_JOIN = 0.25
/** Distance kept from the frame's sides and top/bottom, as a fraction of its shorter side. */
export const CAPTION_SAFE = 0.06
/** Widest a line may be, as a fraction of the frame's width. */
export const CAPTION_MAX_WIDTH = 0.84

/* ---------- which caption, which word ---------- */

/** Index of the caption showing at source time `t` (start inclusive, end exclusive), or -1. `segments` are sorted. */
export function captionIndexAt(segments: readonly CaptionSegment[], t: number): number {
  let lo = 0
  let hi = segments.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].start <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found >= 0 && t < segments[found].end ? found : -1
}

/** A word of a caption's text with its timing (source seconds). */
export interface CaptionToken {
  text: string
  start: number
  end: number
}

/**
 * The words of a caption with their times: the provider's word timings while the text still has
 * as many words as they do, else spread over the caption by length (after an edit, or when the
 * provider gave none).
 */
export function captionTokens(seg: Pick<CaptionSegment, 'start' | 'end' | 'text' | 'words'>): CaptionToken[] {
  const words = seg.text.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  if (seg.words && seg.words.length === words.length) {
    let at = seg.start
    return words.map((text, i) => {
      const w = seg.words![i]
      const start = clamp(Math.max(w.start, at), seg.start, seg.end)
      at = start
      return { text, start, end: clamp(Math.max(w.end, start), start, seg.end) }
    })
  }
  // Evenly by characters (a space counts as one), so long words take longer.
  const total = words.reduce((n, w) => n + w.length + 1, 0)
  const span = seg.end - seg.start
  let acc = 0
  return words.map((text) => {
    const start = seg.start + (acc / total) * span
    acc += text.length + 1
    return { text, start, end: seg.start + (acc / total) * span }
  })
}

/* ---------- fades ---------- */

/** Viewing (output) time at which source time `t` is on screen; source time itself without clips. */
const viewAt = (clips: Clip[], t: number): number => (clips.length ? viewingTime(clips, t) : t)

/**
 * Opacity of caption `i` at source time `t` (0..1): it fades in and out over CAPTION_FADE seconds
 * of viewing time measured from where it starts and stops showing (a cut or a speed change
 * neither jumps nor stretches the fade), at most a third of the caption, and not at all next to a
 * caption that follows within CAPTION_JOIN (no flicker between consecutive captions).
 */
export function captionAlpha(segments: readonly CaptionSegment[], i: number, t: number, clips: Clip[]): number {
  const seg = segments[i]
  if (!seg || !(t >= seg.start && t < seg.end)) return 0
  const from = viewAt(clips, seg.start)
  const to = viewAt(clips, seg.end)
  const now = viewAt(clips, t)
  const fade = Math.max(1e-3, Math.min(CAPTION_FADE, (to - from) / 3))
  const prev = segments[i - 1]
  const next = segments[i + 1]
  const joinedBefore = !!prev && from - viewAt(clips, prev.end) < CAPTION_JOIN
  const joinedAfter = !!next && viewAt(clips, next.start) - to < CAPTION_JOIN
  const inP = joinedBefore ? 1 : clamp((now - from) / fade, 0, 1)
  const outP = joinedAfter ? 1 : clamp((to - now) / fade, 0, 1)
  return easeOutCubic(Math.min(inP, outP))
}

/* ---------- text layout ---------- */

/** Width of `text` at `px` pixels in `weight` (the renderer measures with CAPTION_FONT). */
export type MeasureText = (text: string, px: number, weight: number) => number

export interface CaptionWordBox {
  /** Index into CaptionLayout.tokens (a word too long for a line is broken into pieces with the same index). */
  token: number
  text: string
  /** Left edge from the line's left edge, px. */
  x: number
  w: number
}

export interface CaptionLine {
  words: CaptionWordBox[]
  width: number
}

/** The lines shown together (at most maxLines), from `start` to `end` (source seconds). */
export interface CaptionChunk {
  start: number
  end: number
  lines: CaptionLine[]
  /** First and last token shown. */
  first: number
  last: number
  width: number
}

export interface CaptionLayout {
  look: CaptionLook
  tokens: CaptionToken[]
  chunks: CaptionChunk[]
  /** Text size and line height, px. */
  px: number
  lineHeight: number
  /** Padding of a 'box' background around each line, and its corner radius, px. */
  padX: number
  padY: number
  radius: number
  /** Right-to-left text (Arabic, Hebrew…): the words' x are mirrored, so a line reads from its right edge (a run of English words in it keeps its order). */
  rtl: boolean
}

interface Piece {
  token: number
  text: string
  w: number
  /** Share of its token's text before this piece (0 for a whole word). */
  at: number
}

/** Letters as the reader sees them: a base letter with its combining marks (Thai vowels, accents) is never cut. */
const graphemes: (text: string) => string[] =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? ((seg) => (text) => Array.from(seg.segment(text), (s) => s.segment))(new Intl.Segmenter(undefined, { granularity: 'grapheme' }))
    : (text) => Array.from(text)

/** Pieces of the caption's words: whole words, or letters of a word wider than a line (Chinese or Japanese text without spaces is one long word). */
function piecesOf(tokens: CaptionToken[], maxWidth: number, width: (s: string) => number): Piece[] {
  const out: Piece[] = []
  tokens.forEach((t, i) => {
    const w = width(t.text)
    if (w <= maxWidth) return void out.push({ token: i, text: t.text, w, at: 0 })
    let part = ''
    let before = 0
    for (const ch of graphemes(t.text)) {
      if (part && width(part + ch) > maxWidth) {
        out.push({ token: i, text: part, w: width(part), at: before / t.text.length })
        before += part.length
        part = ''
      }
      part += ch
    }
    if (part) out.push({ token: i, text: part, w: width(part), at: before / t.text.length })
  })
  return out
}

/** The first strong letter is from a right-to-left script (Hebrew, Arabic, Syriac, Thaana, N'Ko and their presentation forms). */
const RTL_FIRST = /^[^\p{L}]*[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u
/** A letter of those scripts. */
const RTL_LETTER = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u

type Dir = 'l' | 'r'

/**
 * The reading direction of each token, a word-level shortcut of the Unicode bidi algorithm (which
 * players apply to SRT/VTT): a word goes the way of its first letter; a number continues the word
 * before it ('Windows 11' in an Arabic caption, a count between Arabic words); anything else
 * without a letter (a dash, an emoji) goes the way of its neighbours when both agree, else the caption's.
 */
function tokenDirs(tokens: CaptionToken[], caption: Dir): Dir[] {
  const dirs = tokens.map((t): Dir | null => {
    const letter = /\p{L}/u.exec(t.text)
    return letter ? (RTL_LETTER.test(letter[0]) ? 'r' : 'l') : null
  })
  let before = caption
  tokens.forEach((t, i) => {
    const d = dirs[i]
    if (d) before = d
    else if (/\p{Nd}/u.test(t.text)) dirs[i] = before
  })
  return dirs.map((d, i) => {
    if (d) return d
    let a = i - 1
    while (a >= 0 && !dirs[a]) a--
    let b = i + 1
    while (b < dirs.length && !dirs[b]) b++
    const prev = a >= 0 ? dirs[a]! : caption
    const next = b < dirs.length ? dirs[b]! : caption
    return prev === next ? prev : caption
  })
}

/**
 * Puts the words of a line (x measured in reading order, the line `width` wide) where they show:
 * a right-to-left caption's line is mirrored, then each run of words read the other way (English
 * in an Arabic caption, Arabic in an English one) is mirrored within the room it takes, so the
 * run keeps its own order (in an Arabic caption, 'Visual Studio Code' still reads left to right).
 */
function displayOrder(words: CaptionWordBox[], width: number, dirs: Dir[], caption: Dir): void {
  if (caption === 'r') for (const wd of words) wd.x = width - wd.x - wd.w
  for (let s = 0; s < words.length; ) {
    if (dirs[words[s].token] === caption) {
      s++
      continue
    }
    let e = s + 1
    while (e < words.length && dirs[words[e].token] !== caption) e++
    // Words s..e-1 run the other way: mirror them between their outer edges.
    let lo = Infinity
    let hi = -Infinity
    for (let k = s; k < e; k++) {
      lo = Math.min(lo, words[k].x)
      hi = Math.max(hi, words[k].x + words[k].w)
    }
    for (let k = s; k < e; k++) words[k].x = lo + hi - words[k].x - words[k].w
    s = e
  }
}

/** Greedy line breaking of `pieces` into lines no wider than `maxWidth` (indices into `pieces`, [from, to)). */
function breakLines(pieces: Piece[], maxWidth: number, space: number): [number, number][] {
  const lines: [number, number][] = []
  let from = 0
  let w = 0
  for (let i = 0; i < pieces.length; i++) {
    const add = i === from ? pieces[i].w : w + space + pieces[i].w
    if (i > from && add > maxWidth) {
      lines.push([from, i])
      from = i
      w = pieces[i].w
    } else w = add
  }
  if (from < pieces.length) lines.push([from, pieces.length])
  return lines
}

const rangeWidth = (pieces: Piece[], from: number, to: number, space: number): number => {
  let w = 0
  for (let i = from; i < to; i++) w += pieces[i].w + (i > from ? space : 0)
  return w
}

/**
 * Two lines of a chunk evened out: the break that makes the wider line narrowest (a lone word on
 * the second line reads badly), the top line the shorter one on a tie.
 */
function balance(pieces: Piece[], from: number, to: number, maxWidth: number, space: number): [number, number][] {
  let best = -1
  let bestW = Infinity
  for (let k = from + 1; k < to; k++) {
    const a = rangeWidth(pieces, from, k, space)
    const b = rangeWidth(pieces, k, to, space)
    if (a > maxWidth || b > maxWidth) continue
    const m = Math.max(a, b)
    if (m < bestW - 1e-6 || (Math.abs(m - bestW) <= 1e-6 && a <= b)) {
      best = k
      bestW = m
    }
  }
  return best < 0 ? breakLines(pieces.slice(from, to), maxWidth, space).map(([a, b]) => [a + from, b + from]) : [[from, best], [best, to]]
}

/** Size of the caption text for `settings` in a `w` x `h` frame, and the widest a line may be (inside `area` when given). */
export function captionMetrics(
  settings: Pick<CaptionSettings, 'size' | 'preset' | 'background'>,
  w: number,
  h: number,
  /** The text area (safeZones.ts textArea, output px); absent or null: the whole frame, as always. */
  area?: Rect | null
): { px: number; lineHeight: number; maxWidth: number; padX: number; padY: number; safe: number } {
  const look = captionLook(settings.preset)
  const u = Math.min(w, h)
  const px = settings.size * look.scale * u
  const padX = settings.background === 'box' ? px * 0.42 : 0
  const padY = settings.background === 'box' ? px * 0.12 : 0
  const safe = CAPTION_SAFE * u
  const full = Math.min(w * CAPTION_MAX_WIDTH, w - safe * 2)
  // In a text area the lines, still centred on the frame, stay inside it on both sides.
  const room = area ? Math.min(full, 2 * Math.min(w / 2 - area.x, area.x + area.w - w / 2)) : full
  const maxWidth = Math.max(px * 2, room - padX * 2)
  return { px, lineHeight: px * look.lineHeight, maxWidth, padX, padY, safe }
}

/**
 * Lines of caption `seg` for `settings` in a `w` x `h` frame: its words broken into lines that fit
 * the safe width, grouped `maxLines` at a time into chunks shown one after the other (timed by
 * the words they start with), two-line chunks evened out.
 */
export function captionLayout(
  seg: Pick<CaptionSegment, 'start' | 'end' | 'text' | 'words'>,
  settings: Pick<CaptionSettings, 'size' | 'preset' | 'background' | 'maxLines'>,
  w: number,
  h: number,
  measure: MeasureText,
  /** The text area (safeZones.ts textArea, output px); absent or null: the whole frame, as always. */
  area?: Rect | null
): CaptionLayout {
  const look = captionLook(settings.preset)
  const m = captionMetrics(settings, w, h, area)
  const base = captionTokens(seg)
  const tokens = look.uppercase ? base.map((t) => ({ ...t, text: t.text.toLocaleUpperCase() })) : base
  const width = (s: string): number => measure(s, m.px, look.weight)
  const space = width(' ')
  const pieces = piecesOf(tokens, m.maxWidth, width)
  const lines = breakLines(pieces, m.maxWidth, space)
  const per = settings.maxLines === 1 ? 1 : 2
  const rtl = RTL_FIRST.test(seg.text)
  const dirs = tokenDirs(tokens, rtl ? 'r' : 'l')
  const chunks: CaptionChunk[] = []
  for (let c = 0; c < lines.length; c += per) {
    const group = lines.slice(c, c + per)
    const from = group[0][0]
    const to = group[group.length - 1][1]
    const ranges = group.length === 2 ? balance(pieces, from, to, m.maxWidth, space) : group
    const out: CaptionLine[] = ranges.map(([a, b]) => {
      const words: CaptionWordBox[] = []
      let x = 0
      for (let i = a; i < b; i++) {
        if (i > a) x += pieces[i - 1].token === pieces[i].token ? 0 : space
        words.push({ token: pieces[i].token, text: pieces[i].text, x, w: pieces[i].w })
        x += pieces[i].w
      }
      displayOrder(words, x, dirs, rtl ? 'r' : 'l')
      return { words, width: x }
    })
    // A chunk starting inside a word broken over lines starts that far into the word's time.
    const tk = tokens[pieces[from].token]
    const start = tk.start + pieces[from].at * (tk.end - tk.start)
    chunks.push({ start, end: 0, lines: out, first: pieces[from].token, last: pieces[to - 1].token, width: Math.max(...out.map((l) => l.width)) })
  }
  // Each chunk shows from its first word (the first from the caption's start) to the next chunk.
  chunks.forEach((ch, i) => {
    ch.start = i === 0 ? seg.start : Math.max(seg.start, ch.start)
  })
  // Chunks starting together (word timings that share a start) share the time up to the next one, so each shows.
  for (let i = 1; i < chunks.length; ) {
    const from = chunks[i - 1].start
    if (chunks[i].start > from) {
      i++
      continue
    }
    let j = i
    while (j < chunks.length && chunks[j].start <= from) j++
    const to = j < chunks.length ? chunks[j].start : seg.end
    for (let k = i; k < j; k++) chunks[k].start = from + ((k - i + 1) / (j - i + 1)) * (to - from)
    i = j
  }
  // Chunks whose first word was clamped to the caption's end (an end trim on the caption track, or
  // word timings later than the caption) would start as it ends: from the end back, each of them
  // starts at least minShow before the next, as far back as that crowds them.
  const minShow = Math.min(0.4, (seg.end - seg.start) / chunks.length)
  for (let i = chunks.length - 1; i > 0; i--) {
    const latest = (i + 1 < chunks.length ? chunks[i + 1].start : seg.end) - minShow
    if (chunks[i].start <= latest) break
    chunks[i].start = latest
  }
  chunks.forEach((ch, i) => {
    ch.end = i + 1 < chunks.length ? Math.max(ch.start, chunks[i + 1].start) : seg.end
  })
  return { look, tokens, chunks, px: m.px, lineHeight: m.lineHeight, padX: m.padX, padY: m.padY, radius: m.padX ? Math.min(m.px * 0.32, (m.lineHeight + m.padY * 2) / 2) : 0, rtl }
}

/** Index of the chunk showing at source time `t` (the last one whose start has passed), or -1 without chunks. */
export function chunkIndexAt(layout: Pick<CaptionLayout, 'chunks'>, t: number): number {
  const { chunks } = layout
  if (!chunks.length) return -1
  let i = 0
  while (i + 1 < chunks.length && chunks[i + 1].start <= t) i++
  return i
}

/**
 * The token being spoken at source time `t` within `chunk`: the last of its words that has
 * started (it stays lit until the next one starts), or -1 before the first.
 */
export function spokenToken(layout: Pick<CaptionLayout, 'tokens'>, chunk: Pick<CaptionChunk, 'first' | 'last'>, t: number): number {
  let spoken = -1
  for (let i = chunk.first; i <= chunk.last; i++) {
    if (layout.tokens[i].start <= t) spoken = i
    else break
  }
  return spoken
}

/* ---------- placement ---------- */

export interface PlacedLine {
  /** Left edge of the text and the middle of the line, px. */
  x: number
  y: number
  width: number
}

/**
 * Where the lines of `chunk` go in a `w` x `h` frame: centred, at the bottom, middle or top
 * inside the safe margins (the bottom a little higher, clear of video players' controls), or of
 * `area` when given (docs/design/vertical-video.md §6.3).
 */
export function placeChunk(
  layout: CaptionLayout,
  chunk: CaptionChunk,
  position: CaptionSettings['position'],
  w: number,
  h: number,
  /** The text area (safeZones.ts textArea, output px); absent or null: the whole frame, as always. */
  area?: Rect | null
): { lines: PlacedLine[]; top: number; height: number } {
  const u = Math.min(w, h)
  const rowH = layout.lineHeight + layout.padY * 2
  const height = chunk.lines.length * rowH
  const margin = CAPTION_SAFE * u
  const top = area ? areaTop(area, position, height, TEXT_INSET * u) : position === 'top' ? margin : position === 'middle' ? (h - height) / 2 : h - margin * 1.25 - height
  return {
    top,
    height,
    lines: chunk.lines.map((l, i) => ({ x: (w - l.width) / 2, y: top + rowH * (i + 0.5), width: l.width }))
  }
}

/** Top of `height` px of lines at `position` in a text area: `inset` from its top or bottom, or centred (the area keeps clear of the apps' controls already). */
function areaTop(area: Rect, position: CaptionSettings['position'], height: number, inset: number): number {
  if (position === 'top') return area.y + inset
  if (position === 'middle') return area.y + (area.h - height) / 2
  return area.y + area.h - inset - height
}
