/**
 * Lists spoken in captions (docs/design/captions-studio.md §11.5): an announcement ("three steps")
 * and the items that follow it ("First, … Second, … Finally, …"), or "A, B and C" after the
 * announcement in one caption. Pure; times come from the words (studioTokens), in source seconds.
 */
import type { CaptionSegment } from '../types'
import { asciiDigits, bareWord, parseNumberWords } from './numbers'
import { CLAUSE_END, JOIN_WORDS, SENTENCE_END } from './phraseWords'
import { studioTokens } from './words'

/** Nouns that make a count an announcement (§11.5). */
const LIST_NOUNS = new Set([
  'steps', 'things', 'ways', 'tips', 'reasons', 'options', 'parts', 'rules', 'tricks', 'mistakes', 'ideas', 'features', 'stages', 'points', 'questions', 'lessons',
  'ধাপ', 'ধাপে', 'উপায়', 'উপায়ে', 'টিপস', 'কারণ', 'চরণ', 'चरण', 'चरणों', 'तरीके', 'तरीकों', 'टिप्स', 'कारण', 'बातें',
  'pasos', 'formas', 'consejos', 'razones', 'étapes', 'façons', 'conseils', 'raisons', 'schritte', 'tipps', 'gründe', 'passos', 'dicas', 'motivos'
])
/** Ordinal markers by position, per language (§11.5). */
const ORDINALS: readonly (readonly string[])[] = [
  ['first', 'firstly', 'প্রথম', 'প্রথমত', 'প্রথমে', 'पहला', 'पहली', 'पहले', 'primero', 'premièrement', 'erstens', 'primeiro'],
  ['second', 'secondly', 'দ্বিতীয়', 'দ্বিতীয়ত', 'दूसरा', 'दूसरी', 'segundo', 'deuxièmement', 'zweitens'],
  ['third', 'thirdly', 'তৃতীয়', 'তৃতীয়ত', 'तीसरा', 'तीसरी', 'tercero', 'troisièmement', 'drittens', 'terceiro'],
  ['fourth', 'fourthly', 'চতুর্থ', 'চতুর্থত', 'चौथा', 'चौथी', 'cuarto', 'quatrièmement', 'viertens', 'quarto'],
  ['fifth', 'fifthly', 'পঞ্চম', 'पाँचवाँ', 'पांचवां', 'quinto', 'cinquièmement', 'fünftens'],
  ['sixth', 'ষষ্ঠ', 'छठा', 'sexto', 'sechstens'],
  ['seventh', 'সপ্তম', 'सातवाँ', 'séptimo', 'siebtens', 'sétimo']
]
/** Markers of the last item. */
const LAST_MARKERS = new Set(['finally', 'lastly', 'সবশেষে', 'শেষে', 'অবশেষে', 'अंत', 'आखिर', 'अंतिम', 'finalmente', 'enfin', 'schließlich', 'zuletzt'])
/** "step 2", "number 3". */
const STEP_WORDS = new Set(['step', 'number', 'ধাপ', 'चरण', 'paso', 'étape', 'schritt', 'passo'])
/** "এক নম্বর", "2 नंबर". */
const NUMBER_AFTER = new Set(['নম্বর', 'নম্বরে', 'नंबर'])
/** Words trimmed from an item's ends besides the join words. */
const TRIM = new Set(['the', 'a', 'an', 'then', 'just', 'you', 'we', 'is', 'are', 'so', 'now', 'also', 'next', 'please'])
/** Words that join the parts of "A, B and C". */
const AND_WORDS = new Set(['and', 'or', 'এবং', 'ও', 'আর', 'और', 'y', 'et', 'und', 'e'])

/** Seconds after an announcement its items may come (§11.5). */
const ITEMS_WITHIN = 120
const MAX_ITEMS = 7
/** Words of an item at most. */
const ITEM_WORDS = 5

const baseLanguage = (language: string | undefined): string => (language ?? 'en').toLowerCase().split(/[-_]/)[0]

interface Word {
  text: string
  bare: string
  start: number
  /** The caption it is in (index into the segments). */
  seg: number
}

/** A count written as digits or words, Bangla classifiers off (তিনটি, ৩টি). */
function countOf(w: Word, language: string | undefined): number | undefined {
  const counted = w.bare.replace(/(টি|টা)$/u, '')
  if (/^\d+$/.test(asciiDigits(counted))) return Number(asciiDigits(counted))
  return parseNumberWords([counted], language)?.value
}

/** The position (1-based) an ordinal marker names, 'last' for finally or lastly, and the words it used. */
function ordinalAt(words: readonly Word[], k: number, language: string | undefined): { n: number | 'last'; used: number } | null {
  const w = words[k].bare
  const i = ORDINALS.findIndex((list) => list.includes(w))
  if (i >= 0) return { n: i + 1, used: 1 }
  if (LAST_MARKERS.has(w)) return { n: 'last', used: 1 }
  const next = words[k + 1]
  if (next && next.seg === words[k].seg) {
    if (STEP_WORDS.has(w)) {
      const v = countOf(next, language)
      if (v !== undefined && v >= 1 && v <= MAX_ITEMS) return { n: v, used: 2 }
    }
    if (NUMBER_AFTER.has(next.bare)) {
      const v = countOf(words[k], language)
      if (v !== undefined && v >= 1 && v <= MAX_ITEMS) return { n: v, used: 2 }
    }
  }
  return null
}

