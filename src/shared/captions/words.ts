/**
 * The words of a caption for Captions Studio (docs/design/captions-studio.md §8.1): one splitter
 * for layout, emphasis marks, word anchors and the AI `marks` task. Legacy looks keep
 * layout.ts captionTokens.
 *
 * The contracts step implements the splitter itself (studioWords, studioWordTexts), because the
 * project readers check marks and anchors with it (studioData.ts checkAnchor); part P1 implements
 * the rest of this file.
 */
import type { CaptionSegment } from '../types'
import type { CaptionToken } from './layout'

/** The script of a word (§6.6, §8.1). */
export type ScriptTag = 'latin' | 'cyrillic' | 'greek' | 'arabic' | 'hebrew' | 'devanagari' | 'bengali' | 'tamil' | 'telugu' | 'thai' | 'han' | 'kana' | 'hangul' | 'other'

/** A word of a caption with its time, as the Studio layout uses it (§8.1). */
export interface StudioToken extends CaptionToken {
  /** Index into studioWordTexts; -1 for NW-09 speaker labels (never lit, animated or marked). */
  word: number
  /** White space came before it in the text, so the layout puts a space before it. */
  gap: boolean
  /** Its time is spread over the caption, or the provider's word was estimated. */
  estimated?: true
  /** Its own reading direction (layout.ts tokenDirs). */
  dir: 'l' | 'r'
  script: ScriptTag
}

/** Letters of scripts written without spaces (§8.1 step 2). */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u
/** A segment with a letter, digit or mark: anything else is punctuation, a symbol or space. */
const WORDISH = /[\p{L}\p{N}\p{M}]/u

const hasSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
const graphemeSegmenter = hasSegmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const wordSegmenters = new Map<string, Intl.Segmenter>()

/** Number of graphemes (letters as the reader sees them) in `text`. */
function graphemeCount(text: string): number {
  if (!graphemeSegmenter) return Array.from(text).length
  let n = 0
  for (const _ of graphemeSegmenter.segment(text)) n++
  return n
}

function wordSegmenter(language: string | undefined): Intl.Segmenter | null {
  if (!hasSegmenter) return null
  const key = language ?? ''
  let s = wordSegmenters.get(key)
  if (!s) {
    try {
      s = new Intl.Segmenter(language || undefined, { granularity: 'word' })
    } catch {
      s = new Intl.Segmenter(undefined, { granularity: 'word' })
    }
    wordSegmenters.set(key, s)
  }
  return s
}

/** A piece without spaces split into words by the Segmenter; punctuation stays with the word before it (or, at the start, the word after). */
function splitPiece(piece: string, language: string | undefined): string[] {
  const seg = wordSegmenter(language)
  if (!seg) return [piece]
  const out: string[] = []
  let lead = ''
  for (const { segment } of seg.segment(piece)) {
    if (WORDISH.test(segment)) {
      out.push(lead + segment)
      lead = ''
    } else if (out.length) out[out.length - 1] += segment
    else lead += segment
  }
  if (lead) {
    if (out.length) out[out.length - 1] += lead
    else out.push(lead)
  }
  return out.length ? out : [piece]
}

/**
 * The words of `text` (§8.1): split on white space; a piece longer than 4 graphemes in a script
 * written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar) split with
 * Intl.Segmenter, punctuation staying with the word before it. `gap` says whether white space came
 * before the word (false for words split out of one piece, and for the first word).
 */
export function studioWords(text: string, language?: string): { text: string; gap: boolean }[] {
  const out: { text: string; gap: boolean }[] = []
  for (const piece of text.split(/\s+/)) {
    if (!piece) continue
    const parts = NO_SPACES.test(piece) && graphemeCount(piece) > 4 ? splitPiece(piece, language) : [piece]
    parts.forEach((p, i) => out.push({ text: p, gap: i === 0 && out.length > 0 }))
  }
  return out
}

/** The words of `text` as studioWords splits them: what mark and anchor indexes count. */
export function studioWordTexts(text: string, language?: string): string[] {
  return studioWords(text, language).map((w) => w.text)
}

const notImplemented = (name: string): never => {
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

/**
 * The words of a caption with their times (§8.1): the provider's word times when they match the
 * words, else mapped by concatenation (NW-09 text-only Chinese, Japanese, Thai), else spread by
 * graphemes + 1 and `estimated`. Speaker labels (withLabel) come first with word -1.
 */
export function studioTokens(seg: Pick<CaptionSegment, 'start' | 'end' | 'text' | 'words' | 'speaker'>, language?: string, withLabel?: boolean): StudioToken[] {
  void seg, language, withLabel
  return notImplemented('studioTokens')
}

/** The script of the first letter of `text` ('other' without one). */
export function scriptOf(text: string): ScriptTag {
  void text
  return notImplemented('scriptOf')
}

/** The script of at least half the letters of `text`, and its share (line height follows it, §6.6). */
export function mainScript(text: string): { script: ScriptTag; share: number } {
  void text
  return notImplemented('mainScript')
}

/** Every script with a letter in `texts`. */
export function scriptsIn(texts: Iterable<string>): Set<ScriptTag> {
  void texts
  return notImplemented('scriptsIn')
}

/** Whether a prefix of a word draws the same as in the whole word (Latin, Cyrillic, Greek, Han, Kana, Hangul; §9.3 typewriter). */
export function prefixDrawsSame(script: ScriptTag): boolean {
  void script
  return notImplemented('prefixDrawsSame')
}
