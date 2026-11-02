/**
 * Clean-up, the word list and bleeping (docs/design/captions-studio.md §11.7). Pure.
 *
 * Tidy captions changes text by the offline rules (capitals, full stops and spaces, numbers as
 * digits, the word list), then applies the AI fix when there is one, and records each changed
 * caption's text and words before in `captionAuto.text`: one update, one undo step. Bleeps are
 * time-based (§4.1): they mute the sound over a span and mask the word wherever spoken-track words
 * are shown; the transcript keeps the real word.
 */
import type { AiTextResult } from '../api/ai'
import { alignKey, captionWordTimes } from '../editor/transcript'
import type { Bleep, CaptionAuto, CaptionSegment, CaptionSettings, CaptionWord, Project } from '../types'
import { STANDARD_WORDS, STRICT_WORDS } from './bleepWords'
import { applyTextResult } from './edit'
import { parseNumberWords } from './numbers'
import { textHash, transcriptLanguage } from './captionTracks'
import { MAX_BLEEPS } from './studioData'
import { studioWordTexts } from './words'

/** The Clean up section's choices (prefs `captionCleanup`, §2.9). */
export interface CleanupChoices {
  caps: boolean
  punct: boolean
  digits: 'above-ten' | 'all' | 'off'
  bleep: 'off' | 'standard' | 'strict'
  bleepSound: 'tone' | 'silence'
  ai: boolean
}

/** A word-list entry (prefs `captionWordList`): the term as written and the forms it is heard as. */
export interface WordListEntry {
  term: string
  heard: string[]
}

/** The AI fix's answer (today's `cleanup` text task). */
export type TextResult = Extract<AiTextResult, { task: 'cleanup' | 'translate' }>

/**
 * A stretch of the recording's sound at `gain` (source seconds), as the sound finder's SoundGain.
 * TODO(phase B): use SoundGain from src/shared/api/export.ts once the sound finder (F-17) has
 * merged; soundGains then joins these with its own (§11.7, §14.2).
 */
export interface SoundGain {
  start: number
  end: number
  gain: number
}

export const DEFAULT_CLEANUP: Readonly<CleanupChoices> = Object.freeze({ caps: true, punct: true, digits: 'above-ten', bleep: 'off', bleepSound: 'tone', ai: false })

/** At most this many word-list entries (§2.9). */
export const WORD_LIST_MAX = 500

/** Stored choices with defaults for anything missing or unknown (caps, punct on; digits above ten; no bleeping; tone; no AI). */
export function readCleanupChoices(raw: unknown): CleanupChoices {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const D = DEFAULT_CLEANUP
  const flag = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  return {
    caps: flag(o.caps, D.caps),
    punct: flag(o.punct, D.punct),
    digits: o.digits === 'all' || o.digits === 'off' || o.digits === 'above-ten' ? o.digits : D.digits,
    bleep: o.bleep === 'standard' || o.bleep === 'strict' || o.bleep === 'off' ? o.bleep : D.bleep,
    bleepSound: o.bleepSound === 'silence' || o.bleepSound === 'tone' ? o.bleepSound : D.bleepSound,
    ai: flag(o.ai, D.ai)
  }
}

/** Longest term or heard form, and most heard forms a term keeps (§4.6). */
export const WORD_LIST_LIMITS = { chars: 40, heard: 5 } as const

/** A stored word list (§4.6): terms of one line and at most 40 characters, each with at most 5 heard forms of at most 40, at most WORD_LIST_MAX entries. */
export function readWordList(raw: unknown): WordListEntry[] {
  if (!Array.isArray(raw)) return []
  const out: WordListEntry[] = []
  const seen = new Set<string>()
  const line = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, WORD_LIST_LIMITS.chars).trim() : '')
  for (const v of raw) {
    if (out.length >= WORD_LIST_MAX) break
    if (!v || typeof v !== 'object') continue
    const term = line((v as Record<string, unknown>).term)
    if (!term || seen.has(term.toLowerCase())) continue
    seen.add(term.toLowerCase())
    const heard = Array.isArray((v as Record<string, unknown>).heard) ? ((v as Record<string, unknown>).heard as unknown[]).map(line).filter(Boolean).slice(0, WORD_LIST_LIMITS.heard) : []
    out.push({ term, heard })
  }
  return out
}

/* ---------- the word list as a transcription hint (rule 4) ---------- */

/**
 * Most UTF-8 bytes of terms (with their ", ") sent as a transcription hint: Whisper keeps at most
 * 224 prompt tokens (§11.7 rule 4), and the speech engine takes a prompt of at most 1,024 bytes.
 */
export const GLOSSARY_BYTES = 900
const utf8 = new TextEncoder()

/** Control and bidi-override characters a hint never carries (ZWJ and ZWNJ stay: Bangla and Hindi spell with them). */
const HINT_UNSAFE = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+/gu

/**
 * The word list's terms as a transcription hint carries them (§11.7 rule 4): strings of one line
 * without control characters, at most 40 characters, no repeats (case ignored), and only whole
 * terms within GLOSSARY_BYTES. Anything else in `raw` is dropped.
 */
export function glossaryTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (const v of raw.slice(0, WORD_LIST_MAX)) {
    if (typeof v !== 'string') continue
    const term = v.replace(HINT_UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, WORD_LIST_LIMITS.chars).trim()
    if (!term || seen.has(term.toLowerCase())) continue
    const size = utf8.encode(term).length + 2
    if (bytes + size > GLOSSARY_BYTES) break
    seen.add(term.toLowerCase())
    out.push(term)
    bytes += size
  }
  return out
}

/** "Glossary: Flown, Qbexel." (the engine's and OpenAI's prompt), or another lead (Gemini's "Spell these names as written"); undefined without terms. */
export function glossaryLine(terms: readonly string[], lead = 'Glossary'): string | undefined {
  return terms.length ? `${lead}: ${terms.join(', ')}.` : undefined
}

/* ---------- words of a caption ---------- */

const baseLanguage = (language: string | undefined): string => (language ?? 'en').toLowerCase().split(/[-_]/)[0]
/** Scripts with capital letters. */
const CASED = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}]/u
const SENTENCE_END = /[.!?…।۔。！？]["'”’)\]]*$/u
const LEADING = /^[^\p{L}\p{N}]*/u
const TRAILING = /[^\p{L}\p{N}]*$/u
/** Punctuation that never has a space before it. */
const CLOSING = /^[.,;:!?…।۔。、，！？％%)\]}”’]+$/u

/** A word of a caption with its time when the caption has word times that match its text. */
interface Tok {
  text: string
  word?: CaptionWord
}

/** The words of a caption as written, with times when its words match them one to one. */
function tokensOf(seg: CaptionSegment): Tok[] {
  const texts = seg.text.split(/\s+/).filter(Boolean)
  const timed = seg.words && seg.words.length === texts.length ? seg.words : null
  return texts.map((text, i) => (timed ? { text, word: timed[i] } : { text }))
}

