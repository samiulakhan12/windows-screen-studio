/**
 * Word times for transcription answers that have none (docs/design/transcription.md §3): OpenAI's
 * models after whisper-1 return text only. A part is short (30 s, cut in pauses), and its words
 * are spread over the stretches of it that have sound, by length, so no word starts in a pause.
 * Every such word is `estimated`. Also the check of word times a provider wrote itself (Gemini,
 * §4): impossible ones are replaced by the same kind of estimate. Pure.
 */
import type { Range } from '../audio/activity'
import type { AiProviderKind } from '../types'
import type { RawSegment, RawWord } from './transcriptParse'

/** Longest part sent to a provider that returns text only, seconds. */
export const TEXT_PART_SECONDS = 30
/** Stretches of sound shorter than this are left out (a sliver at a part's edge would squeeze a word to nothing), seconds. */
const MIN_STRETCH = 0.12
/** Less sound than this in a part, seconds: the whole part counts as sound. */
const MIN_ACTIVE = 0.2
/** A word is not stretched over a pause longer than this, seconds. */
const MAX_WORD_GAP = 0.25
/** A caption is ended at a sentence end once it has this many words. */
const SENTENCE_MIN_WORDS = 3
const MAX_CAPTION_WORDS = 12
const MAX_CAPTION_SECONDS = 6
/** A pause at least this long before a word starts a new caption, seconds. */
const CAPTION_PAUSE = 0.7
const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/u
/** Scripts written without spaces between words (Chinese, Japanese, Thai…): cut into words by Intl.Segmenter. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u
/** Opening brackets and quotes go with the word after them. */
const OPENING = /^[\p{Ps}\p{Pi}]+$/u

const EPS = 1e-9
const round = (t: number): number => Math.round(t * 1000) / 1000
const weight = (text: string): number => Math.max(1, [...text].length) + 1

/** Whether an OpenAI transcription model returns text only (every model after whisper-1). */
export const isTextOnlyOpenAiModel = (model: string): boolean => !/^whisper/i.test(model.trim())

/** Whether a provider's transcription model gives word times ('words') or text only ('text'). */
export function providerTiming(kind: AiProviderKind | 'local', model: string | undefined): 'words' | 'text' {
  return kind === 'openai' && isTextOnlyOpenAiModel(model ?? '') ? 'text' : 'words'
}

/** The parts of `active` inside [start, end), shifted to the part's own clock (0 = start). */
export function activeIn(active: readonly Range[], start: number, end: number): Range[] {
  const out: Range[] = []
  for (const r of active) {
    const a = Math.max(r.start, start)
    const b = Math.min(r.end, end)
    if (b > a) out.push({ start: a - start, end: b - start })
  }
  return out.sort((x, y) => x.start - y.start)
}

let wordSegmenter: Intl.Segmenter | null | undefined

/** One word of a text answer; `joined` when no space comes before it (inside a run of Chinese, Japanese, Thai…). */
interface Piece {
  text: string
  joined: boolean
}

/**
 * The words of a text answer: split on whitespace, and runs in a script written without spaces cut
 * into words (punctuation stays with the word before it, an opening bracket or quote with the
 * word after it), so the caption rules below see sentence ends and word counts in those too.
 */
function textPieces(text: string): Piece[] {
  if (wordSegmenter === undefined) {
    try {
      wordSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
    } catch {
      wordSegmenter = null
    }
  }
  const out: Piece[] = []
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (!wordSegmenter || !UNSPACED.test(token)) {
      out.push({ text: token, joined: false })
      continue
    }
    const first = out.length
    let lead = ''
    for (const s of wordSegmenter.segment(token)) {
      if (s.isWordLike) {
        out.push({ text: lead + s.segment, joined: out.length > first })
        lead = ''
      } else if (out.length > first && !lead && !OPENING.test(s.segment)) out[out.length - 1].text += s.segment
      else lead += s.segment
    }
    if (lead && out.length > first) out[out.length - 1].text += lead
    else if (lead) out.push({ text: lead, joined: false })
  }
  return out
}

/** `texts` spread between `start` and `end` by length, all estimated. */
export function spreadWords(texts: readonly string[], start: number, end: number): RawWord[] {
  return spreadOver(texts, [{ start, end: Math.max(start, end) }])
}

/**
 * `texts` spread over `ranges` (sorted, separate) laid end to end, each word taking the share its
 * length gives; a word that would straddle a pause longer than MAX_WORD_GAP starts after it.
 */
