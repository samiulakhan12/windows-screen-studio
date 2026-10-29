/**
 * Filler words (NW-01, docs/design/edit-by-text.md §4.5): "um", "uh" and the like, found in the
 * transcript's words with a short list per language. Words that are only sometimes fillers ("like",
 * "you know") count only when they stand apart: a pause or a comma next to them. No AI call.
 */
import { normalizeWord, type TranscriptWord, type WordSpan } from './transcript'

export { normalizeWord }

/** A pause (seconds) next to a context filler that makes it one. */
export const FILLER_PAUSE = 0.3

/** Languages with their own lists; any other uses only the sounds every language shares. */
export type FillerLanguage = 'en' | 'bn' | 'de' | 'fr' | 'es' | 'other'

interface FillerList {
  /** Always fillers: one word each. */
  always: string[]
  /** Fillers only in context: each a list of words said in a row. */
  context: string[][]
}

/** Hesitation sounds speech models write in any language. */
const SHARED = ['um', 'umm', 'uh', 'uhh', 'uhm', 'hmm', 'hm', 'mm']

const LISTS: Record<FillerLanguage, FillerList> = {
  en: { always: [...SHARED, 'er', 'erm', 'ah', 'eh'], context: [['like'], ['you', 'know'], ['i', 'mean']] },
  bn: { always: [...SHARED, 'উম', 'উমম', 'আঁ', 'উঁ', 'হুম', 'হুমম', 'আহ'], context: [['মানে']] },
  de: { always: [...SHARED, 'äh', 'ähm', 'öh', 'öhm'], context: [] },
  fr: { always: [...SHARED, 'euh', 'heu', 'bah'], context: [] },
  es: { always: [...SHARED, 'eh', 'em'], context: [['este']] },
  other: { always: SHARED, context: [] }
}

/** The list for a transcript's language (BCP-47; the part before '-'); unknown: English. */
export function fillerLanguage(language?: string): FillerLanguage {
  if (!language) return 'en'
  const base = language.toLowerCase().split('-')[0]
  return Object.hasOwn(LISTS, base) ? (base as FillerLanguage) : 'other'
}

/** Whether these words (normalised) are fillers in any context. */
export function isFiller(normalized: string, language: FillerLanguage = 'en'): boolean {
  return LISTS[language].always.includes(normalized)
}

/** A comma (any script) at the end of a word as written. */
const endsWithComma = (text: string): boolean => /[,،、，]\s*$/u.test(text)

/** Whether words first..last stand apart: a pause or a comma before or after them. */
function standsApart(words: readonly TranscriptWord[], first: number, last: number): boolean {
  const prev = words[first - 1]
  const next = words[last + 1]
  if (!prev || !next) return true
  if (words[first].start - prev.end >= FILLER_PAUSE - 1e-9 || next.start - words[last].end >= FILLER_PAUSE - 1e-9) return true
  return endsWithComma(prev.text) || endsWithComma(words[last].text)
}

/** Filler words in order, as word spans; a match never overlaps the one before it. */
export function findFillers(words: readonly TranscriptWord[], language?: string): WordSpan[] {
  const list = LISTS[fillerLanguage(language)]
  const keys = words.map((w) => normalizeWord(w.text))
  const out: WordSpan[] = []
  let i = 0
  while (i < words.length) {
    if (keys[i] && list.always.includes(keys[i])) {
      out.push([i, i])
      i++
      continue
    }
    const phrase = list.context.find((p) => p.every((k, n) => keys[i + n] === k) && standsApart(words, i, i + p.length - 1))
    if (phrase) {
      out.push([i, i + phrase.length - 1])
      i += phrase.length
      continue
    }
    i++
  }
  return out
}