/** One token for tokens[a..b], their times joined (first start to last end). */
function joined(tokens: readonly Tok[], a: number, b: number, text: string): Tok {
  const ws = tokens.slice(a, b + 1).map((t) => t.word)
  if (ws.some((w) => !w)) return { text }
  const words = ws as CaptionWord[]
  const w: CaptionWord = { text, start: words[0].start, end: words[words.length - 1].end }
  if (words.some((x) => x.estimated)) w.estimated = true
  if (w.estimated && words.every((x) => x.fromSound)) w.fromSound = true
  return { text, word: w }
}

/** Whether tokens a..b may join: none is deleted in the Transcript tab. */
const joinable = (tokens: readonly Tok[], a: number, b: number): boolean => tokens.slice(a, b + 1).every((t) => !t.word?.deleted)

/** A token's text with `core` in place of its letters and digits, its punctuation kept. */
function withCore(text: string, core: string): string {
  const lead = LEADING.exec(text)?.[0] ?? ''
  const rest = text.slice(lead.length)
  const trail = TRAILING.exec(rest)?.[0] ?? ''
  return lead + core + trail
}
const coreOf = (text: string): string => {
  const lead = LEADING.exec(text)?.[0] ?? ''
  const rest = text.slice(lead.length)
  return rest.slice(0, rest.length - (TRAILING.exec(rest)?.[0].length ?? 0))
}

/* ---------- rule 4: the word list ---------- */

function applyWordList(tokens: Tok[], words: readonly WordListEntry[]): Tok[] {
  if (!words.length) return tokens
  // Heard forms of several words first ("flow in" → "Flown"), then single words. A term and its heard
  // forms match whole words only, as written: a word a letter away from a name is often another real
  // word ("start" and Stuart, "seven" and Steven), so a mishearing goes in "also heard as".
  const forms: { parts: string[]; term: string }[] = []
  for (const e of words) {
    forms.push({ parts: e.term.toLowerCase().split(/\s+/), term: e.term })
    for (const h of e.heard) forms.push({ parts: h.toLowerCase().split(/\s+/).filter(Boolean), term: e.term })
  }
  forms.sort((a, b) => b.parts.length - a.parts.length)
  const out: Tok[] = []
  let i = 0
  outer: while (i < tokens.length) {
    for (const f of forms) {
      const n = f.parts.length
      if (!n || i + n > tokens.length) continue
      let match = true
      for (let k = 0; k < n && match; k++) {
        const core = coreOf(tokens[i + k].text).toLowerCase()
        // The last part may end in punctuation; inner parts may not.
        if ((k < n - 1 && TRAILING.exec(tokens[i + k].text)?.[0]) || core !== f.parts[k]) match = false
      }
      if (!match || !joinable(tokens, i, i + n - 1)) continue
      const first = tokens[i].text
      const last = tokens[i + n - 1].text
      const text = (LEADING.exec(first)?.[0] ?? '') + f.term + (TRAILING.exec(last)?.[0] ?? '')
      out.push(n === 1 ? { ...tokens[i], text, ...(tokens[i].word ? { word: { ...tokens[i].word!, text } } : {}) } : joined(tokens, i, i + n - 1, text))
      i += n
      continue outer
    }
    out.push(tokens[i])
    i++
  }
  return out
}

/* ---------- rule 3: numbers as digits ---------- */

/** Spelled numbers above this are written as digits ("Above ten"); 12 in Norwegian (Netflix's guides). */
const writtenUpTo = (lang: string): number => (lang === 'no' || lang === 'nb' || lang === 'nn' ? 12 : 10)

/** The digits a number is written with (§0.2's Digits choice): Bangla ০–৯ or Hindi ०–९ for 'native', 0–9 for 'western'; absent, the language's own. */
function numbering(lang: string, digits: CaptionSettings['digits']): string | undefined {
  if (digits === 'western') return 'latn'
  if (digits === 'native') return lang === 'bn' ? 'beng' : lang === 'hi' ? 'deva' : undefined
  return undefined
}

/** The number formats made, by language and digits (one per caption would take most of a tidy's time). */
const formats = new Map<string, Intl.NumberFormat>()
function numberFormat(language: string, system: string | undefined): Intl.NumberFormat {
  const key = `${language}|${system ?? ''}`
  let fmt = formats.get(key)
  if (!fmt) formats.set(key, (fmt = new Intl.NumberFormat(language, { useGrouping: false, maximumFractionDigits: 0, ...(system ? { numberingSystem: system } : {}) })))
  return fmt
}

function applyDigits(tokens: Tok[], mode: CleanupChoices['digits'], language: string | undefined, digits: CaptionSettings['digits']): Tok[] {
  if (mode === 'off') return tokens
  const lang = baseLanguage(language)
  if (lang !== 'en' && lang !== 'bn' && lang !== 'hi') return tokens
  const fmt = numberFormat(language || 'en', numbering(lang, digits))
  const out: Tok[] = []
  let i = 0
  while (i < tokens.length) {
    const texts = tokens.slice(i).map((t) => t.text)
    // A word starting with a letter only: "twenty-five", not "25".
    const parsed = /^[^\p{N}]*\p{L}/u.test(texts[0]) ? parseNumberWords(texts, language) : null
    if (!parsed || !joinable(tokens, i, i + parsed.used - 1)) {
      out.push(tokens[i])
      i++
      continue
    }
    const words = texts.slice(0, parsed.used).map((t) => coreOf(t).toLowerCase())
    const prev = coreOf(tokens[i - 1]?.text ?? '').toLowerCase()
    const next = coreOf(tokens[i + parsed.used]?.text ?? '').toLowerCase()
    // "this one", "one of the", "a" and "an": words, not numbers.
    const lone = parsed.used === 1 && (words[0] === 'one' || words[0] === 'a' || words[0] === 'an')
    const keepWord = lone && (['this', 'that', 'which', 'each', 'every', 'the', 'no', 'any', 'another', 'someone', 'anyone', 'everyone'].includes(prev) || next === 'of' || words[0] !== 'one')
    if (keepWord || (mode === 'above-ten' && parsed.value <= writtenUpTo(lang))) {
      out.push(...tokens.slice(i, i + parsed.used))
      i += parsed.used
      continue
    }
    const text = (LEADING.exec(texts[0])?.[0] ?? '') + fmt.format(parsed.value) + (TRAILING.exec(texts[parsed.used - 1])?.[0] ?? '')
    out.push(parsed.used === 1 ? { ...tokens[i], text, ...(tokens[i].word ? { word: { ...tokens[i].word!, text } } : {}) } : joined(tokens, i, i + parsed.used - 1, text))
    i += parsed.used
  }
  return out
}

/* ---------- rules 1 and 2: capitals, full stops and spaces ---------- */

/** The end mark a caption gets before a pause, by language (none in Thai). */
function endMark(language: string | undefined): string {
  const lang = baseLanguage(language)
  if (lang === 'bn' || lang === 'hi') return '।'
  if (lang === 'ur') return '۔'
  if (lang === 'zh' || lang === 'ja') return '。'
  if (lang === 'th') return ''
  return '.'
}