/** The count of an announcement at word k ("three steps", "3 quick tips", "তিনটি ধাপ"), or null. */
function announcementAt(words: readonly Word[], k: number, language: string | undefined): { n: number; used: number } | null {
  const n = countOf(words[k], language)
  if (n === undefined || n < 2 || n > MAX_ITEMS) return null
  for (let j = 1; j <= 2; j++) {
    const next = words[k + j]
    if (!next || next.seg !== words[k].seg) return null
    if (LIST_NOUNS.has(next.bare)) return { n, used: j + 1 }
  }
  return null
}

const cleanEnds = (text: string): string => text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')
const capitalised = (text: string, language: string | undefined): string => (text ? text[0].toLocaleUpperCase(language) + text.slice(1) : '')

/** The words from `from` to the end of the clause, at most 5, join words and fillers trimmed from both ends. */
function clauseText(words: readonly Word[], from: number, language: string | undefined): string {
  const join = new Set(JOIN_WORDS[baseLanguage(language)] ?? [])
  const out: Word[] = []
  for (let k = from; k < words.length && words[k].seg === words[from]?.seg; k++) {
    out.push(words[k])
    if (SENTENCE_END.test(words[k].text) || CLAUSE_END.test(words[k].text) || out.length >= ITEM_WORDS + 4) break
  }
  const trimmed = (w: Word): boolean => join.has(w.bare) || TRIM.has(w.bare) || !/[\p{L}\p{N}]/u.test(w.bare)
  let a = 0
  while (a < out.length && trimmed(out[a])) a++
  let b = Math.min(out.length, a + ITEM_WORDS)
  while (b > a && trimmed(out[b - 1])) b--
  return capitalised(cleanEnds(out.slice(a, b).map((w) => w.text).join(' ')), language)
}

/** "speed, quality and price." in the announcing caption after a colon: 2..7 items of at most 3 words. */
function inlineItems(words: readonly Word[], from: number, language: string | undefined): { text: string; at: number }[] | null {
  const seg = words[from]?.seg
  if (seg === undefined) return null
  const items: { text: string; at: number }[] = []
  let part: Word[] = []
  const flush = (): boolean => {
    if (!part.length) return true
    if (part.length > 3) return false
    items.push({ text: capitalised(cleanEnds(part.map((w) => w.text).join(' ')), language), at: part[0].start })
    part = []
    return true
  }
  for (let k = from; k < words.length && words[k].seg === seg; k++) {
    const w = words[k]
    if (AND_WORDS.has(w.bare) && part.length) {
      if (!flush()) return null
      continue
    }
    part.push(w)
    if (/[,،、]["'”’)\]]*$/u.test(w.text) && !flush()) return null
    if (SENTENCE_END.test(w.text)) break
  }
  if (!flush()) return null
  return items.length >= 2 && items.length <= MAX_ITEMS ? items : null
}

/** The lists announced in the captions, with 2 items or more. */
export function findLists(segments: readonly CaptionSegment[], language?: string): { title: string; items: { text: string; at: number }[]; caption: string }[] {
  const words: Word[] = []
  segments.forEach((seg, s) => {
    for (const t of studioTokens(seg, language)) if (t.word >= 0) words.push({ text: t.text, bare: bareWord(t.text), start: t.start, seg: s })
  })
  const out: { title: string; items: { text: string; at: number }[]; caption: string }[] = []
  for (let k = 0; k < words.length; k++) {
    const ann = announcementAt(words, k, language)
    if (!ann) continue
    const caption = segments[words[k].seg].id
    const title = clauseText(words, k, language)
    const after = k + ann.used
    // "Three ways: speed, quality and price."
    const inline = /[:：]["'”’)\]]*$/u.test(words[after - 1].text) ? inlineItems(words, after, language) : null
    if (inline) {
      out.push({ title, items: inline.slice(0, ann.n), caption })
      continue
    }
    const items: { text: string; at: number }[] = []
    let expect = 1
    let j = after
    for (; j < words.length && items.length < ann.n; j++) {
      const w = words[j]
      if (w.start - words[k].start > ITEMS_WITHIN) break
      // Another announcement starts another list.
      if (announcementAt(words, j, language)) break
      // A marker starts a clause: the caption's first word, or after a clause or sentence end.
      const prev = words[j - 1]
      if (prev && prev.seg === w.seg && !SENTENCE_END.test(prev.text) && !CLAUSE_END.test(prev.text)) continue
      const o = ordinalAt(words, j, language)
      if (!o || (o.n === 'last' ? items.length === 0 : o.n !== expect)) continue
      const text = clauseText(words, j + o.used, language)
      if (!text) continue
      items.push({ text, at: w.start })
      expect++
      j += o.used - 1
      if (o.n === 'last') break
    }
    if (items.length >= 2) {
      out.push({ title, items, caption })
      k = j - 1
    }
  }
  return out
}
