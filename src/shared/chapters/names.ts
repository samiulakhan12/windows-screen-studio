/**
 * Names of found chapters (docs/design/smart-tools.md §7.5, §7.6): for each, the first that gives
 * one of a title card the user made at its start, the first sentence said in it (cue words, fillers
 * and lead-ins removed, cut at the clause), a phrase said in it, that sentence cut short, or a
 * number ("Part 3"; the 0:00 chapter "Intro"). A name is refused, and the next tried, when it holds
 * anything private-like (a link, an address, a dotted name or a path), is empty, or repeats an
 * earlier chapter's name. An AI's names (the `names` task) pass the same checks. Pure.
 */
import type { NamesRequest } from '../api/ai'
import { STOP_WORDS } from '../captions/stopWords'
import { spokenSegments } from '../captions/subtitles'
import { uiObjects } from '../captions/emphasis'
import { studioTokens, withDigits } from '../captions/words'
import { CHAPTER_MAX_CHARS } from '../engine/titleData'
import { sentencesOf } from '../editor/retakes'
import { captionsWords, middlesCut, normalizeWord, type TranscriptWord } from '../editor/transcript'
import { cutName, sentenceName } from '../smart/sentenceName'
import { privateLike } from '../smart/privateText'
import type { CaptionSegment, ChapterOrigin, Project } from '../types'
import { userChapters } from './pending'
import { CHAPTER_RULES, userCard } from './signals'

const EPS = 1e-9
/** The first sentence starting this long (s) into a chapter names it. */
const FIRST_SENTENCE_S = 20
/** Longest narration sent for one chapter's AI name (characters, from its start). */
const NARRATION_MAX = 1500
/** A uiObjects object names a chapter when said at least this often in it. */
const OBJECT_MIN = 2

/** Weak names, marked "Rename?" in the chapter list until edited: a sentence cut short, or a number. */
export function weakName(name: ChapterOrigin['name']): boolean {
  return name === 'cut' || name === 'number'
}

/** The language a chapter name is written in: Bangla for Bangla captions, else English. */
const nameLanguage = (project: Pick<Project, 'transcript'>): 'en' | 'bn' => (project.transcript?.language?.toLowerCase().split('-')[0] === 'bn' ? 'bn' : 'en')

/** The words of rule 5. */
const NUMBER_WORDS = { en: { intro: 'Intro', part: 'Part' }, bn: { intro: 'শুরু', part: 'অংশ' } } as const

/** Viramas of the Indic scripts and the zero-width joiner: a grapheme ending in one joins the next (a conjunct is never split). */
const JOINS_NEXT = /[\u094d\u09cd\u0a4d\u0acd\u0b4d\u0bcd\u0c4d\u0ccd\u0d4d\u0dca\u1039\u17d2\u200d]$/u

/** Graphemes of `text`, a conjunct ("ক্ষ", "স্ত্র") as one. */
function graphemes(text: string): string[] {
  const out: string[] = []
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (out.length && JOINS_NEXT.test(out[out.length - 1])) out[out.length - 1] += segment
    else out.push(segment)
  }
  return out
}

/** A name as stored: one line, no control characters, at most 100 graphemes (never inside a cluster), trimmed. */
export function cleanName(text: string): string {
  const one = text
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const g = graphemes(one)
  return (g.length > CHAPTER_MAX_CHARS ? g.slice(0, CHAPTER_MAX_CHARS).join('') : one).trim()
}

/** The first letter as a capital where its script has them; the rest as said. */
function sentenceCase(text: string, language: string): string {
  const first = Array.from(text)[0] ?? ''
  let upper = first
  try {
    upper = first.toLocaleUpperCase(language)
  } catch {
    upper = first.toUpperCase()
  }
  return upper + text.slice(first.length)
}

/** Every language's stop words, or `language`'s own. */
function stopWordsOf(language?: string): ReadonlySet<string> {
  const base = language?.toLowerCase().split('-')[0]
  if (base && Object.hasOwn(STOP_WORDS, base)) return STOP_WORDS[base]
  return new Set(Object.values(STOP_WORDS).flatMap((s) => [...s]))
}

/** A word as compared: normalised, apostrophes as "'". */
const key = (w: string): string => normalizeWord(w.replace(/[‘’ʼ]/g, "'"))

/**
 * A phrase said in a chapter (§7.5 rule 3): among runs of 2 to 4 consecutive words inside one of
 * `chapterWords`' sentences, whose first and last words are not stop words, the one whose words'
 * tf-idf (counts in the chapter against the whole transcript `allWords`) add up highest; stop
 * words, words under 3 graphemes and words said only once in the chapter count 0 (a word said once
 * tells little of what the chapter is about). Of equal ones the shorter, then the first said.
 * Sentence case in scripts with capitals. Null when no run scores.
 */