/** A pause of at least this after a caption gets it an end mark (§11.7 rule 2). */
const PAUSE_FOR_STOP = 0.7

function capitalFirst(text: string, language: string | undefined): string {
  const lead = LEADING.exec(text)?.[0] ?? ''
  const ch = text.slice(lead.length).charAt(0)
  if (!ch || !CASED.test(ch)) return text
  const up = ch.toLocaleUpperCase(language || undefined)
  return up === ch ? text : lead + up + text.slice(lead.length + 1)
}

/** Capitals (when `caps`): sentence starts and English "I"; word-list terms as listed either way. */
function applyCaps(tokens: Tok[], caps: boolean, startsSentence: boolean, language: string | undefined, words: readonly WordListEntry[]): Tok[] {
  const english = caps && baseLanguage(language) === 'en'
  const terms = new Map(words.filter((e) => !/\s/.test(e.term)).map((e) => [e.term.toLowerCase(), e.term]))
  return tokens.map((t, i) => {
    let text = t.text
    const core = coreOf(text)
    // Word-list terms written exactly as listed.
    const term = terms.get(core.toLowerCase())
    if (term && core !== term) text = withCore(text, term)
    else if (english && /^i('(m|ve|ll|d|s))?$/.test(core)) text = withCore(text, 'I' + core.slice(1))
    const first = caps && (i === 0 ? startsSentence : SENTENCE_END.test(tokens[i - 1].text))
    if (first && !term) text = capitalFirst(text, language)
    return text === t.text ? t : { ...t, text, ...(t.word ? { word: { ...t.word, text } } : {}) }
  })
}

/** Punctuation written as its own word joins the word before it ("word ," → "word,"). */
function applySpaces(tokens: Tok[]): Tok[] {
  const out: Tok[] = []
  for (const t of tokens) {
    const prev = out[out.length - 1]
    if (prev && CLOSING.test(t.text) && !t.word?.deleted && !prev.word?.deleted) {
      const text = prev.text + t.text
      out[out.length - 1] = prev.word && t.word ? joined([prev, t], 0, 1, text) : { text }
    } else out.push(t)
  }
  return out
}

function applyStop(tokens: Tok[], pauseAfter: number, language: string | undefined): Tok[] {
  const mark = endMark(language)
  if (!mark || pauseAfter < PAUSE_FOR_STOP || !tokens.length) return tokens
  const last = tokens[tokens.length - 1]
  if (SENTENCE_END.test(last.text) || !/[\p{L}\p{N}]/u.test(last.text)) return tokens
  // A clause mark at the end becomes the full stop ("so," before a long pause → "so.").
  const text = last.text.replace(/[,;:]+$/u, '') + mark
  return [...tokens.slice(0, -1), { ...last, text, ...(last.word ? { word: { ...last.word, text } } : {}) }]
}

/* ---------- rule 5: bleeping ---------- */

/** Letters a run of is collapsed to two (obscenity's thresholds); any other letter to one. */
const KEEP_TWO = new Set(['b', 'e', 'o', 'l', 's', 'g'])
const BENGALI = /\p{Script=Bengali}/u

/**
 * A word as the bleep lists match it: in NFC (a cloud transcript or typed text may write য় as one
 * code point or ো in two parts), lower case, punctuation removed, repeated letters collapsed but
 * Bengali ones: a Bangla word writes a letter twice as its spelling (বালককে, "to the boy", is no
 * বালকে), not to draw it out.
 */
export function bleepKey(word: string): string {
  const bare = word.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '')
  let out = ''
  let run = 0
  for (const ch of bare) {
    run = out.endsWith(ch) ? run + 1 : 1
    if (run <= (KEEP_TWO.has(ch) ? 2 : 1) || BENGALI.test(ch)) out += ch
  }
  return out
}

/** U+09CD, the Bangla virama: a consonant that takes it joins the next one (দ্দ in চোদ্দ, fourteen). */
const VIRAMA = '\u09CD'
/** A word ending in a Bangla consonant (with its nukta when য়, ড়, ঢ় are written in two parts), or ৎ. */
const BN_CONSONANT_END = /[\u0995-\u09B9\u09BC\u09CE]$/u

/**
 * A list the team writes for a language LDNOOBW lacks (Written for Flown, CC0-1.0; it starts small
 * and needs a native speaker's check before release, §0.3 decision 4). Bangla builds many forms
 * from one word (case endings, plurals and classifiers with particles stacked after them, every
 * person and tense, the Dhaka forms, causatives, compounds, spelling variants), so its rude words
 * are stems matched at a word's start, not lists of whole forms that can never be complete.
 */
interface TeamList {
  /** Spellings of one word, folded for matching only (each [written, as matched]): a caption keeps its own. */
  fold: readonly (readonly [string, string])[]
  /**
   * Words rude in every form: a word starting with one is bleeped, unless the stem ends in a
   * consonant that takes a virama there (চোদ in চোদ্দ, fourteen).
   */
  stems: readonly string[]
  /** Compounds written as one word: a word holding one anywhere is bleeped, with the same guard. */
  compounds: readonly string[]
  /** Everyday words that hold a compound: it is not matched inside one, wherever that is in a word. */
  holders: readonly string[]
  /** Everyday words that start with a stem: never bleeped. */
  everyday: readonly string[]
  /** Nouns matched whole, in every form nounForms gives: those that also begin everyday words (বাল: বালক, বালিশ), English ones written in Bengali script. */
  nouns: readonly string[]
  /**
   * Words rude only before certain nouns, each [the words, the nouns]: matched whole, as written,
   * when the next word is one of the nouns in a form nounForms gives (শুয়োরের, "pig's", in
   * শুয়োরের বাচ্চা, never in শুয়োরের মাংস, pork).
   */
  onlyBefore: readonly (readonly [readonly string[], readonly string[]])[]
  /** Words never rude before certain nouns, each [the words, the nouns], as onlyBefore: names and words written apart (বাল গঙ্গাধর তিলক). */
  notBefore: readonly (readonly [readonly string[], readonly string[]])[]
  /** Of those, the ones a comma does not set apart, as notBefore: a list written with commas (লাল, বাল, পাল). */
  listed: readonly (readonly [readonly string[], readonly string[]])[]
}

/**
 * The forms of a Bangla noun: each classifier or plural (টা and টি "the", the Dhaka ডা, গুলো,
 * গুলা and গুলি "the ones", the Dhaka গো "of them") with each case ending (র "of", the Dhaka রে
 * "to", কে "to", তে and য় "in"; য় after আ and ও only), or a plural that is a case already (রা,
 * দের, দেরকে); then the particle ও "also" or ই "only" (বালটারেও, বালগুলোরই). After a consonant,
 * র, রা, রে and তে are written ের, েরা, েরে and ে as well (বালের, বালে).
 */
const BN_NUMBERS = ['', 'টা', 'টি', 'ডা', 'গুলো', 'গুলা', 'গুলি', 'গো']
const BN_CASES = ['', 'র', 'রে', 'কে', 'তে', 'য়']
const BN_PLURAL_CASES = ['রা', 'দের', 'দেরকে']
const BN_AFTER_CONSONANT = ['ের', 'েরা', 'েরে', 'ে']
const BN_PARTICLES = ['', 'ও', 'ই']
function nounForms(noun: string): string[] {
  const ends = BN_NUMBERS.flatMap((n) => BN_CASES.filter((c) => c !== 'য়' || /[াো]$/u.test(n || noun)).map((c) => n + c))
  ends.push(...BN_PLURAL_CASES)
  if (BN_CONSONANT_END.test(noun)) ends.push(...BN_AFTER_CONSONANT)
  return ends.flatMap((e) => BN_PARTICLES.map((p) => noun + e + p))
}

/**
 * The forms of a Bangla verb in the old written style (also in songs and poems) that put ি after
 * its root (মাগ: মাগিতেছেন, মাগিয়াছিলাম, মাগিলেম, মাগিনু, মাগিবার): the present and its
 * negative, every person of the present continuous and perfect, the past, past continuous, past
 * perfect, habitual past and future, the imperative, the participles ("having asked", "of
 * asking"; "to ask" and "if asked" are habitual and past forms already), then the particle ও or ই.
 */
const BN_LITERARY_ENDS = [
  ...['ি', 'িস', 'িনা'],
  ...['িতেছ', 'িয়াছ'].flatMap((t) => ['ি', '', 'িস', 'ে', 'েন'].map((p) => t + p)),
  ...['িল', 'িতেছিল', 'িয়াছিল'].flatMap((t) => ['াম', 'েম', 'ে', 'ি', '', 'েন', 'া'].map((p) => t + p)),
  'িনু',
  ...['াম', 'েম', 'ে', 'িস', '', 'েন'].map((p) => 'িত' + p),
  ...['', 'ো', 'ে', 'ি', 'েন', 'া'].map((p) => 'িব' + p),
  ...['িয়ো', 'িয়া', 'িবার']
]
function literaryForms(root: string): string[] {
  return BN_LITERARY_ENDS.flatMap((e) => BN_PARTICLES.map((p) => root + e + p))
}

/** The slur মাগি in every form: the forms of মাগা, "to ask", it shares stay bleeped (মাগি "I ask", মাগিতে "to ask"). */
const BN_MAGI = new Set(nounForms('মাগি'))
/** খানকি as it is written: with ং, a conjunct or a hasanta too (খাংকির পোলা, খাঙ্কি, খান্কি). */
const BN_KHANKI = ['খানকি', 'খাংকি', 'খাঙ্কি', 'খান্কি']
/**
 * শুয়োরের, "pig's", as it is spelled: শুওরের in West Bengal, শুয়ারের in Bangladesh (শুয়ারের বাচ্চা),
 * and শুকরের from শূকর, the standard word (শূকরের by the fold).
 */
const BN_PIG = ['শুয়োরের', 'শুওরের', 'শুয়রের', 'শুয়ারের', 'শুকরের']
/** কুত্তার, "dog's", rude before বাচ্চা as শুয়োরের is (কুকুরের বাচ্চা, with the everyday word for dog, is a puppy). */
const BN_DOG = ['কুত্তার']
/** বাচ্চা, "child", as it is spelled. */
const BN_KID = ['বাচ্চা', 'বাচ্ছা']
/** The animals whose genitive is rude before বাচ্চা. */
const BN_ANIMALS = [...BN_PIG, ...BN_DOG]

const TEAM_LISTS: Readonly<Record<string, TeamList>> = {
  bn: {
    // ী and ি, ূ and ু: one word either way (মাগী and মাগি, খানকীপনা and খানকিপনা).
    fold: [['ী', 'ি'], ['ূ', 'ু']],
    // The verb চোদা in every person and tense, its causative and the Dhaka forms (চোদব, চুদতেছস,
    // চুদিয়েছিল, চোদাইলি; the participle with ই after the vowel, its দ doubled or with য-ফলা, as
    // কইরা and মাইরা: চুইদা, চুইদ্দা, চুইদ্যা), the nouns made from it (চোদন, চোদনা, চুদির,
    // চোদাচুদি), the nouns in every form (খানকিরাও, খাংকির, মাগিটারে, হারামিগুলোরে,
    // হারামজাদাদেরকে, মাগীবাজ, হারামিপনা), and বাল's compounds (বালপাকনা, বালপাকা: a know-it-all child).
    stems: ['চোদ', 'চুদ', 'চুইদ', 'চুইদ্দ', 'চুইদ্য', ...BN_KHANKI, 'মাগি', 'হারামি', 'হারামজাদা', 'হারামজাদি', 'বালপাক'],
    // চোদ after any first part (বোকাচোদা, বোকাচ্চোদা, আবালচোদা; বানচোদ, বাইনচোদ, বেঞ্চোদ, and
    // বেইনচোদ, বইনচোদ or বোনচোদ in Dhaka; মাদারচোদ, মাচোদা); চুদ, চোত and চোৎ (ৎ also written ত্
    // and a joiner, বাঞ্চোত্‍) after the first parts that take them (বানচোত and বাঞ্চোৎ in West
    // Bengal; আবাল, বোকাচ্চ's doubled চ, and the Dhaka বইন, বেইন, বোন, বেহেন and বাপ; বান্, বাইন্,
    // বেন্ and মাদার্ written with a hasanta, as বান্চোত), not anywhere: বাচ্চুদা and পাঁচুদা are
    // nicknames; চুদমারানি with দ, ত, ৎ or ত্,
    // খানকিরপোলা as খানকি is written, and শুয়োরেরবাচ্চা and কুত্তারবাচ্চা written as one word.
    compounds: [
      'চোদ',
      ...[
        ...['বোকা', 'বান', 'বাইন', 'বাইঞ্', 'বাঞ্', 'বেঞ্', 'বেন', 'মাদার'],
        ...['আবাল', 'বোকাচ্', 'বইন', 'বেইন', 'বোন', 'বেহেন', 'বাপ'],
        ...['বান্', 'বাইন্', 'বেন্', 'মাদার্']
      ].flatMap((w) => ['চুদ', 'চোত', 'চোৎ', 'চোত্'].map((c) => w + c)),
      ...['চুদ', 'চুত', 'চুৎ', 'চুত্'].map((c) => c + 'মারানি'),
      ...BN_KHANKI.map((k) => k + 'রপোলা'),
      ...BN_ANIMALS.flatMap((w) => BN_KID.map((k) => w + k))
    ],
    // প্রচোদ, "to inspire" (Sanskrit): প্রচোদয়াৎ in the Gayatri mantra (ধিয়ো যো নঃ প্রচোদয়াৎ), প্রচোদিত;
    // কেঁচো, "earthworm", in its plural (কেঁচোদের, কেঁচোদেরকে).
    holders: ['প্রচোদ', 'কেঁচোদ'],
    everyday: [
      // মাগা, "to beg, to ask for" (in songs, poems and the old written style): its forms that start
      // with মাগি (মাগিতেছেন, মাগিয়াছিলাম, মাগিলেম, মাগিনু, মাগিবার), but those the slur takes too.
      ...literaryForms('মাগ').filter((w) => !BN_MAGI.has(w)),
      // চুদুরবুদুর, "stalling, dithering" (টালবাহানা): in the Bangla Academy's dictionary of regional
      // words, and quoted in the news (চুদুরবুদুর চলবে না).
      ...['চুদুরবুদুর', 'চুদুরবুদুরি'].flatMap(nounForms)
    ],
    // বালছাল written with স for ছ too, as Dhaka writes করসি and গেসে. English rude words as the
    // Bangla model writes them, in Bengali script; never the bare ফাক, which also spells ফাঁক, "a
    // gap" (এই ফাকে, "meanwhile"), beside ফাকা and ফাঁকা, "empty".
    nouns: ['বাল', 'বালছাল', 'বালসাল', 'ফাকিং', 'ফাকিন', 'মাদারফাকার', 'বাস্টার্ড'],
    // শুয়োরের, with ও or ই, is rude in শুয়োরের বাচ্চা only: শুয়োর, "pig", is an everyday word
    // (শুয়োরের মাংস, pork; শুয়োরের খামার, a pig farm; বুনো শুয়োরের আক্রমণ, a wild boar's attack).
    // কুত্তার the same way (কুত্তার কামড়, a dog's bite).
    onlyBefore: [[BN_ANIMALS.flatMap((w) => BN_PARTICLES.map((p) => w + p)), BN_KID]],
    notBefore: [
      // বাল, "child", in names and words written apart (বাল গঙ্গাধর তিলক, বাল ঠাকরে, লাল বাল পাল,
      // বাল গোপাল, বাল কৃষ্ণ, বাল বিধবা, বাল বিবাহ, বাল-বৃদ্ধ-বনিতা: young and old), and বাল বাচ্চা,
      // "the kids".
      [['বাল'], ['গঙ্গাধর', 'ঠাকরে', 'গোপাল', 'কৃষ্ণ', 'পাল', ...BN_KID, 'বিধবা', 'বিবাহ', 'বৃদ্ধ']],
      // চুদুরবুদুর written apart.
      [['চুদুর'], ['বুদুর', 'বুদুরি']]
    ],
    // লাল, বাল, পাল, the three leaders, as a history lesson writes them; a comma before বাল's other
    // names and বাচ্চা stays a pause (কি বাল, বাচ্চাদের মতো কথা বলিস).
    listed: [[['বাল'], ['পাল']]]
  }
}

/** A stem as matched: folded as words are, and whether it ends in a consonant (which a virama joins to the next). */
interface Stem {
  key: string
  consonant: boolean
}
/** A team list ready to match: its words and stems folded as words are. */
interface TeamRules {
  fold: (key: string) => string
  stems: readonly Stem[]
  compounds: readonly Stem[]
  holders: readonly string[]
  everyday: ReadonlySet<string>
  whole: ReadonlySet<string>
  /** Each word rude only before a word, and those words (onlyBefore, every form). */
  onlyBefore: ReadonlyMap<string, ReadonlySet<string>>
  /** Each word never rude before a word, and those words (notBefore, every form). */
  notBefore: ReadonlyMap<string, ReadonlySet<string>>
  /** Each word never rude before a word across a comma, and those words (listed, every form). */
  listed: ReadonlyMap<string, ReadonlySet<string>>
}
const teamRules = new Map<string, TeamRules | null>()
function teamRulesOf(lang: string): TeamRules | null {
  let r = teamRules.get(lang)
  if (r !== undefined) return r
  const list = TEAM_LISTS[lang]
  if (!list) r = null
  else {
    // After the punctuation goes, NFC again joins a vowel sign written in two parts around a joiner.
    const fold = (key: string): string => list.fold.reduce((k, [from, to]) => k.replaceAll(from, to), key.normalize('NFC'))
    const keyOf = (w: string): string => fold(bleepKey(w))
    const everyday = new Set(list.everyday.map(keyOf))
    const stem = (w: string): Stem => ({ key: keyOf(w), consonant: BN_CONSONANT_END.test(keyOf(w)) })
    const before = (pairs: TeamList['onlyBefore']): Map<string, ReadonlySet<string>> => {
      const m = new Map<string, Set<string>>()
      for (const [words, nouns] of pairs) {
        for (const w of words) {
          const next = m.get(keyOf(w)) ?? new Set<string>()
          for (const n of nouns.flatMap(nounForms)) next.add(keyOf(n))
          m.set(keyOf(w), next)
        }
      }
      return m
    }
    r = {
      fold,
      stems: list.stems.map(stem),
      compounds: list.compounds.map(stem),
      holders: list.holders.map(keyOf),
      everyday,
      whole: new Set(list.nouns.flatMap(nounForms).map(keyOf).filter((k) => k && !everyday.has(k))),
      onlyBefore: before(list.onlyBefore),
      notBefore: before(list.notBefore),
      listed: before(list.listed)
    }
  }
  teamRules.set(lang, r)
  return r
}

/** Whether `stem` is at `at` in `key`, its last consonant taking no virama there. */
const stemAt = (key: string, stem: Stem, at: number): boolean => key.startsWith(stem.key, at) && !(stem.consonant && key[at + stem.key.length] === VIRAMA)

/** Whether the compound `c` at `at` in `key` is part of an everyday word there (প্রচোদয়াৎ). */
const heldAt = (holders: readonly string[], key: string, c: Stem, at: number): boolean =>
  holders.some((h) => {
    const i = h.indexOf(c.key)
    return i >= 0 && i <= at && key.startsWith(h, at - i)
  })

/**
 * A pause between two words: none, a comma only (লাল, বাল, পাল: a list may go on across it), or a
 * full one (a sentence mark, a !, ;, : or …, or a caption's end and silence), the stronger of two
 * the larger.
 */
type Pause = 0 | 1 | 2
const NO_PAUSE: Pause = 0
const COMMA_PAUSE: Pause = 1
const FULL_PAUSE: Pause = 2
const stronger = (a: Pause, b: Pause): Pause => (a > b ? a : b)

/**
 * Whether a word's key is rude by a team list, `next` the key of the word after it ('' when there is
 * none; not known when undefined, and then a word rude only before some words is taken as rude).
 * `pause`: what is between them. After a pause a word never rude before some words is rude
 * whatever comes next (বাল। বাচ্চাটা: no name), but after a comma before a word it is listed with
 * (লাল, বাল, পাল).
 */
function teamMatch(r: TeamRules, key: string, next: string | undefined, pause: Pause = NO_PAUSE): boolean {
  const k = r.fold(key)
  if (r.everyday.has(k)) return false
  const n = next === undefined ? undefined : r.fold(next)
  const only = r.onlyBefore.get(k)
  if (only) return n === undefined || only.has(n)
  if (n !== undefined && r.notBefore.get(k)?.has(n) && (pause === NO_PAUSE || (pause === COMMA_PAUSE && r.listed.get(k)?.has(n)))) return false
  if (r.whole.has(k)) return true
  for (const stem of r.stems) if (stemAt(k, stem, 0)) return true
  for (const c of r.compounds) {
    for (let at = k.indexOf(c.key); at >= 0; at = k.indexOf(c.key, at + 1)) if (stemAt(k, c, at) && !heldAt(r.holders, k, c, at)) return true
  }
  return false
}

/** Text between letters that is not a letter, a digit, a mark or a joiner (ZWJ, ZWNJ): words written together (ধুর—বাল, বাল।এটা). */
const JOINED = /[\p{L}\p{M}][^\p{L}\p{N}\p{M}\p{Cf}]+[\p{L}\p{M}]/u
const BETWEEN_WORDS = /[^\p{L}\p{N}\p{M}\p{Cf}]+/u
/** Text between words that is more than hyphens and dashes (খান,কিন্তু; মা।গিয়ে): two words, never one written in parts. */
const APART = /[^\p{L}\p{N}\p{M}\p{Cf}]*[^\p{L}\p{N}\p{M}\p{Cf}\-\u2010-\u2015][^\p{L}\p{N}\p{M}\p{Cf}]*/u

/** A pause between words: a sentence mark, a comma, a !, ;, : or … (বাল। বাচ্চাটা, বাল! পাল বাবু), not a hyphen, dash or quotation mark. */
const PAUSE = /[\p{Terminal_Punctuation}\u2026]/u
/** A comma: the Latin one Bangla writes, and the Arabic, ideographic and full-width ones. */
const COMMAS = /[,\u060C\u3001\uFF0C]/gu
/** The pause the text between two words makes: a comma only, or a full one when it has another pause mark too. */
const pauseOf = (between: string): Pause => (!PAUSE.test(between) ? NO_PAUSE : PAUSE.test(between.replace(COMMAS, '')) ? FULL_PAUSE : COMMA_PAUSE)
/** A word's text after its last letter, digit, mark or joiner, and the next word's before its first. */
const AFTER_WORD = /[^\p{L}\p{N}\p{M}\p{Cf}]*$/u
const BEFORE_WORD = /^[^\p{L}\p{N}\p{M}\p{Cf}]*/u

/** The key of the word `text` begins with: its first part when words are written together (বাচ্চা-টা); '' for none. */
const firstKey = (text: string): string => text.split(BETWEEN_WORDS).map(bleepKey).find(Boolean) ?? ''

/**
 * Whether a word is rude by the team's list for `lang` (`key` its key, `next` the key of the word
 * after it and `pause` the pause before it, as teamMatch takes them; a pause after the word's last
 * letter counts too). Words written together with a dash or a । and no space
 * (ধুর—বাল, বাল।এটা, শালা-খানকি, শুয়োরের-বাচ্চা) are rude when one of them is, each before the
 * next. Parts joined by hyphens or dashes only are one word as well (হারাম-জাদা, বান-চোত), unless
 * the first is an everyday word that starts with a stem (মাগিনা-এটা); words joined by anything else
 * (a comma, a ।, ? or /) never are: খান,কিন্তু and মা।গিয়ে are everyday words.
 */
function teamWordMatch(word: string, key: string, lang: string, next: string | undefined, pause: Pause): boolean {
  const r = teamRulesOf(lang)
  if (!r) return false
  if (!JOINED.test(word)) return teamMatch(r, key, next, stronger(pause, pauseOf(AFTER_WORD.exec(word)?.[0] ?? '')))
  // Each part's key and the pause after it, the text between parts kept by the split.
  const parts: { key: string; pause: Pause }[] = []
  word.split(/([^\p{L}\p{N}\p{M}\p{Cf}]+)/u).forEach((bit, i) => {
    const last = parts[parts.length - 1]
    if (i % 2) {
      if (last) last.pause = stronger(last.pause, pauseOf(bit))
    } else if (bleepKey(bit)) parts.push({ key: bleepKey(bit), pause: NO_PAUSE })
  })
  const end = parts.length - 1
  if (parts.some((p, i) => teamMatch(r, p.key, i < end ? parts[i + 1].key : next, i === end ? stronger(p.pause, pause) : p.pause))) return true
  const groups = word.split(APART).filter((g) => bleepKey(g))
  return groups.some((g, i) => JOINED.test(g) && !r.everyday.has(r.fold(firstKey(g))) && teamMatch(r, bleepKey(g), i + 1 < groups.length ? firstKey(groups[i + 1]) : next))
}

const standardRes = STANDARD_WORDS.map((w) => ({ word: w.word, res: w.patterns.map((p) => new RegExp(p, 'u')), safe: w.safe.map((s) => bleepKey(s)) }))
const strictSets = new Map<string, ReadonlySet<string>>()
function strictSet(lang: string): ReadonlySet<string> {
  let s = strictSets.get(lang)
  if (!s) {
    s = new Set((STRICT_WORDS[lang] ?? []).map(bleepKey).filter(Boolean))
    strictSets.set(lang, s)
  }
  return s
}

const LATIN_RUN = /\p{Script=Latin}+/gu

/**
 * Whether a word is bleeped by `mode` in `language`. `next` is the word after it ('' for none): in
 * Bangla it decides for a word rude only before certain words (শুয়োরের in শুয়োরের বাচ্চা) or
 * never before certain words (বাল in বাল গঙ্গাধর তিলক); without it, such a word is taken as rude.
 * `apart` is true when the next word starts the next caption at least PAUSE_FOR_STOP later: as
 * after a sentence mark or a !, then, a word never rude before certain words is rude whatever the
 * next word is. A comma does the same but before a word listed with it (লাল, বাল, পাল).
 */
export function isSwearWord(word: string, mode: 'standard' | 'strict', language?: string, next?: string, apart = false): boolean {
  const key = bleepKey(word)
  if (!key) return false
  for (const w of standardRes) {
    if (!w.res.some((re) => re.test(key))) continue
    if (w.safe.some((s) => s && key.includes(s))) continue
    return true
  }
  // An English word written together with a Bangla ending, as Banglish writes videoটা and file-টা:
  // its Latin letters are checked by the English rules, as the bare word is.
  if (BENGALI.test(key)) for (const run of key.match(LATIN_RUN) ?? []) if (isSwearWord(run, mode, 'en')) return true
  // A word written in Bengali script is Bangla whatever the transcript's language (an English
  // transcript quoting a Bangla word, a mixed one that names no language), but in Assamese, which
  // is written in the same script.
  const named = baseLanguage(language)
  const lang = named !== 'as' && BENGALI.test(key) ? 'bn' : named
  // Bangla and the languages LDNOOBW lacks have the team's lists in Standard too.
  const pause = apart ? FULL_PAUSE : next === undefined ? NO_PAUSE : pauseOf(BEFORE_WORD.exec(next)?.[0] ?? '')
  if (teamWordMatch(word, key, lang, next === undefined ? undefined : firstKey(next), pause)) return true
  if (mode === 'strict') {
    if (strictSet(lang).has(key) || (lang !== 'en' && strictSet('en').has(key))) return true
  }
  return false
}

/** Seconds a bleep widens its word by: 0.05, or 0.15 for an estimated time (§11.7). */
const WIDEN = 0.05
const WIDEN_ESTIMATED = 0.15

/** The bleeps the captions' words need, for the words not bleeped yet. */
function findBleeps(
  segments: readonly CaptionSegment[],
  mode: 'standard' | 'strict',
  sound: Bleep['sound'],
  language: string | undefined,
  have: readonly Bleep[],
  duration: number,
  /** Ids of the bleeps made from estimated word times (their window is wider). */
  estimated?: Set<string>
): Bleep[] {
  const out: Bleep[] = []
  const captions = segments.map((seg) => captionWordTimes(seg))
  const words = captions.flat()
  const captionOf = captions.flatMap((ws, c) => ws.map(() => c))
  // The word after each, past the deleted ones and into the next caption ('' after the last): it
  // decides for some words (শুয়োরের বাচ্চা). A caption's end sets them apart as a full stop does
  // (বাল before a name) when the next caption starts PAUSE_FOR_STOP or more later: the Bangla
  // model cuts captions by length, through a name (লোকমান্য বাল | গঙ্গাধর তিলক) as anywhere.
  const after: string[] = new Array(words.length)
  const apart: boolean[] = new Array(words.length)
  for (let i = words.length - 1, next = '', nextCaption = -1, nextStart = Infinity; i >= 0; i--) {
    after[i] = next
    apart[i] = nextCaption !== captionOf[i] && nextStart - words[i].end >= PAUSE_FOR_STOP
    if (!words[i].deleted) {
      next = words[i].text
      nextCaption = captionOf[i]
      nextStart = words[i].start
    }
  }
  words.forEach((w, i) => {
    if (w.deleted || !isSwearWord(w.text, mode, language, after[i], apart[i])) return
    const pad = w.estimated ? WIDEN_ESTIMATED : WIDEN
    const start = Math.max(0, w.start - pad)
    const end = Math.min(duration > 0 ? duration : Infinity, w.end + pad)
    const word = bleepKey(w.text).slice(0, 40) || w.text.toLowerCase().slice(0, 40)
    const mid = (w.start + w.end) / 2
    if (have.some((b) => b.start <= mid && b.end >= mid) || out.some((b) => b.start <= mid && b.end >= mid)) return
    const id = `b-${textHash(`${start.toFixed(3)}|${end.toFixed(3)}|${word}`)}`
    if (w.estimated) estimated?.add(id)
    out.push({ id, start, end, word, sound, auto: true })
  })
  return out
}

/** A bleeped word as shown: "f***" (first letter and asterisks), "****" in scripts without case. */
export function maskWord(word: string): string {
  const g = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word)].map((s) => s.segment) : [...word]
  if (!g.length) return word
  const cased = CASED.test(g[0])
  return g.map((ch, i) => (i === 0 && cased ? ch : '*')).join('')
}

