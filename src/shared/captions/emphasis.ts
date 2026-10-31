/**
 * Auto emphasis, offline (docs/design/captions-studio.md §11.1): a score per word, and the picks.
 * Pure. Marks point at words by studioWordTexts index (§8.1) and carry their text; their ids come
 * from their content, so a second run that picks the same words gives the same marks (§11.8).
 */
import type { CaptionMark, CaptionSegment, Clip, CursorTrack, Project } from '../types'
import { textHash } from './captionTracks'
import { bareWord, isLabelWord, isNumberWord, isYearWord } from './numbers'
import { STOP_WORDS } from './stopWords'
import { studioTokens, type StudioToken } from './words'

/** Candidates score at least this (§11.1). */
export const EMPHASIS_MIN = 2.5
/** At most one emphasised word in eight overall. */
export const EMPHASIS_SHARE = 1 / 8
/** A run of capitalised words is one phrase of at most this many words. */
const PHRASE_MAX = 3
/** Seconds between a word and a click, a Zoom here mark or the start of typing (+1). */
const NEAR_ACTION = 0.6
/** The longest text a mark keeps. */
const MARK_TEXT_MAX = 80

const baseLanguage = (language: string | undefined): string => (language ?? 'en').toLowerCase().split(/[-_]/)[0]

