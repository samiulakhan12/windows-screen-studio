/**
 * A short name from a sentence the user said (docs/design/smart-tools.md §7.5 rules 2 and 4), for a
 * found chapter (part P2), a guide's screen, badge and added steps (P1) and a short clip (P3).
 * Offline and pure. A name never carries anything private-like (privateLike: a link, an address, a
 * dotted name or a file path), whoever said it: such a sentence gives no name, and the caller tries
 * its next source.
 */
import { fillerLanguage, isFiller, normalizeWord } from '../editor/fillers'
import { privateLike } from './privateText'

/**
 * Words that start a new part of a recording (§7.3): `common` ones also start ordinary sentences
 * (score 1); `section` ones announce a part (score 2.5). '#' stands for a number ("step 3", "ধাপ ২").
 */
export const CUE_WORDS: Readonly<Record<string, { common: readonly string[]; section: readonly string[] }>> = Object.freeze({
  en: Object.freeze({
    common: Object.freeze(['now', 'next', 'first', 'then', 'so', 'okay', "let's"]),
    section: Object.freeze(['moving on', 'next step', 'next up', 'the next thing', 'in this section', 'in the next part', "let's move on", 'finally', 'lastly', 'to finish', 'part #', 'step #'])
  }),
  bn: Object.freeze({
    common: Object.freeze(['এখন', 'এবার', 'প্রথমে', 'তারপর']),
    section: Object.freeze(['পরবর্তী ধাপ', 'এবার আসি', 'পরের অংশে', 'শেষে', 'সবশেষে', 'ধাপ #', 'অংশ #'])
  })
})

/**
 * Lead-ins removed from the start of a name (rule 2), longest first when matched. 'we' and 'you'
 * only before another word that is not one of NOT_VERBS ("we open settings": "open settings").
 */
export const LEAD_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  en: Object.freeze(['so', 'and', 'okay', 'alright', 'now', 'next', 'then', 'first', 'finally', "let's", "we'll", "i'll", "i'm going to", "we're going to", 'you can', 'we', 'you']),
  bn: Object.freeze(['তো', 'আচ্ছা', 'এবার', 'এখন', 'তারপর', 'চলুন', 'শেষে'])
})

/** Words after 'we' or 'you' that are not a verb the name could start with. */
const NOT_VERBS = new Set(['are', 'were', 'will', 'would', 'have', 'had', 'all', 'and', 'or', 'know', 'guys', 'see'])

/** Where a name is cut (rule 2): the first comma or semicolon, or one of these words. */
const CUT_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['so that', 'and then', 'which', 'because'],
  bn: ['যাতে', 'তারপর', 'কারণ']
}

/** Commas and semicolons of every script. */
const CLAUSE_END = /[,;،؛、，；]/u
/** A sentence's end: the text after it is left out. */
const SENTENCE_END = /[.!?।॥。！？…]+(?:\s|$)/u
/** Punctuation and ellipses at the end of a name, and punctuation at its start. */
const TRAILING = /[\s\p{P}…]+$/u
const LEADING = /^[\s\p{P}]+/u

/** The word lists of `language`: its own, or for an unknown language (none given) both English and Bangla. */
function lists<T>(table: Readonly<Record<string, T>>, language?: string): T[] {
  const base = language?.toLowerCase().split('-')[0]
  if (!base) return Object.values(table)
  return Object.hasOwn(table, base) ? [table[base]] : []
}

/** Words of `text` (white space between them), apostrophes as "'". */
const wordsOf = (text: string): string[] => text.replace(/[‘’ʼ]/g, "'").split(/\s+/u).filter(Boolean)

/** A word as matched against the lists: lower case, without punctuation at its ends ("Let's," is "let's"). */
const key = (w: string): string => w.toLowerCase().replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')

/** How many words at the start of `words` the phrase covers ('#' a number), or 0. */
function matchAt(words: readonly string[], i: number, phrase: string): number {
  const parts = phrase.split(' ')
  for (let n = 0; n < parts.length; n++) {
    const w = words[i + n]
    if (w === undefined) return 0
    const k = key(w)
    if (parts[n] === '#' ? !/^[\p{Nd}]+$/u.test(k) : k !== parts[n]) return 0
    // Only the phrase's last word may carry a comma or a stop after it.
    if (n < parts.length - 1 && /[\p{P}]$/u.test(w) && !w.endsWith("'")) return 0
  }
  return parts.length
}