/** A word with its letters masked and its punctuation kept ("damn," → "d***,"), its last vowel sign or hasanta masked with it (মাগি, not "**ি"). */
const maskToken = (text: string): string => {
  const lead = LEADING.exec(text)?.[0] ?? ''
  const rest = text.slice(lead.length)
  const trail = /[^\p{L}\p{N}\p{M}]*$/u.exec(rest)?.[0] ?? ''
  const core = rest.slice(0, rest.length - trail.length)
  return core ? lead + maskWord(core) + trail : text
}

/** The words the bleeps are for (Bleep.word), made once per bleeps array. */
const bleepWords = new WeakMap<readonly Bleep[], ReadonlySet<string>>()

/**
 * `text` with each word a bleep is for masked as the captions mask it ("f***"): text drawn from
 * caption words (pop-ups, list cards, counter labels, quote cards) never reads a bleeped word,
 * also when it was made before the bleep (§11.7). `text` itself when it has none.
 */
export function maskBleeped(text: string, bleeps: readonly Bleep[] | undefined): string {
  if (!bleeps?.length || !text) return text
  let words = bleepWords.get(bleeps)
  if (!words) {
    words = new Set(bleeps.map((b) => b.word))
    bleepWords.set(bleeps, words)
  }
  const bleeped = words
  let changed = false
  const out = text.replace(/\S+/g, (t) => {
    const key = bleepKey(t).slice(0, 40)
    if (!key || !bleeped.has(key)) return t
    changed = true
    return maskToken(t)
  })
  return changed ? out : text
}

