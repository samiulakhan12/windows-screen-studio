/**
 * Retakes (NW-01, docs/design/edit-by-text.md §4.6): a sentence started or said again, where the
 * last take is kept, and short stutters ("the the", "I think I think"). Found by comparing the
 * transcript's words, on this PC, with no AI call; every match is only a suggestion.
 */
import { fillerLanguage, isFiller } from './fillers'
import { lcsPairs, normalizeWord, type TranscriptWord, type WordSpan } from './transcript'

/** A pause (seconds) that ends a sentence. */
export const SENTENCE_PAUSE = 0.8
/** At a caption's end, a shorter pause is enough. */
const CAPTION_END_PAUSE = 0.3
/** The later take starts at most this long (seconds) after the earlier one ends. */
export const RETAKE_WINDOW = 15
/** Share of the earlier take's words the later one says again, in order. */
export const RETAKE_OVERLAP = 0.75
/** Longest sentence (tokens) compared. */
const MAX_TOKENS = 80
/** A sentence between two takes ("Sorry, again.") is at most this many tokens. */
const MAX_BETWEEN = 6
/** A stutter's second run starts at most this long (seconds) after the first ends. */
const STUTTER_GAP = 1
const MAX_STUTTER = 4
/** Words often doubled on purpose: never a one-word stutter. */
const DOUBLES = new Set(['that', 'had', 'is', 'very', 'really', 'so', 'no', 'yes', 'yeah', 'bye', 'ha', 'more', 'now', 'well', 'far', 'long', 'many', 'again', 'go', 'too', 'okay', 'ok'])

const SENTENCE_END = /[.?!…।]["'”’)\]]*$/u

export type RetakeKind = 'retake' | 'repeat'

export interface RetakeMatch {
  kind: RetakeKind
  span: WordSpan
}

/** Sentences as word spans: ended by . ? ! … । , a pause of SENTENCE_PAUSE, or a caption's end before a short pause. */
export function sentencesOf(words: readonly TranscriptWord[]): WordSpan[] {
  const out: WordSpan[] = []
  let first = 0
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1]
    const pause = next ? next.start - words[i].end : Infinity
    const ends =
      !next ||
      SENTENCE_END.test(words[i].text) ||
      pause >= SENTENCE_PAUSE - 1e-9 ||
      (next.caption !== words[i].caption && pause >= CAPTION_END_PAUSE - 1e-9)
    if (ends) {
      out.push([first, i])
      first = i + 1
    }
  }
  return out
}

interface Sentence {
  span: WordSpan
  tokens: string[]
}

/** Whether `a` is a take that `b` says again. */
function retakeOf(a: string[], b: string[]): boolean {
  if (a.length === 2) return b.length >= 2 && b[0] === a[0] && b[1] === a[1]
  if (a.length < 3 || a.length > MAX_TOKENS || b.length > MAX_TOKENS) return false
  if (!b.slice(0, 3).includes(a[0])) return false
  return lcsPairs(a, b).length / a.length >= RETAKE_OVERLAP - 1e-9
}

/**
 * Retakes and stutters as word spans to cut, in order, never overlapping: a retake runs from the
 * first word of the earlier take to the word before the later one; a stutter is the first of two
 * runs said in a row. Stutters inside a retake are left out.
 */
export function findRetakes(words: readonly TranscriptWord[], language?: string): RetakeMatch[] {
  const lang = fillerLanguage(language)
  const keys = words.map((w) => normalizeWord(w.text))
  const kept = (i: number): boolean => keys[i] !== '' && !isFiller(keys[i], lang)
  const sentences: Sentence[] = sentencesOf(words).map((span) => {
    const tokens: string[] = []
    for (let i = span[0]; i <= span[1]; i++) if (kept(i)) tokens.push(keys[i])
    return { span, tokens }
  })

  const retakes: RetakeMatch[] = []
  for (let s = 0; s < sentences.length; s++) {
    const a = sentences[s]
    for (const gap of [1, 2]) {
      const b = sentences[s + gap]
      if (!b) break
      if (words[b.span[0]].start - words[a.span[1]].end > RETAKE_WINDOW) break
      if (gap === 2 && sentences[s + 1].tokens.length > MAX_BETWEEN) break
      if (retakeOf(a.tokens, b.tokens)) {
        retakes.push({ kind: 'retake', span: [a.span[0], b.span[0] - 1] })
        break
      }
    }
  }

  // Stutters: the same 1..4 tokens twice in a row (fillers between them do not count).
  const idx: number[] = []
  for (let i = 0; i < words.length; i++) if (kept(i)) idx.push(i)
  const stutters: RetakeMatch[] = []
  let k = 0
  while (k < idx.length) {
    let found = 0
    for (let n = Math.min(MAX_STUTTER, Math.floor((idx.length - k) / 2)); n >= 1; n--) {
      let same = true
      for (let m = 0; m < n && same; m++) same = keys[idx[k + m]] === keys[idx[k + n + m]]
      if (!same) continue
      if (n === 1 && DOUBLES.has(keys[idx[k]])) continue
      // Never across a sentence's end ("... the store. The store was closed").
      let ends = false
      for (let m = 0; m < n && !ends; m++) ends = SENTENCE_END.test(words[idx[k + m]].text)
      if (ends) continue
      if (words[idx[k + n]].start - words[idx[k + n - 1]].end > STUTTER_GAP) continue
      found = n
      break
    }
    if (found) {
      // The first run, and any filler between it and the second ("I, um, I think").
      stutters.push({ kind: 'repeat', span: [idx[k], idx[k + found] - 1] })
      k += found
    } else k++
  }

  const covered = (m: RetakeMatch): boolean => retakes.some((r) => m.span[0] >= r.span[0] && m.span[1] <= r.span[1])
  const all = [...retakes, ...stutters.filter((m) => !covered(m))].sort((x, y) => x.span[0] - y.span[0] || y.span[1] - x.span[1])
  // Retake spans can chain (A, A', A''): they touch but never overlap. Anything that would overlap goes.
  const out: RetakeMatch[] = []
  for (const m of all) {
    const last = out[out.length - 1]
    if (last && m.span[0] <= last.span[1]) continue
    out.push(m)
  }
  return out
}