function spreadOver(texts: readonly string[], ranges: readonly Range[]): RawWord[] {
  if (!texts.length) return []
  const total = ranges.reduce((n, r) => n + (r.end - r.start), 0)
  const weights = texts.map(weight)
  const sum = weights.reduce((n, w) => n + w, 0)
  // Speaking time `x` (0..total) back to the part's clock; `late` takes the next range at a boundary.
  const at = (x: number, late: boolean): { t: number; range: number } => {
    let left = x
    for (let i = 0; i < ranges.length; i++) {
      const len = ranges[i].end - ranges[i].start
      if ((late ? left < len - EPS : left <= len + EPS) || i === ranges.length - 1) return { t: ranges[i].start + Math.min(Math.max(0, left), len), range: i }
      left -= len
    }
    return { t: ranges[ranges.length - 1]?.end ?? 0, range: Math.max(0, ranges.length - 1) }
  }
  const out: RawWord[] = []
  let acc = 0
  for (let i = 0; i < texts.length; i++) {
    const a = at((acc / sum) * total, true)
    acc += weights[i]
    const b = at((acc / sum) * total, false)
    let start = a.t
    let end = Math.max(start, b.t)
    // Across a pause: the word goes where most of its share is, before or after it.
    if (b.range !== a.range && ranges[b.range].start - ranges[a.range].end > MAX_WORD_GAP) {
      if (ranges[a.range].end - a.t >= b.t - ranges[b.range].start) end = ranges[a.range].end
      else start = ranges[b.range].start
    }
    out.push({ text: texts[i], start: round(start), end: round(end), estimated: true })
  }
  return out
}

/**
 * The captions of a part's text answer (`text`, the part `partSeconds` long, `active` its stretches
 * with sound on its own clock): its words spread over the sound and grouped into captions at
 * sentence ends (from SENTENCE_MIN_WORDS words), after MAX_CAPTION_WORDS words, before a pause of
 * CAPTION_PAUSE or at MAX_CAPTION_SECONDS. Times on the part's clock; every word estimated.
 */
export function timeTextPart(text: string, active: readonly Range[], partSeconds: number): RawSegment[] {
  const pieces = textPieces(text)
  if (!pieces.length || !(partSeconds > 0)) return []
  const clipped = activeIn(active, 0, partSeconds).filter((r) => r.end - r.start >= MIN_STRETCH)
  const voiced = clipped.reduce((n, r) => n + (r.end - r.start), 0)
  const words = spreadOver(
    pieces.map((p) => p.text),
    voiced >= MIN_ACTIVE ? clipped : [{ start: 0, end: partSeconds }]
  )
  const joined = new Set(words.filter((_, i) => pieces[i].joined))
  const segments: RawSegment[] = []
  let group: RawWord[] = []
  const flush = (): void => {
    if (!group.length) return
    const text = group.map((w, k) => (k && !joined.has(w) ? ' ' : '') + w.text).join('')
    segments.push({ start: group[0].start, end: Math.max(group[0].start, group[group.length - 1].end), text, words: group })
    group = []
  }
  for (const w of words) {
    if (group.length) {
      const last = group[group.length - 1]
      const tooLong = w.end - group[0].start > MAX_CAPTION_SECONDS
      if (w.start - last.end >= CAPTION_PAUSE || tooLong) flush()
    }
    group.push(w)
    if (group.length >= MAX_CAPTION_WORDS || (group.length >= SENTENCE_MIN_WORDS && SENTENCE_END.test(w.text))) flush()
  }
  flush()
  return segments
}

/**
 * A provider-timed segment with its words kept when they are plausible (docs/design/transcription.md
 * §4): in order (starts never go back by more than 0.05 s), at most a quarter without length, over
 * at least 30 % of a segment longer than 1 s, and at least half as many as the words of the text.
 * Otherwise the words are spread over the segment by length and marked estimated.
 */
export function checkWordTimes(seg: RawSegment): RawSegment {
  const words = seg.words
  if (!words?.length) return seg
  const count = seg.text.split(/\s+/).filter(Boolean).length
  let ordered = true
  for (let i = 1; i < words.length; i++) if (words[i].start < words[i - 1].start - 0.05) ordered = false
  const flat = words.filter((w) => w.end - w.start < 0.01).length
  const span = seg.end - seg.start
  const reach = Math.max(...words.map((w) => w.end)) - Math.min(...words.map((w) => w.start))
  const ok = ordered && flat <= words.length / 4 && (span <= 1 || reach >= span * 0.3) && words.length * 2 >= count
  if (ok) return seg
  return { ...seg, words: spreadWords(seg.text.split(/\s+/).filter(Boolean), seg.start, seg.end) }
}

/** What the Captions and Transcript tabs say about estimated word times (§3.5). */
export const TIMING_COPY = {
  formHint: (model: string): string =>
    `OpenAI's ${model} gives text without timings. Flown estimates when each word is spoken from the sound. For exact word times, make captions On this PC.`,
  useLocal: 'Use On this PC',
  summary: 'Word times are estimated: karaoke and cuts by word may be a little early or late. Captions On this PC have exact word times.',
  transcriptAll: 'Words with a dotted line have estimated times.',
  wordTitle: 'Estimated time'
} as const

/** Share of a transcript's timed words that are estimated (0 without words). */
export function estimatedShare(segments: readonly { words?: readonly { estimated?: true }[] }[]): number {
  let all = 0
  let guessed = 0
  for (const s of segments) {
    for (const w of s.words ?? []) {
      all++
      if (w.estimated) guessed++
    }
  }
  return all ? guessed / all : 0
}
