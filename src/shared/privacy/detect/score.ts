/**
 * Hits, own spans and cover boxes (docs/design/auto-blur.md §6.1, §5.7). A hit's own spans are the
 * secret's own characters in each line, never padded: everything that finds the secret again is
 * built from them (finding 11). Its box is the own spans' box padded by max(3 px, 0.35 × line
 * height) vertically and max(that, one mean character width) horizontally, clipped to the frame and
 * never rounded past its edge (finding 22). Pure.
 */
import type { PrivateKind } from '../../types'
import type { Box, ReadLine, ReadVariant } from '../protocol'
import { cleanLine, rawSpan, type CleanLine } from './clean'
import type { NameMatcher } from './names'

/** One own span: characters [start, end) of variant `variant` of line `line` (indices into that variant's text). */
export interface HitSpan {
  line: number
  variant: number
  start: number
  end: number
}

export interface Hit {
  kind: PrivateKind
  /** The rule that found it ('github', 'card-luhn:visa', 'password-labelled', …). */
  rule: string
  score: number
  /** The own spans, one or more per line it covers (one per read of a line, after variants are joined). */
  spans: HitSpan[]
  /** The cover box: the own spans' box padded (§6.1), clipped to the frame; [x, y, w, h] in video pixels. */
  box: Box
  /** A PEM block's x-range: every line of the block is covered across it (§6.10). */
  block?: [number, number]
  /** Covers the area where the text may be because the reader did not return it (a PEM block without its END line, §6.10). */
  lost?: true
}

export interface DetectOptions {
  kinds: readonly PrivateKind[]
  /** Phone regions (ISO 3166-1 alpha-2): the PC's, the UI language's and up to 5 added (§6.8). */
  regions: readonly string[]
  names: NameMatcher
  frame: { width: number; height: number }
}

/** One read of one line, as the rules see it. */
export interface DetectLine {
  /** The line's index in the read's lines. */
  index: number
  /** The variant's index in the line's variants. */
  variant: number
  raw: string
  clean: CleanLine
  box: Box
  /** Each raw character's x-range: [x0, x1] at 2i and 2i + 1. */
  chars: Float64Array
  conf: number
  /** The mean width of a character. */
  charWidth: number
}

/** What the line rules know about a line's surroundings (§6.10). */
export interface LineContext {
  line: DetectLine
  /** The short label line above in the same column, cleaned, and the one above it. */
  above: CleanLine | null
  above2: CleanLine | null
  /** The boxes to the left on the same row, cleaned, nearest last. */
  left: CleanLine[]
  /** The line lies in a recovery-codes block (§6.7). */
  recovery: boolean
  regions: readonly string[]
  kinds: ReadonlySet<PrivateKind>
  names: NameMatcher
  /** The hits already made on this read of the line (rules skip what another already took). */
  found: Hit[]
  /** Where the window the rules read starts in the line's cleaned text (§10.3). */
  offset: number
  frame: { width: number; height: number }
}

/** A line's surroundings in the frame (§6.10). */
export interface FrameContext {
  frame: { width: number; height: number }
  regions: readonly string[]
  kinds: ReadonlySet<PrivateKind>
  names: NameMatcher
  /** The line above in the same column, the line below, and the boxes to the left on the row (nearest last), by line index. */
  above: (number | null)[]
  below: (number | null)[]
  left: number[][]
  recovery: boolean[]
  /** The index of the variant each line is read by for its surroundings (the most confident). */
  best: number[]
}

/** The line's height. */
export const heightOf = (box: Box): number => Math.max(1, box[3])

/** Each raw character's x-range, from the variant's spans, or shared out over the box when they are missing. */
export function charRanges(line: ReadLine, v: ReadVariant): Float64Array {
  const n = v.text.length
  const out = new Float64Array(n * 2)
  if (v.spans.length === n) {
    for (let i = 0; i < n; i++) {
      out[2 * i] = v.spans[i][0]
      out[2 * i + 1] = v.spans[i][1]
    }
    return out
  }
  const [x, , w] = line.box
  for (let i = 0; i < n; i++) {
    out[2 * i] = x + (w * i) / Math.max(1, n)
    out[2 * i + 1] = x + (w * (i + 1)) / Math.max(1, n)
  }
  return out
}