export function phraseName(chapterWords: readonly string[][], allWords: readonly string[], language?: string): string | null {
  const stops = stopWordsOf(language)
  const all = new Map<string, number>()
  for (const w of allWords) {
    const k = key(w)
    if (k) all.set(k, (all.get(k) ?? 0) + 1)
  }
  const total = Math.max(1, allWords.length)
  const here = new Map<string, number>()
  for (const s of chapterWords) for (const w of s) {
    const k = key(w)
    if (k) here.set(k, (here.get(k) ?? 0) + 1)
  }
  const counts = (k: string): boolean => !!k && !stops.has(k) && graphemes(k).length >= 3
  // A word said once tells little of what the chapter is about: only words said again add.
  const weight = (k: string): number => (counts(k) && (here.get(k) ?? 0) >= 2 ? (here.get(k) ?? 0) * Math.log(total / Math.max(1, all.get(k) ?? 1) + 1) : 0)
  let best: { score: number; words: string[] } | null = null
  for (const sentence of chapterWords) {
    for (let i = 0; i < sentence.length; i++) {
      for (let n = 2; n <= 4 && i + n <= sentence.length; n++) {
        const run = sentence.slice(i, i + n)
        const keys = run.map(key)
        if (keys.some((k) => !k)) break
        if (stops.has(keys[0]) || stops.has(keys[n - 1]) || !counts(keys[0]) || !counts(keys[n - 1])) continue
        // A comma or stop inside the run splits it.
        if (run.slice(0, -1).some((w) => /[\p{P}]$/u.test(w) && !/['’]$/u.test(w))) break
        const score = keys.reduce((a, k) => a + weight(k), 0)
        // The highest; of equal ones the shorter, then the first said.
        if (score > EPS && (!best || score > best.score + EPS || (score > best.score - EPS && run.length < best.words.length))) best = { score, words: run }
      }
    }
  }
  if (!best) return null
  const text = best.words
    .map((w) => w.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, ''))
    .join(' ')
    .trim()
  return text ? sentenceCase(text, language ?? 'en') : null
}

/** The chapters' ranges (source seconds): from each start to the next chapter of any kind. */
function ranges(project: Project, starts: readonly number[]): { start: number; end: number }[] {
  const others = userChapters(project).map((c) => c.t)
  const all = [...new Set([...starts, ...others])].sort((a, b) => a - b)
  const end = project.duration
  return starts.map((t) => {
    const next = all.find((x) => x > t + EPS)
    return { start: t, end: next ?? end }
  })
}

/** The kept words of the transcript (masked as the subtitles say them), in order. */
function keptWords(project: Project): TranscriptWord[] {
  const words = captionsWords(spokenSegments(project))
  const cut = middlesCut(words, project.clips)
  return words.filter((_, i) => !cut[i])
}

/** The sentences of `words` as their words, with their start. */
function sentences(words: readonly TranscriptWord[]): { start: number; words: TranscriptWord[] }[] {
  return sentencesOf(words).map(([a, b]) => ({ start: words[a].start, words: words.slice(a, b + 1) }))
}

/**
 * The name of each found chapter starting at `starts` (source seconds, in order; `ai` an AI's
 * suggested title, §7.6.1), with where it came from (ChapterOrigin.name). The 0:00 chapter is the
 * one at the first kept time.
 */
export function chapterNames(project: Project, starts: readonly { t: number; ai?: string }[]): { title: string; name: ChapterOrigin['name'] }[] {
  const language = nameLanguage(project)
  const lang = project.transcript?.language
  const digits = project.captions?.digits ?? (language === 'bn' ? 'native' : undefined)
  const words = keptWords(project)
  const said = sentences(words)
  const allTexts = words.map((w) => w.text)
  const spans = ranges(
    project,
    starts.map((s) => s.t)
  )
  const cards = (project.titles ?? []).filter(userCard)
  const users = userChapters(project)
  const used = new Set(users.map((c) => cleanName(c.title).toLocaleLowerCase()))
  // Numbers by place among every chapter (the user's and these).
  const order = [...new Set([...users.map((c) => c.t), ...starts.map((s) => s.t)])].sort((a, b) => a - b)
  const firstKept = project.clips[0]?.start ?? 0
  const segs = spokenSegments(project)

  const take = (name: string | null): string | null => {
    if (!name) return null
    const clean = cleanName(name)
    if (!clean || privateLike(clean) || used.has(clean.toLocaleLowerCase())) return null
    return clean
  }

  return starts.map((s, i) => {
    const span = spans[i]
    const inside = said.filter((x) => x.start >= span.start - EPS && x.start < span.end - EPS)
    const first = inside.find((x) => x.start < span.start + FIRST_SENTENCE_S)
    const firstText = first ? first.words.map((w) => w.text).join(' ') : ''
    const choose = (): { title: string; name: ChapterOrigin['name'] } => {
      let title = s.ai !== undefined ? take(s.ai) : null
      if (title) return { title, name: 'ai' }
      // 1. A title card the user made starting within 3 s.
      const card = cards.find((c) => Math.abs(c.start - s.t) <= CHAPTER_RULES.cardNear + EPS)
      if ((title = take(card ? card.title : null))) return { title, name: 'card' }
      // 2. The first sentence, its cue words, fillers and lead-ins removed, cut at the clause.
      if ((title = take(firstText ? sentenceName(firstText, lang) : null))) return { title, name: 'sentence' }
      // 3. A phrase said in it, else the object said most often in it.
      if ((title = take(phraseName(inside.map((x) => x.words.map((w) => w.text)), allTexts, lang)))) return { title, name: 'phrase' }
      if ((title = take(mostSaidObject(segs, span, lang ?? 'en')))) return { title, name: 'phrase' }
      // 4. The first sentence, cut short.
      if ((title = take(firstText ? cutName(firstText) : null))) return { title, name: 'cut' }
      // 5. A number.
      const words = NUMBER_WORDS[language]
      const place = order.indexOf(s.t) + 1
      const number = Math.abs(s.t - firstKept) < EPS || place <= 1 ? words.intro : withDigits(`${words.part} ${place}`, digits, language)
      return { title: cleanName(number), name: 'number' }
    }
    const named = choose()
    used.add(named.title.toLocaleLowerCase())
    return named
  })
}

/** The object uiObjects finds most often in `span`'s captions, at least twice, with a capital. */
function mostSaidObject(segs: readonly CaptionSegment[], span: { start: number; end: number }, language: string): string | null {
  const counts = new Map<string, { n: number; text: string }>()
  const base = language.toLowerCase().split('-')[0]
  for (const seg of segs) {
    if (seg.end <= span.start || seg.start >= span.end) continue
    const tokens = studioTokens(seg, language)
    for (const i of uiObjects(tokens, base)) {
      const t = tokens[i]
      if (!t || t.start < span.start - EPS || t.start >= span.end) continue
      const k = key(t.text)
      if (!k) continue
      const prev = counts.get(k)
      counts.set(k, { n: (prev?.n ?? 0) + 1, text: prev?.text ?? t.text.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '') })
    }
  }
  let best: { n: number; text: string } | null = null
  for (const c of counts.values()) if (c.n >= OBJECT_MIN && (!best || c.n > best.n)) best = c
  return best ? sentenceCase(best.text, language) : null
}

/**
 * The `names` request for found chapters starting at `starts` (§7.6): per chapter with words, its
 * index as id and its kept narration (bleeped words masked), at most 1,500 characters from its
 * start. A chapter with no words is not sent: it keeps its offline name.
 */
export function namesRequestForChapters(project: Project, starts: readonly number[]): NamesRequest {
  const words = keptWords(project)
  const spans = ranges(project, starts)
  const items: NamesRequest['items'] = []
  spans.forEach((span, i) => {
    const text = words
      .filter((w) => w.start >= span.start - EPS && w.start < span.end - EPS)
      .map((w) => w.text)
      .join(' ')
      .trim()
    if (!text) return
    items.push({ id: String(i), text: graphemes(text).length > NARRATION_MAX ? graphemes(text).slice(0, NARRATION_MAX).join('') : text })
  })
  const language = project.transcript?.language
  return { kind: 'chapter', ...(language ? { language } : {}), items }
}

/**
 * The names an AI gave (§7.6) in place of the offline ones: each answer by its chapter's index,
 * kept when it is not empty, holds nothing private-like (whether or not it was said) and repeats no
 * other name; otherwise that chapter keeps its offline name. `ai` marks the ones taken.
 */
export function withAiNames(offline: readonly { title: string; name: ChapterOrigin['name'] }[], answer: readonly { id: string; name: string }[]): { title: string; name: ChapterOrigin['name']; ai: boolean }[] {
  const out = offline.map((n) => ({ ...n, ai: false }))
  const byIndex = new Map<number, string>()
  for (const a of answer) {
    const i = Number(a.id)
    if (Number.isInteger(i) && i >= 0 && i < out.length && !byIndex.has(i)) byIndex.set(i, a.name)
  }
  for (const [i, raw] of byIndex) {
    const name = cleanName(raw)
    if (!name || privateLike(name)) continue
    const taken = out.some((o, k) => k !== i && o.title.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (taken) continue
    out[i] = { title: name, name: 'ai', ai: true }
  }
  return out
}
