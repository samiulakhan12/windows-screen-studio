/**
 * The words of a guide's steps (docs/design/smart-tools.md §5.2–§5.4): each step's title without AI
 * (from the narration, the key pressed, the sentence said after it, the cursor, the taskbar, the
 * place on the screen, or a number), the note under it from what was said, and what the
 * `names` text task sends for AI titles and tidied notes (the step's action and the words said near
 * it, never a screenshot, a file name or a window title).
 *
 * Words are the captions as the video says them: cut words out, bleeped words masked
 * (spokenSegments). Times are source seconds. Pure; the word lists are memoised per transcript,
 * clips and bleeps.
 */
import type { NamesRequest } from '../api/ai'
import { transcriptLanguage } from '../captions/captionTracks'
import { emphasisKey, uiObjects } from '../captions/emphasis'
import { STOP_WORDS } from '../captions/stopWords'
import { spokenSegments } from '../captions/subtitles'
import { studioTokens, type StudioToken } from '../captions/words'
import { findFillers } from '../editor/fillers'
import { findRetakes, sentencesOf } from '../editor/retakes'
import { captionsWords, cutFlags, type TranscriptWord } from '../editor/transcript'
import { cutName, sentenceName } from '../smart/sentenceName'
import { privateLike } from '../smart/privateText'
import type { CaptionSegment, CaptureInfo, GuideStepEdit, Project } from '../types'
import { fill, GUIDE_WORDS, guideDigits, guideLanguage, guideNumber, placeIn, type GuideWords } from './guideWords'
import type { GuideStep } from './steps'

export type TitleFrom = 'narration' | 'keys' | 'sentence' | 'cut' | 'cursor' | 'taskbar' | 'place' | 'template'

/** Seconds of narration a title is looked for in, around the step (§5.2 rule 1). */
const TITLE_BEFORE = 2.5
const TITLE_AFTER = 1.0
/** Seconds after a screen, badge or added step its sentence may start (rule 3). */
const SENTENCE_WITHIN = 10
/** Longest object, in graphemes; longest run of capitalised words. */
const OBJECT_MAX = 40
const NAME_WORDS = 3
/** The bottom of a whole-screen recording the taskbar takes, px at 100% (rule 5). */
const TASKBAR_PX = 48
/** The short note (§5.4): words from this long after the step before to this long after the step. */
const NOTE_AFTER_PREV = 0.5
const NOTE_AFTER = 1.0
const NOTE_MAX = 300
const NOTE_SENTENCES = 2
const FULL_MAX = 1000
/** What Write titles sends (§5.3): the words from 6 s before to 2 s after, at most 600 characters. */
const SEND_BEFORE = 6
const SEND_AFTER = 2
const SEND_MAX = 600
/** The longest action the names task takes (AI_LIMITS.names.action). */
const ACTION_MAX = 80

/** Words naming a kind of control, skipped to reach the control's own name (rule 1, Bangla and Hindi). */
const GENERIC: Readonly<Record<string, ReadonlySet<string>>> = {
  bn: new Set(['বোতামে', 'বাটনে', 'মেনুতে', 'অপশনে', 'ট্যাবে', 'লিংকে', 'বোতাম', 'বাটন', 'মেনু', 'অপশন', 'ট্যাব', 'লিংক']),
  hi: new Set(['बटन', 'मेनू', 'ऑप्शन', 'टैब', 'लिंक', 'पर'])
}
/** English words that name a kind of control, never the control's own name ("click the button"). */
const GENERIC_EN = new Set(['button', 'menu', 'option', 'tab', 'link', 'icon', 'field', 'box', 'here', 'there', 'it', 'them', 'one', 'that', 'this', 'thing'])
/** A case ending written after a hyphen ("Export-এ"). */
const CASE_ENDING = /^(.+?)[-‐‑](?:[\p{Script=Bengali}\p{Script=Devanagari}][\p{M}\p{L}]*)$/u
/** Quotes and punctuation around a word. */
const AROUND = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu
const LATIN_CAPITAL = /^\p{Lu}/u

const graphemeCount = (text: string): number => {
  let n = 0
  for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++
  return n
}

/** The base of a language code ("bn-BD" → "bn"). */
const baseOf = (language?: string): string => (language ?? '').toLowerCase().split('-')[0]