/** Button and menu verbs: the word after one (articles skipped) is an object (+1.5). */
const UI_VERBS = new Set([
  'click', 'press', 'open', 'select', 'choose', 'type', 'drag', 'save', 'copy', 'paste', 'delete', 'remove', 'add', 'create', 'scroll', 'tap', 'enable', 'disable', 'rename',
  'upload', 'download', 'install', 'run', 'check', 'hit', 'pick', 'toggle', 'turn'
])
/** Skipped between a verb and its object. */
const OBJECT_SKIP = new Set(['the', 'a', 'an', 'your', 'my', 'our', 'this', 'that', 'on', 'onto', 'into', 'in', 'to', 'its', 'their', 'off', 'up'])
/** Light verbs a Bangla or Hindi command is made with ("ক্লিক করুন", "क्लिक करें"): the object is the word before them. */
const LIGHT_VERBS = new Set(['ক্লিক', 'ট্যাপ', 'চাপ', 'সেভ', 'ওপেন', 'সিলেক্ট', 'টাইপ', 'ডিলিট', 'ডাউনলোড', 'इंस्टॉल', 'क्लिक', 'टैप', 'सेव', 'ओपन', 'सिलेक्ट', 'टाइप', 'डिलीट', 'डाउनलोड'])
/** Negations, "only", "every" (never stop words; +1.5). */
const MEANING_WORDS = new Set([
  'not', 'never', 'no', "don't", "doesn't", "didn't", "can't", "won't", "isn't", "aren't", "wasn't", 'nothing', 'none', 'nobody', 'without', 'only', 'every', 'always',
  'না', 'নয়', 'নেই', 'কখনো', 'কখনও', 'শুধু', 'শুধুমাত্র', 'কেবল', 'প্রতিটি', 'সবসময়',
  'नहीं', 'न', 'मत', 'कभी', 'केवल', 'सिर्फ', 'सिर्फ़', 'हर', 'हमेशा',
  'nunca', 'jamás', 'solo', 'sólo', 'cada', 'jamais', 'seulement', 'chaque', 'pas', 'nicht', 'nie', 'niemals', 'kein', 'keine', 'nur', 'jede', 'jeder', 'não', 'só', 'apenas'
])
/** English superlatives (+1.5). */
const SUPERLATIVE = /^(most|least|best|worst|fastest|easiest|biggest|simplest|[a-z]{3,}iest)$/
const SUPERLATIVE_EST = /^[a-z]{3,}est$/
const NOT_SUPERLATIVE = new Set(['interest', 'request', 'suggest', 'test', 'contest', 'honest', 'modest', 'forest', 'protest', 'harvest', 'digest', 'invest', 'manifest', 'arrest', 'guest', 'chest', 'quest', 'priest', 'rest', 'west', 'nest', 'pest', 'vest', 'crest', 'unrest', 'latest'])
/** Percent words and currency (+1.5). */
const PERCENT_OR_MONEY = /[%$€£¥₹৳]|^(percent|শতাংশ|प्रतिशत|dollars?|euros?|taka|টাকা|rupees?|रुपये)$/u
/** Scripts with capital letters (the capital signal looks only at them). */
const CASED = /^[^\p{L}]*[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u
const CAPITAL = /^[^\p{L}]*\p{Lu}/u
const SENTENCE_END = /[.!?…।。！？]["'”’)\]]*$/u
const LATIN = /\p{Script=Latin}/u
const LETTER = /\p{L}/u
const WORDISH = /[\p{L}\p{N}]/u

const graphemer = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const graphemes = (s: string): number => (graphemer ? [...graphemer.segment(s)].length : [...s].length)

/** The bare form a word is counted and compared by. */
export const emphasisKey = (word: string): string => bareWord(word)

/** Every word's score (candidates at 2.5 or more), with phrases of capitalised words joined (`to`). */
export function emphasisScores(segments: readonly CaptionSegment[], ctx: { language?: string; cursor?: CursorTrack; clips: Clip[] }): { caption: string; word: number; to: number; score: number }[] {
  const lang = baseLanguage(ctx.language)
  const stop = STOP_WORDS[lang] ?? new Set<string>()
  const tokens = segments.map((s) => studioTokens(s, ctx.language).filter((t) => t.word >= 0))
  // Rarity: each caption a document.
  const df = new Map<string, number>()
  for (const ts of tokens) for (const k of new Set(ts.map((t) => emphasisKey(t.text)))) df.set(k, (df.get(k) ?? 0) + 1)
  const n = segments.length
  const actions = actionTimes(ctx.cursor)
  const out: { caption: string; word: number; to: number; score: number }[] = []
  segments.forEach((seg, si) => {
    const ts = tokens[si]
    // Latin words in a caption mostly in another script ("Settings খুলুন").
    const otherScript = nonLatinShare(ts) > 0.5
    const scores: (number | null)[] = ts.map((_, i) => scoreWord(ts, i, { lang, stop, df, n, actions, otherScript }))
    // Objects of button and menu verbs, and of Bangla and Hindi polite commands.
    for (const i of objectIndexes(ts, lang)) if (scores[i] !== null) scores[i] = (scores[i] as number) + 1.5
    // A run of capitalised words is one phrase ("Auto Save"), scored by its best word.
    let i = 0
    while (i < ts.length) {
      const score = scores[i]
      if (score === null) {
        i++
        continue
      }
      let to = i
      if (capitalisedInside(ts, i))
        while (to + 1 < ts.length && to - i + 1 < PHRASE_MAX && scores[to + 1] !== null && capitalisedInside(ts, to + 1) && !SENTENCE_END.test(ts[to].text) && !/[,;:]$/.test(ts[to].text)) to++
      let best = score
      for (let k = i; k <= to; k++) best = Math.max(best, scores[k] as number)
      out.push({ caption: seg.id, word: ts[i].word, to: ts[to].word, score: best })
      i = to + 1
    }
  })
  return out
}

/** Share of a caption's letters outside the Latin script. */
function nonLatinShare(ts: readonly StudioToken[]): number {
  let latin = 0
  let all = 0
  for (const t of ts)
    for (const ch of t.text)
      if (LETTER.test(ch)) {
        all++
        if (LATIN.test(ch)) latin++
      }
  return all ? 1 - latin / all : 0
}

/** Times of clicks, Zoom here marks and the starts of typing. */
function actionTimes(cursor: CursorTrack | undefined): number[] {
  if (!cursor) return []
  return [...cursor.clicks.map((c) => c.t), ...(cursor.marks ?? []).map((m) => m.t), ...(cursor.typing ?? []).map((t) => t.t)].sort((a, b) => a - b)
}

/** A capital letter not at a sentence start, in a script with case. */
function capitalisedInside(ts: readonly StudioToken[], i: number): boolean {
  const t = ts[i].text
  if (!CASED.test(t) || !CAPITAL.test(t)) return false
  return i > 0 && !SENTENCE_END.test(ts[i - 1].text)
}

/** The score of word i of a caption, or null when it is never a candidate (punctuation, a stop word). */
function scoreWord(
  ts: readonly StudioToken[],
  i: number,
  c: { lang: string; stop: ReadonlySet<string>; df: ReadonlyMap<string, number>; n: number; actions: readonly number[]; otherScript: boolean }
): number | null {
  const t = ts[i]
  const key = emphasisKey(t.text)
  if (!WORDISH.test(t.text) || !key) return null
  if (c.stop.has(key) && !MEANING_WORDS.has(key)) return null
  let score = 0
  const number = isNumberWord(t.text, c.lang)
  if (number) {
    // Numbers score by what they are, not by rarity: +3, only +1 for years and labels.
    const label = (i > 0 && isLabelWord(ts[i - 1].text)) || /\+/.test(t.text)
    score += isYearWord(t.text) || label ? 1 : 3
  } else score += Math.log((c.n + 1) / ((c.df.get(key) ?? 0) + 0.5))
  if (PERCENT_OR_MONEY.test(t.text) || PERCENT_OR_MONEY.test(key) || (number && PERCENT_OR_MONEY.test(emphasisKey(ts[i + 1]?.text ?? '')))) score += 1.5
  if (capitalisedInside(ts, i)) score += 2
  if (c.otherScript && LATIN.test(t.text) && LETTER.test(t.text)) score += 1.5
  if (MEANING_WORDS.has(key) || (c.lang === 'en' && (SUPERLATIVE.test(key) || (SUPERLATIVE_EST.test(key) && !NOT_SUPERLATIVE.has(key))))) score += 1.5
  if (!number && graphemes(key) >= 7) score += 0.5
  if (c.actions.some((a) => a >= t.start - NEAR_ACTION && a <= t.end + NEAR_ACTION)) score += 1
  return score
}

/** Word indexes (into ts) that are the object of a button or menu verb (en), or come before a polite command (bn, hi). */
function objectIndexes(ts: readonly StudioToken[], lang: string): number[] {
  const out: number[] = []
  if (lang === 'bn' || lang === 'hi') {
    const command = lang === 'bn' ? /ুন$/u : /(िए|ें|िये)$/u
    for (let i = 1; i < ts.length; i++) {
      if (!command.test(emphasisKey(ts[i].text))) continue
      let k = i - 1
      if (LIGHT_VERBS.has(emphasisKey(ts[k].text)) && k > 0) k--
      out.push(k)
    }
    return out
  }
  for (let i = 0; i < ts.length - 1; i++) {
    if (!UI_VERBS.has(emphasisKey(ts[i].text)) || /[.,;:!?]$/.test(ts[i].text)) continue
    let k = i + 1
    while (k < ts.length && OBJECT_SKIP.has(emphasisKey(ts[k].text))) k++
    if (k < ts.length) out.push(k)
  }
  return out
}

/** The words i..j of a caption as a mark's text (at most 80 characters). */
function spanText(words: readonly string[], i: number, j: number): string {
  return words.slice(i, j + 1).join(' ').slice(0, MARK_TEXT_MAX)
}

/** The id of an automatic mark: from its content, so a run that picks the same words makes the same mark. */
export function markId(caption: string, from: number, text: string): string {
  return `m-${textHash(`${caption}|${from}|${text}`)}`
}

/**
 * The automatic marks for captions without marks: at most 1 per caption of up to 6 words, 2 for
 * longer ones, and at most one word in eight overall, counting the marks there are (§11.1).
 * Captions with a mark are left alone. `cursor` adds the click signal when the recording has one.
 */
export function pickEmphasis(project: Project, opts?: { maxShare?: number; cursor?: CursorTrack; avoid?: ReadonlySet<string> }): CaptionMark[] {
  const segments = project.transcript?.segments ?? []
  if (!segments.length) return []
  const language = project.transcript?.language
  const marked = new Set((project.captionMarks ?? []).map((m) => m.caption))
  const scores = emphasisScores(segments, { language, cursor: opts?.cursor, clips: project.clips })
  const byCaption = new Map<string, { word: number; to: number; score: number }[]>()
  for (const s of scores) if (s.score >= EMPHASIS_MIN && !marked.has(s.caption)) byCaption.set(s.caption, [...(byCaption.get(s.caption) ?? []), s])
  const words = new Map(segments.map((s) => [s.id, studioTokens(s, language).filter((t) => t.word >= 0).map((t) => t.text)]))
  let total = 0
  for (const w of words.values()) total += w.length
  let markedWords = 0
  for (const m of project.captionMarks ?? []) markedWords += m.to - m.from + 1
  let room = Math.floor(total * (opts?.maxShare ?? EMPHASIS_SHARE)) - markedWords
  if (room <= 0) return []
  // Earlier emphasis of the same word lowers its score (-1.5 each), in time order.
  const used = new Map<string, number>()
  for (const m of project.captionMarks ?? []) for (const k of m.text.split(/\s+/).map(emphasisKey)) used.set(k, (used.get(k) ?? 0) + 1)
  const candidates: { caption: string; word: number; to: number; score: number; order: number }[] = []
  segments.forEach((seg, order) => {
    const list = byCaption.get(seg.id)
    if (!list) return
    const ws = words.get(seg.id)!
    const adjusted = list
      .filter((s) => !opts?.avoid?.has(`${seg.id}:${s.word}`))
      .map((s) => {
        let penalty = 0
        for (let k = s.word; k <= s.to; k++) penalty = Math.max(penalty, used.get(emphasisKey(ws[k])) ?? 0)
        return { ...s, score: s.score - 1.5 * penalty }
      })
      .filter((s) => s.score >= EMPHASIS_MIN)
      .sort((a, b) => b.score - a.score || a.word - b.word)
      .slice(0, ws.length <= 6 ? 1 : 2)
    for (const s of adjusted) {
      for (let k = s.word; k <= s.to; k++) used.set(emphasisKey(ws[k]), (used.get(emphasisKey(ws[k])) ?? 0) + 1)
      candidates.push({ caption: seg.id, ...s, order })
    }
  })
  // The highest scores win the overall limit.
  candidates.sort((a, b) => b.score - a.score || a.order - b.order || a.word - b.word)
  const picked: typeof candidates = []
  for (const c of candidates) {
    const size = c.to - c.word + 1
    if (size > room) continue
    picked.push(c)
    room -= size
    if (room <= 0) break
  }
  picked.sort((a, b) => a.order - b.order || a.word - b.word)
  return picked.map((c) => {
    const text = spanText(words.get(c.caption)!, c.word, c.to)
    return { id: markId(c.caption, c.word, text), caption: c.caption, from: c.word, to: c.to, text, auto: true as const }
  })
}
