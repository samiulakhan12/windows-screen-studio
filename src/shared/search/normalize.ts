/**
 * How text becomes search terms (docs/design/search.md §2.3): the same steps for what is indexed
 * and for what is typed, so they always agree. No stemming (§2.4).
 */
import { SEARCH_LIMITS } from './types'

/** A term and where it came from in the original text (UTF-16 offsets, end exclusive). */
export interface Token {
  term: string
  start: number
  end: number
}

/** A run of word characters in the original text: letters, marks, digits, the joiners Indic text uses, and apostrophes inside. */
const WORD_CHARS = '\\p{L}\\p{M}\\p{N}\\u200C\\u200D\\u00AD'
const RUN_RE = new RegExp(`[${WORD_CHARS}]+(?:['’ʼ][${WORD_CHARS}]+)*`, 'gu')
/** After normalising, terms are split again on anything that is not a letter, mark or digit (NFKC can make some, e.g. ½ → 1⁄2). */
const TERM_RE = /[\p{L}\p{M}\p{N}]+/gu
/** Joiners and soft hyphens, typed inconsistently in Bangla and Hindi; apostrophes inside a word. */
const DROPPED_RE = /[‌‍­'’ʼ]/gu
/** Scripts whose accents are removed (café = cafe). Indic vowel signs are marks too, but letters there: kept. */
const ACCENTED_RE = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u
const MARK_RE = /\p{M}/u
const ASCII_RE = /^[\x00-\x7f]*$/
/** Scripts written without spaces between words: split by the system's word breaker. */
const UNSPACED_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

let segmenter: Intl.Segmenter | null | undefined

function wordBreaker(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
    } catch {
      segmenter = null
    }
  }
  return segmenter
}

/** Removes combining marks that follow a Latin, Greek or Cyrillic letter (the text is decomposed). */
function stripAccents(s: string): string {
  const decomposed = s.normalize('NFD')
  if (!MARK_RE.test(decomposed)) return s
  let out = ''
  let base = ''
  for (const ch of decomposed) {
    if (MARK_RE.test(ch)) {
      if (ACCENTED_RE.test(base)) continue
    } else {
      base = ch
    }
    out += ch
  }
  return out.normalize('NFC')
}

/** NFKC, lowercase, no joiners or apostrophes, no Latin/Greek/Cyrillic accents. */
export function normalizeText(s: string): string {
  // Plain ASCII (most English words) needs none of the Unicode steps.
  if (ASCII_RE.test(s)) return s.toLowerCase().replace(DROPPED_RE, '')
  return stripAccents(s.normalize('NFKC').toLowerCase().replace(DROPPED_RE, ''))
}

/** At most `max` code points of `s`. */
function capCodePoints(s: string, max: number): string {
  let n = 0
  let i = 0
  for (const ch of s) {
    if (n === max) return s.slice(0, i)
    n++
    i += ch.length
  }
  return s
}

/** The terms of one piece of original text (start..end of the whole text). */
function pushTerms(out: Token[], piece: string, start: number, end: number): void {
  for (const m of normalizeText(piece).matchAll(TERM_RE)) {
    out.push({ term: capCodePoints(m[0], SEARCH_LIMITS.termCodePoints), start, end })
  }
}

/** The terms of `text`, in order, each with the range of the original text it came from. */
export function tokenize(text: string): Token[] {
  const out: Token[] = []
  if (typeof text !== 'string' || !text) return out
  for (const run of text.matchAll(RUN_RE)) {
    const start = run.index ?? 0
    const word = run[0]
    const breaker = UNSPACED_RE.test(word) ? wordBreaker() : null
    if (!breaker) {
      pushTerms(out, word, start, start + word.length)
      continue
    }
    for (const seg of breaker.segment(word)) {
      if (!seg.isWordLike) continue
      pushTerms(out, seg.segment, start + seg.index, start + seg.index + seg.segment.length)
    }
  }
  return out
}

/** The terms of a query: capped in length and number, each once, in the order typed. */
export function queryTerms(query: string): string[] {
  if (typeof query !== 'string') return []
  const seen = new Set<string>()
  for (const t of tokenize(query.slice(0, SEARCH_LIMITS.queryChars))) {
    if (seen.size === SEARCH_LIMITS.queryTerms) break
    seen.add(t.term)
  }
  return [...seen]
}

/** Number of code points of `s`. */
export function codePoints(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

/** Only digits (no typo matching: 2024 is not 2025). */
export const isNumeric = (term: string): boolean => /^\p{N}+$/u.test(term)