/* ---------- the words said ---------- */

interface Spoken {
  /** Every spoken word (bleeped ones masked), in order. */
  words: TranscriptWord[]
  /** Whether each is cut from the video. */
  cut: boolean[]
  /** The captions as the video says them, cut words left out. */
  segments: CaptionSegment[]
}

const spokenMemo = new WeakMap<object, { clips: Project['clips']; bleeps: Project['bleeps']; out: Spoken }>()
const NO_TRANSCRIPT = {}

function spokenOf(project: Pick<Project, 'transcript' | 'clips' | 'bleeps'>): Spoken {
  const key = project.transcript ?? NO_TRANSCRIPT
  const hit = spokenMemo.get(key)
  if (hit && hit.clips === project.clips && hit.bleeps === project.bleeps) return hit.out
  const words = captionsWords([...spokenSegments(project)])
  const cut = cutFlags(words, project.clips)
  const byCaption = new Map<string, TranscriptWord[]>()
  words.forEach((w, i) => {
    if (cut[i]) return
    const list = byCaption.get(w.caption)
    if (list) list.push(w)
    else byCaption.set(w.caption, [w])
  })
  const segments: CaptionSegment[] = []
  for (const seg of spokenSegments(project)) {
    const kept = byCaption.get(seg.id)
    if (!kept?.length) continue
    segments.push({
      id: seg.id,
      start: kept[0].start,
      end: kept[kept.length - 1].end,
      text: kept.map((w) => w.text).join(' '),
      words: kept.map((w) => ({ text: w.text, start: w.start, end: w.end }))
    })
  }
  const out = { words, cut, segments }
  spokenMemo.set(key, { clips: project.clips, bleeps: project.bleeps, out })
  return out
}

/** The captions as the guide reads them (§5.2): the spoken captions with cut words left out and bleeped words masked. */
export function guideSegments(project: Pick<Project, 'transcript' | 'clips' | 'bleeps'>): CaptionSegment[] {
  return spokenOf(project).segments
}

/** Kept words whose start lies in [from, to], in order, as text joined by spaces. */
function keptWordsIn(project: Pick<Project, 'transcript' | 'clips' | 'bleeps'>, from: number, to: number): TranscriptWord[] {
  const { words, cut } = spokenOf(project)
  return words.filter((w, i) => !cut[i] && w.start >= from - 1e-6 && w.start <= to + 1e-6)
}

/** `text` cut to at most `max` characters at a word boundary. */
function cutChars(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max + 1)
  const space = head.lastIndexOf(' ')
  return (space > 0 ? head.slice(0, space) : Array.from(text.slice(0, max)).join('')).trim()
}

/* ---------- rule 1: the narration ---------- */

/** The language uiObjects reads: 'bn', 'hi', else English. */
const uiLanguage = (language?: string): string => {
  const base = baseOf(language)
  return base === 'bn' || base === 'hi' ? base : 'en'
}

/** The tokens of a caption that are words (no speaker label). */
const wordTokens = (seg: CaptionSegment, language?: string): StudioToken[] => studioTokens(seg, language).filter((t) => t.word >= 0)