/** The share of [a, b] inside [s, e]. */
const inside = (a: number, b: number, s: number, e: number): number => (b - a <= 0 ? (a >= s && a <= e ? 1 : 0) : Math.max(0, Math.min(b, e) - Math.max(a, s)) / (b - a))

/** The captions with bleeped words masked by time; the same array without bleeps. */
export function maskedSegments(segments: readonly CaptionSegment[], bleeps: readonly Bleep[] | undefined): readonly CaptionSegment[] {
  if (!bleeps?.length) return segments
  let changed = false
  const out = segments.map((seg) => {
    const near = bleeps.filter((b) => b.end > seg.start && b.start < seg.end)
    if (!near.length) return seg
    const times = captionWordTimes(seg)
    const texts = seg.text.split(/\s+/).filter(Boolean)
    if (times.length !== texts.length) return seg
    const mask = new Set<number>()
    for (const b of near) {
      const within = times.map((w, i) => ({ i, w })).filter(({ w }) => inside(w.start, w.end, b.start, b.end) >= 0.5)
      const same = within.filter(({ w }) => bleepKey(w.text) === b.word || bleepKey(w.text).slice(0, 40) === b.word)
      // The word as bleeped; when the caption was edited and none matches, every word there.
      for (const { i } of same.length ? same : within) mask.add(i)
    }
    if (!mask.size) return seg
    changed = true
    const text = texts.map((t, i) => (mask.has(i) ? maskToken(t) : t)).join(' ')
    // Words that do not line up with the text one to one, each the same word as alignCaptionWords
    // compares them ("well-known" timed as two, a word typed out, or one deleted and another typed
    // in: as many words, not the same ones), give way to the times worked out for each word of the
    // text (with their deleted and estimated marks): a masked word then keeps its time, and a word
    // cut from the video stays cut. A masked word reads as the text's word masked, so it still
    // lines up with it.
    const lined = seg.words && (seg.words.length === texts.length && seg.words.every((w, i) => alignKey(w.text) === alignKey(texts[i])) ? seg.words : times)
    const words = lined?.map((w, i) => (mask.has(i) ? { ...w, text: maskToken(texts[i]) } : w))
    return { ...seg, text, ...(words ? { words } : {}) }
  })
  return changed ? out : segments
}

