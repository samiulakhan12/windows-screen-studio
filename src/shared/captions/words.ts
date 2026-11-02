/**
 * The words of a caption for Captions Studio (docs/design/captions-studio.md §8.1): one splitter
 * for layout, emphasis marks, word anchors and the AI `marks` task. Legacy looks keep
 * layout.ts captionTokens.
 *
 * The splitter itself (studioWords, studioWordTexts) came with the contracts, because the project
 * readers check marks and anchors with it (studioData.ts checkAnchor). Also here: the words with
 * their times (studioTokens), the script of a word (scriptOf, mainScript, scriptsIn) and the
 * Digits choice of §0.2 (withDigits).
 */
import { clamp } from '../engine/math'
import type { CaptionSegment } from '../types'
import { RTL_FIRST, tokenDirs, type CaptionToken } from './layout'

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

/** Printable ASCII: one grapheme per character, Latin letters or none. */
const ASCII = /^[\x20-\x7e]*$/

/** Number of graphemes (letters as the reader sees them) in `text`. */
function graphemeCount(text: string): number {
  if (ASCII.test(text)) return text.length
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

/** Opening brackets and quotes (「 “ （) go with the word after them, never ending a word (§8.3). */
const OPENING = /^[\p{Ps}\p{Pi}]+$/u

/**
 * A piece without spaces split into words by the Segmenter; punctuation stays with the word before
 * it (or, at the start, the word after), opening brackets and quotes with the word after them.
 */
function splitPiece(piece: string, language: string | undefined): string[] {
  const seg = wordSegmenter(language)
  if (!seg) return [piece]
  const out: string[] = []
  let lead = ''
  for (const { segment } of seg.segment(piece)) {
    if (WORDISH.test(segment)) {
      out.push(lead + segment)
      lead = ''
    } else if (out.length && !lead && !OPENING.test(segment)) out[out.length - 1] += segment
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
 * Intl.Segmenter, punctuation staying with the word before it (opening brackets and quotes with the
 * word after them). `gap` says whether white space came
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

/* ---------- scripts ---------- */

/** The scripts the Studio tells apart, with their Unicode Script property (Common and Inherited letters have none). */
const SCRIPTS: readonly [ScriptTag, RegExp][] = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['tamil', /\p{Script=Tamil}/u],
  ['telugu', /\p{Script=Telugu}/u],
  ['thai', /\p{Script=Thai}/u],
  ['han', /\p{Script=Han}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['hangul', /\p{Script=Hangul}/u]
]
/** A character of some script: a letter, a mark or a digit outside Common and Inherited (Bengali ৩ is Bengali, 3 is not). */
const SCRIPTED = /[\p{L}\p{M}\p{Nd}]/u
const UNSCRIPTED = /[\p{Script=Common}\p{Script=Inherited}]/u

/** The script of one character, or null for one of no script (Latin digits, punctuation, emoji, marks that go with any letter). */
function charScript(ch: string): ScriptTag | null {
  if (!SCRIPTED.test(ch) || UNSCRIPTED.test(ch)) return null
  for (const [tag, re] of SCRIPTS) if (re.test(ch)) return tag
  return 'other'
}

/** The script of the first letter of `text` ('other' without one). Bengali digits count as Bengali; 0–9 have no script. */
export function scriptOf(text: string): ScriptTag {
  if (ASCII.test(text)) return /[A-Za-z]/.test(text) ? 'latin' : 'other'
  for (const ch of text) {
    const s = charScript(ch)
    if (s) return s
  }
  return 'other'
}

/** Letters of `text` per script. */
function scriptCounts(text: string): Map<ScriptTag, number> {
  const counts = new Map<ScriptTag, number>()
  if (ASCII.test(text)) {
    const n = text.match(/[A-Za-z]/g)?.length ?? 0
    if (n) counts.set('latin', n)
    return counts
  }
  for (const ch of text) {
    const s = charScript(ch)
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  return counts
}

/**
 * The script most of the letters of `text` are in, and its share of them (line height follows it
 * when the share is at least a half, §6.6). 'other' with share 0 without letters. A tie goes to
 * the script met first.
 */
export function mainScript(text: string): { script: ScriptTag; share: number } {
  const counts = scriptCounts(text)
  let total = 0
  let best: ScriptTag = 'other'
  let most = 0
  for (const [s, n] of counts) {
    total += n
    if (n > most) {
      best = s
      most = n
    }
  }
  return total ? { script: best, share: most / total } : { script: 'other', share: 0 }
}

/** Every script with a letter in `texts`. */
export function scriptsIn(texts: Iterable<string>): Set<ScriptTag> {
  const out = new Set<ScriptTag>()
  for (const text of texts) for (const s of scriptCounts(text).keys()) out.add(s)
  return out
}

/** Scripts where the first k letters of a word draw as they do in the whole word (no joining or reordering, §9.3 typewriter). */
const PREFIX_SAFE: ReadonlySet<ScriptTag> = new Set(['latin', 'cyrillic', 'greek', 'han', 'kana', 'hangul'])

/** Whether a prefix of a word draws the same as in the whole word (Latin, Cyrillic, Greek, Han, Kana, Hangul; §9.3 typewriter). */
export function prefixDrawsSame(script: ScriptTag): boolean {
  return PREFIX_SAFE.has(script)
}

/** Scripts without letter case: a look's capitals and lowercase do nothing to them (§6.6, §0.2). */
const CASELESS: ReadonlySet<ScriptTag> = new Set(['arabic', 'hebrew', 'devanagari', 'bengali', 'tamil', 'telugu', 'thai', 'han', 'kana', 'hangul'])

/** Whether `script` has capital letters. */
export const hasCase = (script: ScriptTag): boolean => !CASELESS.has(script)

/* ---------- digits (§0.2) ---------- */

/** The first digit (zero) of each numbering system the Digits choice uses. */
const ZEROS = { latn: 0x30, beng: 0x9e6, deva: 0x966, arab: 0x660, arabext: 0x6f0 } as const
type Numbering = keyof typeof ZEROS

/** A language's own digits (CLDR's native numbering): Bangla ০–৯, Devanagari ०–९, Arabic-Indic ٠–٩, Persian and Urdu ۰–۹; else 0–9. */
export function nativeNumbering(language: string | undefined): Numbering {
  const base = (language ?? '').toLowerCase().split(/[-_]/)[0]
  if (base === 'bn' || base === 'as') return 'beng'
  if (base === 'hi' || base === 'mr' || base === 'ne') return 'deva'
  if (base === 'ar') return 'arab'
  if (base === 'fa' || base === 'ur' || base === 'ps') return 'arabext'
  return 'latn'
}

/** Any digit of the systems above, with its value. */
const ANY_DIGIT = /[0-9\u09e6-\u09ef\u0966-\u096f\u0660-\u0669\u06f0-\u06f9]/g
const digitValue = (ch: string): number => {
  const c = ch.codePointAt(0)!
  for (const zero of Object.values(ZEROS)) if (c >= zero && c <= zero + 9) return c - zero
  return 0
}

/**
 * `text` with its digits in the Digits choice (§0.2): 'native' the language's own (Bangla ০–৯ in a
 * Bangla caption), 'western' 0–9; absent: as written. Digit for digit, so words and their indexes
 * never change. Used by counters and list numbers, and word by word by captions and chapter titles.
 */
export function withDigits(text: string, digits: 'native' | 'western' | undefined, language?: string): string {
  if (!digits) return text
  const zero = ZEROS[digits === 'western' ? 'latn' : nativeNumbering(language)]
  return text.replace(ANY_DIGIT, (ch) => String.fromCodePoint(zero + digitValue(ch)))
}

/** withDigits word by word, as captions write them: a Latin word keeps its own digits ("MP3", "1080p"). */
export function withWordDigits(text: string, digits: 'native' | 'western' | undefined, language?: string): string {
  if (!digits) return text
  return text.replace(/\S+/gu, (word) => (scriptOf(word) === 'latin' ? word : withDigits(word, digits, language)))
}

/** The Intl numbering system of a Digits choice for `language` (counters), or undefined for the locale's own. */
export function numberingFor(digits: 'native' | 'western' | undefined, language?: string): Numbering | undefined {
  return digits === 'western' ? 'latn' : digits === 'native' ? nativeNumbering(language) : undefined
}

/* ---------- the words with their times ---------- */

/** Graphemes of each word plus one, the weights times are spread by (§8.1 step 3). */
function spreadTimes(words: readonly string[], start: number, end: number): { start: number; end: number }[] {
  const weights = words.map((w) => graphemeCount(w) + 1)
  const total = weights.reduce((a, b) => a + b, 0) || 1
  const span = Math.max(0, end - start)
  let acc = 0
  return weights.map((n) => {
    const a = start + (acc / total) * span
    acc += n
    return { start: a, end: start + (acc / total) * span }
  })
}

/** Times taken from `src` (provider words) as captionTokens clamps them: never before the previous word, inside the caption. */
function clampedTimes(src: readonly { start: number; end: number }[], seg: { start: number; end: number }): { start: number; end: number }[] {
  let at = seg.start
  return src.map((w) => {
    const start = clamp(Math.max(w.start, at), seg.start, seg.end)
    at = start
    return { start, end: clamp(Math.max(w.end, start), start, seg.end) }
  })
}

/**
 * Studio words timed by provider words that split the same text differently (NW-09 text-only
 * Chinese, Japanese and Thai, joined without spaces): each word takes the start of the provider
 * word holding its first character and the end of the one holding its last. Null when the texts
 * joined without spaces differ.
 */
function timesByConcatenation(
  words: readonly string[],
  provider: readonly { text: string; start: number; end: number; estimated?: true }[]
): { start: number; end: number; estimated: boolean }[] | null {
  const strip = (s: string): string => s.replace(/\s+/g, '')
  if (words.map(strip).join('') !== provider.map((w) => strip(w.text)).join('')) return null
  // owner[k]: the provider word holding character k of the joined text.
  const owner: number[] = []
  provider.forEach((w, i) => {
    for (let k = 0; k < strip(w.text).length; k++) owner.push(i)
  })
  let at = 0
  return words.map((w) => {
    const n = strip(w).length
    if (!n) return { start: provider[owner[Math.min(at, owner.length - 1)]]?.start ?? 0, end: provider[owner[Math.min(at, owner.length - 1)]]?.start ?? 0, estimated: true }
    const a = owner[at]
    const b = owner[at + n - 1]
    at += n
    let estimated = false
    for (let i = a; i <= b; i++) if (provider[i].estimated) estimated = true
    return { start: provider[a].start, end: provider[b].end, estimated }
  })
}

type TokenSource = Pick<CaptionSegment, 'start' | 'end' | 'text' | 'words' | 'speaker'>

/**
 * The tokens last made for each caption, with what they were made from: every rule of Make my
 * captions great reads a caption's words (§9.8), and the layout reads them again. Callers never
 * change the list or its tokens.
 */
const tokensMade = new WeakMap<TokenSource, { text: string; start: number; end: number; words: TokenSource['words']; speaker: TokenSource['speaker']; language?: string; withLabel: boolean; tokens: StudioToken[] }>()

/**
 * The words of a caption with their times (§8.1): the provider's word times when they match the
 * words, else mapped by concatenation (NW-09 text-only Chinese, Japanese, Thai), else spread by
 * graphemes + 1 and `estimated`. Speaker labels (withLabel) come first with word -1. The list is
 * shared between calls for the same caption: callers never change it.
 */
export function studioTokens(seg: TokenSource, language?: string, withLabel?: boolean): StudioToken[] {
  const label = !!withLabel
  const hit = tokensMade.get(seg)
  if (hit && hit.text === seg.text && hit.start === seg.start && hit.end === seg.end && hit.words === seg.words && hit.speaker === seg.speaker && hit.language === language && hit.withLabel === label) return hit.tokens
  const tokens = makeStudioTokens(seg, language, label)
  tokensMade.set(seg, { text: seg.text, start: seg.start, end: seg.end, words: seg.words, speaker: seg.speaker, language, withLabel: label, tokens })
  return tokens
}

function makeStudioTokens(seg: TokenSource, language: string | undefined, withLabel: boolean): StudioToken[] {
  const words = studioWords(seg.text, language)
  if (!words.length) return []
  const texts = words.map((w) => w.text)
  const provider = seg.words ?? []
  let times: { start: number; end: number; estimated: boolean }[]
  if (provider.length === words.length) {
    const t = clampedTimes(provider, seg)
    times = t.map((x, i) => ({ ...x, estimated: !!provider[i].estimated }))
  } else {
    const joined = provider.length ? timesByConcatenation(texts, provider) : null
    if (joined) {
      const t = clampedTimes(joined, seg)
      times = t.map((x, i) => ({ ...x, estimated: joined[i].estimated }))
    } else times = spreadTimes(texts, seg.start, seg.end).map((x) => ({ ...x, estimated: true }))
  }
  const own: Omit<StudioToken, 'dir'>[] = words.map((w, i) => ({
    text: w.text,
    start: times[i].start,
    end: times[i].end,
    word: i,
    gap: w.gap,
    ...(times[i].estimated ? { estimated: true as const } : {}),
    script: scriptOf(w.text)
  }))
  const label: Omit<StudioToken, 'dir'>[] =
    withLabel && seg.speaker && seg.text.trim()
      ? `${seg.speaker}:`
          .split(/\s+/)
          .filter(Boolean)
          .map((text, i) => ({ text, start: seg.start, end: seg.start, label: true as const, word: -1, gap: i > 0, script: scriptOf(text) }))
      : []
  if (label.length) own[0] = { ...own[0], gap: true }
  const all = [...label, ...own]
  // The caption's own words decide its direction, not the speaker's name before them.
  const rtl = RTL_FIRST.test(texts.join(' '))
  const dirs = tokenDirs(all, rtl ? 'r' : 'l')
  return all.map((t, i) => ({ ...t, dir: dirs[i] }))
}