/** The object at `k` as a name: a run of up to 3 capitalised words in Latin, a case ending after a hyphen removed; null when refused. */
function objectName(tokens: readonly StudioToken[], k: number, language: string): string | null {
  const ui = uiLanguage(language)
  const clean = (text: string): string => text.replace(AROUND, '')
  let name = clean(tokens[k].text)
  if (LATIN_CAPITAL.test(name)) {
    let n = 1
    for (let j = k + 1; j < tokens.length && n < NAME_WORDS; j++, n++) {
      if (/[\p{P}]$/u.test(tokens[j - 1].text) && !/['’]$/u.test(tokens[j - 1].text)) break
      const next = clean(tokens[j].text)
      if (!LATIN_CAPITAL.test(next)) break
      name += ` ${next}`
    }
  }
  const ending = name.match(CASE_ENDING)
  if (ending) name = ending[1]
  name = name.replace(AROUND, '')
  if (!name || /^[\p{Nd}\s.,]+$/u.test(name) || graphemeCount(name) > OBJECT_MAX || privateLike(name)) return null
  const key = emphasisKey(name)
  const stop = STOP_WORDS[ui] ?? STOP_WORDS.en
  if (!key || stop.has(key) || (ui === 'en' && GENERIC_EN.has(key)) || GENERIC[ui]?.has(name)) return null
  return name
}

/**
 * The control named nearest the step's time in the words said from 2.5 s before it to 1 s after:
 * the object of a button or menu verb (English) or the word before a polite command (Bangla, Hindi),
 * skipping a word for the kind of control and a case ending after a hyphen. Null when none is said.
 */
export function narrationObject(t: number, segments: readonly CaptionSegment[], language?: string): string | null {
  const ui = uiLanguage(language)
  const from = t - TITLE_BEFORE
  const to = t + TITLE_AFTER
  let best: { name: string; d: number } | null = null
  for (const seg of segments) {
    if (seg.end < from - 1 || seg.start > to + 1) continue
    const tokens = wordTokens(seg, language)
    for (const found of uiObjects(tokens, ui)) {
      let k = found
      // Bangla and Hindi: a word for the kind of control ("বোতামে", "बटन पर") comes after the name.
      if (GENERIC[ui]) while (k > 0 && GENERIC[ui].has(tokens[k].text.replace(AROUND, ''))) k--
      const at = tokens[k].start
      if (at < from - 1e-6 || at > to + 1e-6) continue
      const name = objectName(tokens, k, language ?? ui)
      if (!name) continue
      const d = Math.abs(at - t)
      if (!best || d < best.d) best = { name, d }
    }
  }
  return best?.name ?? null
}

/* ---------- rule 3: the sentence said after ---------- */

/** The words said from `t` on (at most SENTENCE_WITHIN later), as one text in order. */
function sentenceAfter(t: number, segments: readonly CaptionSegment[], language?: string): string {
  const parts: string[] = []
  let started = false
  for (const seg of segments) {
    if (seg.end < t - 0.3) continue
    for (const tok of wordTokens(seg, language)) {
      if (!started && (tok.start < t - 0.3 || tok.start > t + SENTENCE_WITHIN)) continue
      started = true
      parts.push((parts.length && tok.gap ? ' ' : '') + tok.text)
      if (parts.length >= 60) return parts.join('')
    }
    if (started && parts.length) parts.push(' ')
  }
  return parts.join('').trim()
}

/* ---------- titles ---------- */

/** The first letter in lower case when it is a Latin capital ("Click" → "click"), for "Scroll down, then click …". */
function lowerFirst(text: string): string {
  const first = Array.from(text)[0] ?? ''
  return /\p{Script=Latin}/u.test(first) ? first.toLowerCase() + text.slice(first.length) : text
}

/** A title with what the step adds to its action: repeats, typing, the key after it, the scroll before it. */
function decorate(title: string, step: GuideStep, w: GuideWords, num: (n: number) => string): string {
  let out = title
  if (step.times && step.times > 1) out = fill(w.times, { title: out, n: num(step.times) })
  if (step.typing && step.kind !== 'type') out = fill(w.andType, { title: out })
  if (step.then) out = fill(w.andPress, { title: out, key: step.then })
  if (step.scroll) out = fill(w.scrollThen, { way: w.ways[step.scroll], title: lowerFirst(out) })
  return out
}

const NAMED: Partial<Record<GuideStep['kind'], keyof GuideWords>> = { click: 'click', double: 'double', right: 'right', middle: 'middle', drag: 'drag' }
const NEAR: Partial<Record<GuideStep['kind'], keyof GuideWords>> = { click: 'clickNear', double: 'doubleNear', right: 'rightNear', middle: 'middleNear' }

/**
 * The step's title without AI and where it came from (§5.2), the first rule that gives one: the
 * narration, the key pressed, the sentence said after a screen, badge or added step (or that
 * sentence cut short), the cursor's shape, the taskbar, the place on the screen, a number. `n` is
 * the step's number as shown ("3", "৩", "3.1") for the template.
 */
export function stepTitle(
  step: GuideStep,
  ctx: {
    segments: readonly CaptionSegment[]
    language: 'en' | 'bn'
    transcriptLanguage?: string
    digits?: 'native' | 'western'
    target: CaptureInfo['target']
    scale: number
    height: number
    element?: { name: string; role: string } | null
    n?: string
  }
): { title: string; from: TitleFrom } {
  const w = GUIDE_WORDS[ctx.language]
  const num = (n: number): string => guideNumber(n, ctx.language, ctx.digits ?? 'western')
  const template = (): { title: string; from: TitleFrom } => ({ title: fill(w.step, { n: ctx.n ?? step.badge?.label ?? '' }).trim(), from: 'template' })

  if (step.kind === 'keys') return { title: decorate(fill(w.press, { keys: step.keys ?? '' }), step, w, num), from: 'keys' }

  if (step.kind === 'screen' || step.kind === 'badge' || step.kind === 'added') {
    const text = sentenceAfter(step.t, ctx.segments, ctx.transcriptLanguage)
    const sentence = text ? sentenceName(text, ctx.transcriptLanguage) : null
    if (sentence) return { title: sentence, from: 'sentence' }
    const cut = text ? cutName(text) : null
    if (cut) return { title: cut, from: 'cut' }
    return template()
  }

  if (step.kind === 'type') return { title: decorate(w.typeText, step, w, num), from: 'place' }

  // Rule 1: what was said.
  const named = NAMED[step.kind]
  const object = ctx.element?.name || narrationObject(step.t, ctx.segments, ctx.transcriptLanguage)
  if (named && object) return { title: decorate(fill(w[named], { x: object }), step, w, num), from: 'narration' }

  const x = step.x ?? 0.5
  const y = step.y ?? 0.5
  const place = placeIn(x, y)
  if (step.kind === 'drag') {
    const to = step.to ?? { x, y }
    return { title: decorate(fill(w.dragFromTo, { a: w.places[place], b: w.places[placeIn(to.x, to.y)] }), step, w, num), from: 'place' }
  }
  // Rule 4: the cursor's shape at the press (native capture).
  if (step.kind === 'click' && (step.shape === 'text' || step.shape === 'pointer')) {
    return { title: decorate(fill(step.shape === 'text' ? w.clickText : w.clickLink, { place: w.places[place] }), step, w, num), from: 'cursor' }
  }
  // Rule 5: the taskbar of a whole-screen recording.
  const scale = ctx.scale > 0 ? ctx.scale : 1
  if (step.kind === 'click' && ctx.target === 'screen' && ctx.height > 0 && y * ctx.height >= ctx.height - TASKBAR_PX * scale - 1e-6) {
    const side = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'middle'
    return { title: decorate(fill(w.taskbar, { side: w.sides[side] }), step, w, num), from: 'taskbar' }
  }
  // Rule 6: where on the screen.
  const near = NEAR[step.kind]
  if (near) return { title: decorate(fill(w[near], { near: w.near[place], place: w.places[place] }), step, w, num), from: 'place' }
  return template()
}

/** Whether a title from `from` is a placeholder (the row shows *Needs a title*). */
export function needsTitle(from: TitleFrom): boolean {
  return from === 'cut' || from === 'cursor' || from === 'taskbar' || from === 'place' || from === 'template'
}

/** What a capture's `target` is when the project does not say (older projects). */
export function captureTarget(capture: CaptureInfo | undefined): CaptureInfo['target'] {
  return capture?.target ?? (capture?.region ? 'area' : 'screen')
}

/** A step's title as the guide shows it, from its edit, the step added by hand, or stepTitle. */
export interface ShownTitle {
  title: string
  from: TitleFrom
  /** Typed by the user or written by an AI: never a placeholder. */
  own: boolean
  /** Written by an AI and not edited since. */
  ai?: GuideStepEdit['ai']
}

/**
 * The title each step shows (§2.1.1): the edit's title (typed, or an AI's), an added step's own
 * title (unless it is the default "Step"), else stepTitle with the step's number `ns[i]`.
 */
export function shownTitles(project: Project, steps: readonly GuideStep[], ns: readonly string[], opts: { scale?: number } = {}): ShownTitle[] {
  const language = guideLanguage(project)
  const digits = guideDigits(project, language)
  const edits = new Map((project.guide?.steps ?? []).map((e) => [e.key, e]))
  const added = new Map((project.guide?.added ?? []).map((a) => [a.key, a]))
  const ctx = {
    segments: guideSegments(project),
    language,
    transcriptLanguage: transcriptLanguage(project.transcript),
    digits,
    target: captureTarget(project.capture),
    scale: opts.scale ?? 1,
    height: project.height
  }
  const defaults = new Set([GUIDE_WORDS.en.step.replace(' {n}', ''), GUIDE_WORDS.bn.step.replace(' {n}', ''), ''])
  return steps.map((s, i) => {
    const edit = edits.get(s.key)
    if (edit?.title !== undefined && edit.title.trim()) return { title: edit.title, from: 'narration' as const, own: true, ...(edit.ai ? { ai: edit.ai } : {}) }
    const own = added.get(s.key)
    if (own && !defaults.has(own.title.trim())) return { title: own.title, from: 'narration' as const, own: true }
    const t = stepTitle(s, { ...ctx, n: ns[i] })
    return { ...t, own: false }
  })
}

/* ---------- §5.4 the note ---------- */

/** The word span of the sentence the step's title came from, or null (a title from the narration or the sentence after). */
function titleSentence(step: GuideStep, project: Project, words: readonly TranscriptWord[], cut: readonly boolean[], spans: readonly (readonly [number, number])[]): readonly [number, number] | null {
  const language = transcriptLanguage(project.transcript)
  const segments = guideSegments(project)
  if (step.kind === 'screen' || step.kind === 'badge' || step.kind === 'added') {
    const first = words.findIndex((w, i) => !cut[i] && w.start >= step.t - 0.3 && w.start <= step.t + SENTENCE_WITHIN)
    if (first < 0 || !sentenceName(sentenceAfter(step.t, segments, language), language)) return null
    return spans.find(([a, b]) => first >= a && first <= b) ?? null
  }
  const object = narrationObject(step.t, segments, language)
  if (!object) return null
  const head = object.split(' ')[0]
  let best: { i: number; d: number } | null = null
  words.forEach((w, i) => {
    if (cut[i] || w.start < step.t - TITLE_BEFORE - 1e-6 || w.start > step.t + TITLE_AFTER + 1e-6) return
    if (!w.text.replace(AROUND, '').startsWith(head.replace(AROUND, ''))) return
    const d = Math.abs(w.start - step.t)
    if (!best || d < best.d) best = { i, d }
  })
  if (!best) return null
  const at = (best as { i: number }).i
  return spans.find(([a, b]) => at >= a && at <= b) ?? null
}

/** Whole sentences of `groups` (each a list of words) joined, at most `max` characters and `count` sentences, ending at a sentence's end. */
function wholeSentences(groups: readonly string[][], max: number, count: number): string {
  let out = ''
  let n = 0
  for (const g of groups) {
    if (n >= count) break
    const text = g.join(' ').trim()
    if (!text) continue
    const next = out ? `${out} ${text}` : text
    if (next.length > max) {
      if (!out) out = `${cutChars(text, max - 1)}…`
      break
    }
    out = next
    n++
  }
  return out
}

/**
 * The note under step `i` (§5.4). The short note: the words said from 0.5 s after the step before
 * (the start for the first) to 1 s after this step, whole sentences that start there, without
 * fillers, the earlier takes of retakes and the sentence the title came from; the first two, at
 * most 300 characters. With `full`: every kept word of those sentences, at most 1,000 characters.
 * Cut words are left out and bleeped words masked in both.
 */
export function stepText(steps: readonly GuideStep[], i: number, project: Project, full: boolean): string {
  const step = steps[i]
  if (!step) return ''
  const { words, cut } = spokenOf(project)
  if (!words.length) return ''
  const prev = steps[i - 1]
  const from = prev ? prev.t + NOTE_AFTER_PREV : -Infinity
  const to = step.t + NOTE_AFTER
  const spans = sentencesOf(words)
  const drop = new Array<boolean>(words.length).fill(false)
  if (!full) {
    const language = transcriptLanguage(project.transcript)
    for (const [a, b] of findFillers(words, language)) for (let k = a; k <= b; k++) drop[k] = true
    for (const m of findRetakes(words, language)) for (let k = m.span[0]; k <= m.span[1]; k++) drop[k] = true
    const own = titleSentence(step, project, words, cut, spans)
    if (own) for (let k = own[0]; k <= own[1]; k++) drop[k] = true
  }
  const groups: string[][] = []
  for (const [a, b] of spans) {
    // A whole sentence: its first kept word starts inside the window.
    let first = -1
    for (let k = a; k <= b; k++) if (!cut[k]) {
      first = k
      break
    }
    if (first < 0 || words[first].start < from - 1e-6 || words[first].start > to + 1e-6) continue
    const g: string[] = []
    for (let k = a; k <= b; k++) if (!cut[k] && !drop[k]) g.push(words[k].text)
    if (g.length) groups.push(g)
  }
  return full ? wholeSentences(groups, FULL_MAX, Infinity) : wholeSentences(groups, NOTE_MAX, NOTE_SENTENCES)
}

/** The words said from 6 s before the step to 2 s after it, kept and masked, at most 600 characters (§5.3). */
export function stepNarration(step: GuideStep, project: Project): string {
  return cutChars(keptWordsIn(project, step.t - SEND_BEFORE, step.t + SEND_AFTER).map((w) => w.text).join(' '), SEND_MAX)
}

/* ---------- §5.3 what Write titles sends ---------- */

/** The step's action in English words for the names task ("click, top right of the screen", "press Ctrl + S"), at most 80 characters. */
export function stepAction(step: GuideStep): string {
  let out: string
  switch (step.kind) {
    case 'click':
    case 'double':
    case 'right':
    case 'middle': {
      const verb = step.kind === 'click' ? 'click' : step.kind === 'double' ? 'double-click' : `${step.kind}-click`
      const place = placeIn(step.x ?? 0.5, step.y ?? 0.5)
      out = step.typing ? `type after ${step.kind === 'click' ? 'clicking' : `a ${verb}`} near the ${place}` : `${verb}, ${place} of the screen`
      if (step.times && step.times > 1) out += `, ${step.times} times`
      break
    }
    case 'drag':
      out = `drag from the ${placeIn(step.x ?? 0.5, step.y ?? 0.5)} to the ${placeIn(step.to?.x ?? 0.5, step.to?.y ?? 0.5)} of the screen`
      break
    case 'type':
      out = 'type'
      break
    case 'keys':
      out = `press ${step.keys ?? ''}${step.times && step.times > 1 ? `, ${step.times} times` : ''}`
      break
    case 'screen':
      out = 'the screen changes'
      break
    case 'badge':
      out = 'a numbered step badge'
      break
    default:
      out = 'a step added by hand'
  }
  if (step.then) out += `, then press ${step.then}`
  if (step.scroll) out = `scroll ${step.scroll}, then ${out}`
  return Array.from(out).slice(0, ACTION_MAX).join('')
}

/** Whether the step is in the guide: not hidden, and not hidden by default unless included. */
export function stepIncluded(step: GuideStep, edit: GuideStepEdit | undefined): boolean {
  if (edit?.hidden) return false
  return !step.hiddenByDefault || edit?.shown === true
}

/**
 * The `names` request of Write titles (`kind: 'step'`) or Tidy notes (`'note'`), §5.3 and §5.4.
 * Titles: each included step not edited by hand (an AI's title may be written again) that has words
 * near it: its key, its action and up to 600 characters of what was said. Notes: each included step
 * with words since the step before: its full words (up to 1,000 characters) and its title as the
 * action. Nothing else: no screenshot, no file name, no window title.
 */
export function namesRequestForSteps(project: Project, steps: readonly GuideStep[], kind: 'step' | 'note'): NamesRequest {
  const language = transcriptLanguage(project.transcript)
  const edits = new Map((project.guide?.steps ?? []).map((e) => [e.key, e]))
  const items: NamesRequest['items'] = []
  const titles = kind === 'note' ? shownTitles(project, steps, steps.map((_, i) => String(i + 1))) : []
  steps.forEach((s, i) => {
    const edit = edits.get(s.key)
    if (!stepIncluded(s, edit)) return
    if (kind === 'step') {
      if (edit?.title !== undefined && !edit.ai) return
      if (s.kind === 'added') return
      const text = stepNarration(s, project)
      if (!text.trim()) return
      items.push({ id: s.key, text, action: stepAction(s) })
      return
    }
    const text = stepText(steps, i, project, true)
    if (!text.trim()) return
    items.push({ id: s.key, text, action: Array.from(titles[i].title).slice(0, ACTION_MAX).join('') })
  })
  return { kind, ...(language ? { language } : {}), items }
}