/** Each caption's masked words (studioWords indexes, or 'all'), made once per captions and bleeps. */
const bleepedOf = new WeakMap<readonly Bleep[], { segments: readonly CaptionSegment[]; language: string | undefined; words: Map<string, ReadonlySet<number> | 'all'> }>()

/**
 * Whether a bleep masks one of the words from..to (studioWords indexes) of caption `caption`, as
 * maskedSegments draws them: a graphic showing those words would read a bleeped word (§11.7). When
 * the masked caption no longer splits into the same words, any of its words counts.
 */
export function wordsBleeped(project: Pick<Project, 'transcript' | 'bleeps'>, span: { caption: string; from: number; to: number }): boolean {
  const bleeps = project.bleeps
  const segments = project.transcript?.segments
  if (!bleeps?.length || !segments?.length) return false
  const language = project.transcript?.language
  let made = bleepedOf.get(bleeps)
  if (!made || made.segments !== segments || made.language !== language) {
    const shown = maskedSegments(segments, bleeps)
    const words = new Map<string, ReadonlySet<number> | 'all'>()
    segments.forEach((seg, i) => {
      if (shown[i] === seg) return
      const was = studioWordTexts(seg.text, language)
      const now = studioWordTexts(shown[i].text, language)
      words.set(seg.id, was.length === now.length ? new Set(was.flatMap((w, k) => (w === now[k] ? [] : [k]))) : 'all')
    })
    made = { segments, language, words }
    bleepedOf.set(bleeps, made)
  }
  const masked = made.words.get(span.caption)
  if (!masked) return false
  if (masked === 'all') return true
  for (let k = span.from; k <= span.to; k++) if (masked.has(k)) return true
  return false
}