/** The longest phrase of `list` at the start of words[i..], or 0. */
function longest(words: readonly string[], i: number, list: readonly string[]): number {
  let best = 0
  for (const p of list) best = Math.max(best, matchAt(words, i, p))
  return best
}

/** `words` without their leading cue words, lead-ins and fillers (rule 2). */
function withoutLeadIns(words: string[], language?: string): string[] {
  const cues = lists(CUE_WORDS, language).flatMap((c) => [...c.section, ...c.common])
  const leads = lists(LEAD_WORDS, language).flat()
  const fillers = fillerLanguage(language)
  let i = 0
  for (;;) {
    if (i >= words.length) return []
    const w = words[i]
    if (!key(w)) {
      i++
      continue
    }
    const n = Math.max(longest(words, i, cues), longest(words, i, leads.filter((l) => l !== 'we' && l !== 'you')))
    if (n) {
      i += n
      continue
    }
    const k = key(w)
    if ((k === 'we' || k === 'you') && leads.includes(k) && i + 1 < words.length && !NOT_VERBS.has(key(words[i + 1])) && !/[\p{P}]$/u.test(w)) {
      i++
      continue
    }
    if (isFiller(normalizeWord(w), fillers)) {
      i++
      continue
    }
    return words.slice(i)
  }
}

/** `words` up to the first clause cut (a comma or semicolon, or a cut word of rule 2). */
function toClauseEnd(words: readonly string[], language?: string): string[] {
  const cutWords = lists(CUT_WORDS, language).flat()
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    if (i > 0 && longest(words, i, cutWords)) break
    const w = words[i]
    const at = w.search(CLAUSE_END)
    if (at >= 0) {
      const head = w.slice(0, at)
      if (head) out.push(head)
      break
    }
    out.push(w)
  }
  return out
}

/** The first letter as a capital where its script has them. */
function capitalised(text: string, language?: string): string {
  const first = Array.from(text)[0] ?? ''
  let upper = first
  try {
    upper = first.toLocaleUpperCase(language || undefined)
  } catch {
    upper = first.toUpperCase()
  }
  return upper + text.slice(first.length)
}

/**
 * A name from the first sentence of `text` (§7.5 rule 2): leading cue words, fillers and lead-ins
 * removed, cut at the first comma, semicolon, "so that", "and then", "which" or "because" (bn
 * "যাতে", "তারপর", "কারণ"), the first letter a capital in scripts with capitals. Null unless 2 to 8
 * words are left, or when what is left is private-like. "Now let's set up billing, which takes a
 * minute." gives "Set up billing".
 */
export function sentenceName(text: string, language?: string): string | null {
  const first = text.split(SENTENCE_END)[0] ?? ''
  const words = toClauseEnd(withoutLeadIns(wordsOf(first.trim()), language), language)
  const name = words.join(' ').replace(TRAILING, '').replace(LEADING, '')
  const count = wordsOf(name).length
  if (count < 2 || count > 8 || privateLike(name)) return null
  return capitalised(name, language)
}

/** Viramas of the Indic scripts and the zero-width joiner: a grapheme ending in one joins the next (a conjunct is never split). */
const JOINS_NEXT = /[्্੍્୍்్್്්္្‍]$/u

/** The graphemes of `text`, a conjunct ("ক্ষ", "স্ত্র") as one. */
function clusters(text: string): string[] {
  const out: string[] = []
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const { segment } of seg.segment(text)) {
    if (out.length && JOINS_NEXT.test(out[out.length - 1])) out[out.length - 1] += segment
    else out.push(segment)
  }
  return out
}

/**
 * The first sentence of `text` cut short (§7.5 rule 4): at a word boundary to at most `max`
 * graphemes (a word longer than that at a grapheme, never inside a conjunct), without a trailing
 * punctuation mark or ellipsis. Null when nothing is left or it is private-like.
 */
export function cutName(text: string, max = 40): string | null {
  const first = (text.split(SENTENCE_END)[0] ?? '').replace(/\s+/gu, ' ').trim().replace(LEADING, '')
  const g = clusters(first)
  let name: string
  if (g.length <= max) name = first
  else {
    const head = g.slice(0, max + 1)
    const space = head.lastIndexOf(' ')
    name = (space > 0 ? head.slice(0, space) : g.slice(0, max)).join('')
  }
  name = name.replace(TRAILING, '').trim()
  if (!name || privateLike(name)) return null
  return name
}
