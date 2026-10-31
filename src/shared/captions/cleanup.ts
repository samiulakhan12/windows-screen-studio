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
import { captionWordTimes } from '../editor/transcript'
import type { Bleep, CaptionAuto, CaptionSegment, CaptionWord, Project } from '../types'
import { STANDARD_WORDS, STRICT_WORDS } from './bleepWords'
import { applyTextResult } from './edit'
import { parseNumberWords } from './numbers'
import { textHash } from './captionTracks'
import { MAX_BLEEPS } from './studioData'

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

/** Levenshtein distance of at most 1 (one letter off). */
function oneOff(a: string, b: string): boolean {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  while (i < Math.min(la, lb) && a[i] === b[i]) i++
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1)
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

function applyWordList(tokens: Tok[], words: readonly WordListEntry[]): Tok[] {
  if (!words.length) return tokens
  // Heard forms of several words first ("flow in" → "Flown"), then single words.
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
        if (k < n - 1 && TRAILING.exec(tokens[i + k].text)?.[0]) match = false
        else if (core !== f.parts[k]) match = n === 1 && f.parts[0].length >= 5 && [...core].length >= 5 && oneOff(core, f.parts[0]) && !isTerm(core, words)
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
/** A word that is itself one of the terms (never "corrected" into another term). */
const isTerm = (core: string, words: readonly WordListEntry[]): boolean => words.some((e) => e.term.toLowerCase() === core)

/* ---------- rule 3: numbers as digits ---------- */

/** Spelled numbers above this are written as digits ("Above ten"); 12 in Norwegian (Netflix's guides). */
const writtenUpTo = (lang: string): number => (lang === 'no' || lang === 'nb' || lang === 'nn' ? 12 : 10)

function applyDigits(tokens: Tok[], mode: CleanupChoices['digits'], language: string | undefined): Tok[] {
  if (mode === 'off') return tokens
  const lang = baseLanguage(language)
  if (lang !== 'en' && lang !== 'bn' && lang !== 'hi') return tokens
  const fmt = new Intl.NumberFormat(language || 'en', { useGrouping: false, maximumFractionDigits: 0 })
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

/** A word as the bleep lists match it: lower case, punctuation removed, repeated letters collapsed. */
export function bleepKey(word: string): string {
  const bare = word.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '')
  let out = ''
  let run = 0
  for (const ch of bare) {
    run = out.endsWith(ch) ? run + 1 : 1
    if (run <= (KEEP_TWO.has(ch) ? 2 : 1)) out += ch
  }
  return out
}

/**
 * Words the team writes for languages LDNOOBW lacks (Written for Flown, CC0-1.0; they start small
 * and need a native speaker's check before release, §0.3 decision 4).
 */
const TEAM_WORDS: Readonly<Record<string, readonly string[]>> = {
  bn: ['চোদ', 'চুদি', 'চোদা', 'খানকি', 'মাগি', 'বাল', 'হারামি', 'হারামজাদা', 'শুয়োরের']
}

const standardRes = STANDARD_WORDS.map((w) => ({ word: w.word, res: w.patterns.map((p) => new RegExp(p, 'u')), safe: w.safe.map((s) => bleepKey(s)) }))
const strictSets = new Map<string, ReadonlySet<string>>()
function strictSet(lang: string): ReadonlySet<string> {
  let s = strictSets.get(lang)
  if (!s) {
    s = new Set([...(STRICT_WORDS[lang] ?? []), ...(TEAM_WORDS[lang] ?? [])].map(bleepKey).filter(Boolean))
    strictSets.set(lang, s)
  }
  return s
}

/** Whether a word is bleeped by `mode` in `language`. */
export function isSwearWord(word: string, mode: 'standard' | 'strict', language?: string): boolean {
  const key = bleepKey(word)
  if (!key) return false
  for (const w of standardRes) {
    if (!w.res.some((re) => re.test(key))) continue
    if (w.safe.some((s) => s && key.includes(s))) continue
    return true
  }
  const lang = baseLanguage(language)
  // Bangla and the languages LDNOOBW lacks have the team's lists in Standard too.
  if (TEAM_WORDS[lang] && [...(TEAM_WORDS[lang] ?? [])].some((t) => bleepKey(t) === key || (key.startsWith(bleepKey(t)) && key.length - bleepKey(t).length <= 3))) return true
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
  for (const seg of segments) {
    for (const w of captionWordTimes(seg)) {
      if (w.deleted || !isSwearWord(w.text, mode, language)) continue
      const pad = w.estimated ? WIDEN_ESTIMATED : WIDEN
      const start = Math.max(0, w.start - pad)
      const end = Math.min(duration > 0 ? duration : Infinity, w.end + pad)
      const word = bleepKey(w.text).slice(0, 40) || w.text.toLowerCase().slice(0, 40)
      const mid = (w.start + w.end) / 2
      if (have.some((b) => b.start <= mid && b.end >= mid) || out.some((b) => b.start <= mid && b.end >= mid)) continue
      const id = `b-${textHash(`${start.toFixed(3)}|${end.toFixed(3)}|${word}`)}`
      if (w.estimated) estimated?.add(id)
      out.push({ id, start, end, word, sound, auto: true })
    }
  }
  return out
}

/** A bleeped word as shown: "f***" (first letter and asterisks), "****" in scripts without case. */
export function maskWord(word: string): string {
  const g = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word)].map((s) => s.segment) : [...word]
  if (!g.length) return word
  const cased = CASED.test(g[0])
  return g.map((ch, i) => (i === 0 && cased ? ch : '*')).join('')
}

/** A word with its letters masked and its punctuation kept ("damn," → "d***,"). */
const maskToken = (text: string): string => {
  const core = coreOf(text)
  return core ? withCore(text, maskWord(core)) : text
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
    const words = seg.words && seg.words.length === texts.length ? seg.words.map((w, i) => (mask.has(i) ? { ...w, text: maskToken(w.text) } : w)) : seg.words
    return { ...seg, text, ...(words ? { words } : {}) }
  })
  return changed ? out : segments
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
  const language = transcript.language
  const segs = transcript.segments
  let tidied: CaptionSegment[] = segs.map((seg, i) => {
    let tokens = tokensOf(seg)
    if (!tokens.length) return seg
    tokens = applyWordList(tokens, opts.words)
    tokens = applyDigits(tokens, opts.digits, language)
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

/**
 * Tidy captions' notice (§2.9, §11.7): "Tidied 12 captions, bleeped 2 words" or "Nothing to tidy";
 * says when bleeped words had estimated times, and when the AI fix was left out.
 */
export function cleanupNotice(r: { changed: number; bleeped: number; estimated?: number; aiLeftOut?: string }): string {
  const parts: string[] = []
  if (r.changed) parts.push(`Tidied ${count(r.changed, 'caption')}`)
  if (r.bleeped) parts.push(`${parts.length ? 'bleeped' : 'Bleeped'} ${count(r.bleeped, 'word')}`)
  let text = parts.length ? parts.join(', ') : 'Nothing to tidy'
  if (r.estimated) text += '. Some bleeped words have estimated times, so a little more is bleeped'
  if (r.aiLeftOut) text += `. ${r.aiLeftOut}`
  return text
}