/** A gain of 0 over each bleep, for the sound finder's one muting path. */
export function bleepGains(project: Project): SoundGain[] {
  return (project.bleeps ?? []).map((b) => ({ start: b.start, end: b.end, gain: 0 }))
}

/* ---------- the action ---------- */

const sameWords = (a: CaptionWord[] | undefined, b: CaptionWord[] | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((w, i) => w.text === b[i].text && w.start === b[i].start && w.end === b[i].end && !!w.deleted === !!b[i].deleted))

/**
 * The captions tidied with `opts` (rules 1–6), with `captionAuto.text` records and bleeps: one update.
 * `fix` is the AI fix's answer (rule 6), applied when `ai` is on. (The contracts named it `ai`, which
 * CleanupChoices.ai already is; no value could satisfy both, so the answer is `fix`.)
 */
export function tidyCaptions(
  project: Project,
  opts: CleanupChoices & { words: readonly WordListEntry[]; fix?: TextResult }
): { project: Project; changed: number; bleeped: number; /** New bleeps made from estimated word times (a little more is bleeped). */ estimated: number } {
  const transcript = project.transcript
  if (!transcript?.segments.length) return { project, changed: 0, bleeped: 0, estimated: 0 }
  // As the captions read them (§0.2): Bangla for a mostly Bangla transcript that names no language,
  // so its swear words are bleeped from the Bangla list and its sentences end with ।.
  const language = transcriptLanguage(transcript)
  const segs = transcript.segments
  let tidied: CaptionSegment[] = segs.map((seg, i) => {
    let tokens = tokensOf(seg)
    if (!tokens.length) return seg
    tokens = applyWordList(tokens, opts.words)
    tokens = applyDigits(tokens, opts.digits, language, project.captions?.digits)
    if (opts.punct) tokens = applySpaces(tokens)
    if (opts.caps || opts.words.length) {
      const prevText = segs[i - 1]?.text.trim() ?? ''
      tokens = applyCaps(tokens, opts.caps, i === 0 || !prevText || SENTENCE_END.test(prevText), language, opts.words)
    }
    if (opts.punct) {
      const next = segs[i + 1]
      tokens = applyStop(tokens, next ? next.start - seg.end : Infinity, language)
    }
    const text = tokens.map((t) => t.text).join(' ')
    const timed = !!seg.words && seg.words.length === seg.text.split(/\s+/).filter(Boolean).length
    const words = timed ? tokens.map((t) => t.word ?? { text: t.text, start: seg.start, end: seg.end, estimated: true as const }) : seg.words
    if (text === seg.text && sameWords(words, seg.words)) return seg
    return { ...seg, text, ...(words ? { words } : {}) }
  })
  // Rule 6: the AI fix, on the tidied captions.
  if (opts.ai && opts.fix?.task === 'cleanup') {
    const fixed = applyTextResult(tidied, opts.fix.segments)
    if (fixed) tidied = fixed.map((s, i) => (s.text === tidied[i].text && sameWords(s.words, tidied[i].words) ? tidied[i] : s))
  }
  let changed = 0
  const before = new Map((project.captionAuto?.text ?? []).map((r) => [r.caption, r]))
  const records: NonNullable<CaptionAuto['text']> = []
  tidied.forEach((s, i) => {
    const old = segs[i]
    const differs = s !== old && (s.text !== old.text || !sameWords(s.words, old.words))
    if (differs) changed++
    else tidied[i] = old
    // A caption tidied before keeps its first record: Remove puts back the text from before the first tidy.
    const had = before.get(old.id)
    if (had) records.push(had)
    else if (differs) records.push({ caption: old.id, text: old.text, ...(old.words ? { words: old.words } : {}) })
  })
  let next: Project = project
  if (changed) {
    next = { ...project, transcript: { ...transcript, segments: tidied } }
    const auto: CaptionAuto = { ...project.captionAuto, text: records }
    next.captionAuto = auto
  }
  let bleeped = 0
  let estimated = 0
  if (opts.bleep !== 'off') {
    const guessed = new Set<string>()
    const found = findBleeps(next.transcript!.segments, opts.bleep, opts.bleepSound, language, project.bleeps ?? [], project.duration, guessed)
    if (found.length) {
      const all = [...(project.bleeps ?? []), ...found]
        .sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, MAX_BLEEPS)
      bleeped = found.filter((b) => all.includes(b)).length
      estimated = found.filter((b) => all.includes(b) && guessed.has(b.id)).length
      next = { ...next, bleeps: all }
    }
  }
  return { project: next, changed, bleeped, estimated }
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Tidy captions' notice (§2.9, §11.7): "Tidied 12 captions, bleeped 2 words" or "Nothing to tidy"; says when bleeped words had estimated times. */
export function cleanupNotice(r: { changed: number; bleeped: number; estimated?: number }): string {
  const parts: string[] = []
  if (r.changed) parts.push(`Tidied ${count(r.changed, 'caption')}`)
  if (r.bleeped) parts.push(`${parts.length ? 'bleeped' : 'Bleeped'} ${count(r.bleeped, 'word')}`)
  let text = parts.length ? parts.join(', ') : 'Nothing to tidy'
  if (r.estimated) text += '. Some bleeped words have estimated times, so a little more is bleeped'
  return text
}
