/**
 * A one-line snippet of a unit's text around its first matched word (docs/design/search.md §2.7):
 * plain text parts, matched words marked `hit`. Never HTML: the page renders the parts as text.
 */
import { SEARCH_LIMITS, type SnippetPart } from './types'

export type Range = readonly [number, number]

const ELLIPSIS = '…'

const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff
/** A flag is two regional indicators, paired from the start of their run. */
const isRegionalIndicator = (c: number | undefined): boolean => c !== undefined && c >= 0x1f1e6 && c <= 0x1f1ff
const MARK_RE = /\p{M}/u
/** Code units read on each side of a cut to find the character it falls in. */
const CUT_CONTEXT = 32
/** Characters nothing joins to the one before them (Han, kana, Thai consonants, ASCII): a cut before one needs no look. */
const STARTER_RE = /[\x21-\x7e\p{Script=Han}\u3041-\u3096\u30A1-\u30FA\u0E01-\u0E2E]/u
/** Wide characters (Chinese, Japanese, Korean, fullwidth forms): drawn about twice as wide as a Latin letter. */
const WIDE_RE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/

/**
 * How wide `text` from `start` to `end` is drawn, in Latin letters: a wide character counts two, as
 * does a character outside the BMP (an emoji, a rare Han character: two code units), anything else one.
 */
function widthOf(text: string, start: number, end: number): number {
  let width = 0
  for (let i = start; i < end; i++) width += WIDE_RE.test(text[i]) ? 2 : 1
  return width
}

/** Where the text before a match at `at` starts: as far back as fits `snippetBefore` Latin letters' width. */
function leadStart(text: string, lineStart: number, at: number): number {
  let i = at
  for (let width = 0; i > lineStart; i--) {
    width += WIDE_RE.test(text[i - 1]) ? 2 : 1
    if (width > SEARCH_LIMITS.snippetBefore) break
  }
  return i
}

let graphemes: Intl.Segmenter | null | undefined

function characterBreaker(): Intl.Segmenter | null {
  if (graphemes === undefined) {
    try {
      graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
    } catch {
      graphemes = null
    }
  }
  return graphemes
}

/**
 * `i` moved forward to where a whole character starts (at most `max`): a cut never parts a letter
 * from its marks (Thai vowels and tones), an emoji sequence or a surrogate pair.
 */
function characterStart(text: string, i: number, max: number): number {
  if (STARTER_RE.test(text[i] ?? '')) return i
  const breaker = characterBreaker()
  if (!breaker) {
    while (i < max && (isLowSurrogate(text.charCodeAt(i)) || MARK_RE.test(text[i]))) i++
    return i
  }
  let from = Math.max(0, i - CUT_CONTEXT)
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from--
  while (from >= 2 && isRegionalIndicator(text.codePointAt(from - 2))) from -= 2
  const end = Math.min(max, i + CUT_CONTEXT)
  for (const s of breaker.segment(text.slice(from, end))) if (from + s.index >= i) return from + s.index
  return end
}

/** Sorted, merged ranges inside 0..length. */
function mergeRanges(ranges: readonly Range[], length: number): [number, number][] {
  const sorted = ranges
    .map(([s, e]) => [Math.max(0, Math.min(s, length)), Math.max(0, Math.min(e, length))] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** Text from `from` to `to` cut into parts at the ranges. */
export function markRanges(text: string, ranges: readonly Range[], from = 0, to = text.length): SnippetPart[] {
  const parts: SnippetPart[] = []
  const push = (s: string, hit: boolean): void => {
    if (!s) return
    const last = parts[parts.length - 1]
    if (last && last.hit === hit) last.text += s
    else parts.push({ text: s, hit })
  }
  let at = from
  for (const [s, e] of mergeRanges(ranges, text.length)) {
    if (e <= from || s >= to) continue
    push(text.slice(at, Math.max(at, s)), false)
    push(text.slice(Math.max(at, s), Math.min(e, to)), true)
    at = Math.min(e, to)
  }
  push(text.slice(at, to), false)
  return parts
}

/** The snippet of `text` around the first of `ranges` (the whole start of the text when there is none). */
export function snippetOf(text: string, ranges: readonly Range[]): SnippetPart[] {
  const merged = mergeRanges(ranges, text.length)
  const first = merged[0] ?? [0, 0]
  // The line holding the first hit.
  const lineStart = text.lastIndexOf('\n', first[0] - 1) + 1
  const nl = text.indexOf('\n', first[1])
  const lineEnd = nl < 0 ? text.length : nl
  // The text before is measured by its width, so a match after Chinese or Japanese text is still in
  // the one line the row shows.
  let from = leadStart(text, lineStart, first[0])
  let to = Math.min(lineEnd, first[1] + SEARCH_LIMITS.snippetAfter)
  // Cut on a word boundary in the outer half of each side. No space there (Chinese, Japanese, Thai,
  // or one Latin word next to the match): cut between whole characters, keeping the text around it.
  if (from > lineStart) {
    const space = text.slice(from, first[0]).search(/\s/)
    if (space >= 0 && widthOf(text, from, from + space) < SEARCH_LIMITS.snippetBefore / 2) from += space + 1
    else from = characterStart(text, from, first[0])
  }
  if (to < lineEnd) {
    const space = text.slice(first[1], to).search(/\s\S*$/)
    if (space >= SEARCH_LIMITS.snippetAfter / 2) to = first[1] + space
    else to = characterStart(text, to, lineEnd)
  }
  const parts = markRanges(text, merged, from, to)
  const trimmed = parts.length ? parts : [{ text: '', hit: false }]
  // Spaces at the cut ends would sit next to the ellipsis.
  if (from > lineStart) trimmed.unshift({ text: ELLIPSIS, hit: false })
  if (to < lineEnd) trimmed.push({ text: ELLIPSIS, hit: false })
  return joinPlain(trimmed).map((p, i, all) => ({
    hit: p.hit,
    text: i === 0 && !p.hit ? p.text.trimStart() : i === all.length - 1 && !p.hit ? p.text.trimEnd() : p.text
  }))
}

/** Neighbouring plain parts joined into one. */
function joinPlain(parts: SnippetPart[]): SnippetPart[] {
  const out: SnippetPart[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (last && !last.hit && !p.hit) last.text += p.text
    else out.push({ ...p })
  }
  return out
}