/** One read of one line, cleaned, with its character ranges. */
export function detectLineOf(line: ReadLine, index: number, variant: number): DetectLine {
  const v = line.variants[variant]
  const chars = charRanges(line, v)
  return { index, variant, raw: v.text, clean: cleanLine(v.text), box: line.box, chars, conf: v.conf, charWidth: meanCharWidth(chars, line.box) }
}

/**
 * A line's mean character width: the mean width of its inner characters (the first and last reach
 * into the detector's margin around the text), or the box shared out when it has three or fewer.
 */
export function meanCharWidth(chars: Float64Array, box: Box): number {
  const n = chars.length / 2
  if (n <= 3) return Math.max(1, n ? (chars[2 * n - 1] - chars[0]) / n : box[2])
  const w: number[] = []
  for (let i = 1; i < n - 1; i++) w.push(chars[2 * i + 1] - chars[2 * i])
  w.sort((a, b) => a - b)
  return Math.max(1, w[w.length >> 1])
}

/** The x-range of raw characters [start, end) of a line. */
export function xRange(line: DetectLine, start: number, end: number): [number, number] {
  const n = line.raw.length
  if (!n) return [line.box[0], line.box[0] + line.box[2]]
  const s = Math.max(0, Math.min(n - 1, start))
  const e = Math.max(s + 1, Math.min(n, end))
  return [line.chars[2 * s], line.chars[2 * e - 1]]
}

/** The padding of a line (§6.1): vertical, and horizontal (at least one mean character width). */
export function padOf(line: Pick<DetectLine, 'box' | 'charWidth'>): { v: number; h: number } {
  const v = Math.max(3, 0.35 * heightOf(line.box))
  return { v, h: Math.max(v, line.charWidth) }
}

/** A box [x0, y0, x1, y1] as [x, y, w, h], clipped to the frame and never past its edge (finding 22); the scan rounds it outward when it writes a path. */
export function clipBox(x0: number, y0: number, x1: number, y1: number, frame: { width: number; height: number }): Box {
  const a = Math.min(frame.width, Math.max(0, x0))
  const b = Math.min(frame.height, Math.max(0, y0))
  const c = Math.max(a, Math.min(frame.width, x1))
  const d = Math.max(b, Math.min(frame.height, y1))
  const r = (v: number): number => Math.round(v * 100) / 100
  return [r(a), r(b), r(c) - r(a), r(d) - r(b)]
}

/** The cover box of own spans (§6.1), with a block's x-range when it has one. */
export function coverBox(spans: readonly HitSpan[], lineOf: (span: HitSpan) => DetectLine | undefined, frame: { width: number; height: number }, block?: [number, number]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of spans) {
    const line = lineOf(s)
    if (!line) continue
    const [a, b] = xRange(line, s.start, s.end)
    const pad = padOf(line)
    const lead = line.raw.length - line.raw.trimStart().length
    const tail = line.raw.trimEnd().length
    const padL = s.start <= lead ? pad.h : pad.v
    const padR = s.end >= tail ? pad.h : pad.v
    x0 = Math.min(x0, a - padL, block ? block[0] - pad.h : Infinity)
    x1 = Math.max(x1, b + padR, block ? block[1] + pad.h : -Infinity)
    y0 = Math.min(y0, line.box[1] - pad.v)
    y1 = Math.max(y1, line.box[1] + line.box[3] + pad.v)
  }
  if (!Number.isFinite(x0)) return [0, 0, 0, 0]
  return clipBox(x0, y0, x1, y1, frame)
}

/** A hit on one line from cleaned indices [s, e) of the line's text (the context's window offset added). */
export function lineHit(ctx: Pick<LineContext, 'line' | 'offset' | 'frame'>, kind: PrivateKind, rule: string, s: number, e: number, score: number): Hit {
  const line = ctx.line
  const [start, end] = rawSpan(line.clean, s + ctx.offset, e + ctx.offset)
  const spans = [{ line: line.index, variant: line.variant, start, end }]
  return { kind, rule, score: Math.min(0.99, Math.round(score * 100) / 100), spans, box: coverBox(spans, () => line, ctx.frame) }
}

/** Whether a hit already holds the cleaned position `s` of the context's line (window offset added). */
export function taken(ctx: Pick<LineContext, 'line' | 'offset' | 'found'>, s: number): boolean {
  const raw = ctx.line.clean.map[Math.min(ctx.line.clean.text.length, s + ctx.offset)]
  return ctx.found.some((h) => h.spans.some((sp) => sp.line === ctx.line.index && sp.variant === ctx.line.variant && sp.start <= raw && sp.end > raw))
}
