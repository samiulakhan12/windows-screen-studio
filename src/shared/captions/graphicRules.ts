/**
 * Generating graphics from captions (docs/design/captions-studio.md §10.2): one switch per kind,
 * density limits, ownership and ids made from content. Pure.
 *
 * A run deletes the automatic items of the kinds it makes (those whose switch is on) and makes them
 * again; items without `auto` (the user's, kept in Review, or edited) are never touched, and no new
 * graphic starts within 1.5 s of any graphic kept. Ids come from content, so a run that finds the
 * same things returns the same project object (§11.8).
 */
import type { MarksAnswer } from '../api/ai'
import { outputSize } from '../engine/layout'
import { isTall } from '../engine/reframeData'
import { GRAPHIC_DEFAULTS } from '../render/graphics'
import { viewingTime } from '../render/overlays'
import type { AiProviderKind, AutoOrigin, CaptionSegment, CounterGraphic, Graphic, KeywordGraphic, ListGraphic, Project, TitleCard } from '../types'
import { textHash, transcriptLanguage } from './captionTracks'
import { maskedSegments, wordsBleeped } from './cleanup'
import { chosenEmoji, isSensitive, LEAD, suggestEmoji } from './emoji'
import { emphasisScores } from './emphasis'
import { findLists } from './lists'
import { findNumbers } from './numbers'
import { GRAPHIC_TEXT_MAX, LIST_ITEM_MAX } from './studioData'
import { studioLayout } from './studioLayout'
import { studioTokens, studioWordTexts, type StudioToken } from './words'

/** The switches of §10.2; `marksVia` names the provider the AI marks came from (their items' `auto.via`). */
export type GraphicOptions = {
  keywords: boolean
  emoji: boolean
  counters: boolean
  lists: boolean
  speakers: boolean
  chapters: boolean
  quotes: boolean
  sound: 'none' | 'pop' | 'ding'
  marks?: MarksAnswer
  marksVia?: AiProviderKind
}

/** No graphic starts within this of another's start (§10.2). */
export const GRAPHIC_SPACING = 1.5
/** Nor within this after a pause freeze starts. */
const AFTER_FREEZE = 0.5
/** Graphics per minute of viewing time, tall frames and others. */
const PER_MINUTE = { tall: 8, other: 5 }
/** Keyword pop-ups: a score of at least this, one per 15 s, on a chunk of at least 0.6 s. */
const KEYWORD_SCORE = 4
const KEYWORD_EVERY = 15
const KEYWORD_CHUNK = 0.6
/** Lists: one per 60 s; the card ends 2 s after its last item. Quotes: one per 2 minutes, at most 6 s. */
const LIST_EVERY = 60
const LIST_TAIL = 2
const QUOTE_EVERY = 120
const QUOTE_MAX = 6
/** Lower thirds 3 s; chapter titles 2.5 s from 0.3 s after the chapter, none in the first 2 s, one per 30 s. */
const LOWER_THIRD = 3
const CHAPTER_LENGTH = 2.5
const CHAPTER_DELAY = 0.3
const CHAPTER_FIRST = 2
const CHAPTER_EVERY = 30
/** NW-09's default names: never a lower third. */
const DEFAULT_SPEAKER = /^(you|others|speaker\s*\d+)$/i

/** A generated item's id: 'g-' and the FNV-1a hash of kind, source, first word and text (§10.2). */
export function graphicId(kind: string, source: string, word: number, text: string): string {
  return `g-${textHash(`${kind}|${source}|${word}|${text}`)}`
}

/** The kind of automatic item each switch makes. */
const BY_OF_SWITCH = { keywords: 'keyword', emoji: 'emoji', counters: 'number', lists: 'list', speakers: 'speaker', chapters: 'chapter', quotes: 'quote' } as const

const trimText = (text: string, max: number): string => text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '').slice(0, max)
const graphemes = (s: string): number => [...s].length

/** The words of each caption with their times (studioTokens, labels left out). */
function wordsOf(seg: CaptionSegment, language: string | undefined): StudioToken[] {
  return studioTokens(seg, language).filter((t) => t.word >= 0)
}

/** Keyword pop-ups are made only for these chunk modes (§10.1): a *Phrases* chunk is too long to replace. */
const KEYWORD_CHUNKS = new Set(['words', 'word', 'stack'])

interface Candidate {
  item: Graphic
  /** Order of the kinds when they compete for room: counters, lists, keywords, emoji. */
  rank: number
  caption?: string
}

/** The project with the automatic graphics, lower thirds, chapter titles and quote cards made again. */
export function planGraphics(project: Project, opts: GraphicOptions): Project {
  const steps = planGraphicsSteps(project, opts)
  for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value
}

/** planGraphics a kind at a time, for a planner run with a moment between its steps (great.ts, §9.8). */
export function* planGraphicsSteps(project: Project, opts: GraphicOptions): Generator<void, Project, void> {
  const transcript = project.transcript
  const segments = transcript?.segments ?? []
  // Read as the captions read them (§0.2, §11.4): Bangla for a mostly Bangla transcript that names no
  // language, so its spelled-out numbers, lists, emphasis and sensitive topics take the Bangla rules.
  const language = transcriptLanguage(transcript)
  // Quote cards are made only from the provider's `marks` answer: asked without it, the ones made stay.
  const on = (by: AutoOrigin['by']): boolean =>
    (Object.keys(BY_OF_SWITCH) as (keyof typeof BY_OF_SWITCH)[]).some((k) => BY_OF_SWITCH[k] === by && opts[k] && (k !== 'quotes' || !!opts.marks))
  // Kept: the user's items, and automatic ones of kinds this run does not make.
  const keptGraphics = (project.graphics ?? []).filter((g) => !g.auto || !on(g.auto.by))
  const keptTitles = (project.titles ?? []).filter((c) => !c.auto || !on(c.auto.by))
  const via: AutoOrigin['via'] = 'rules'
  const aiVia: AutoOrigin['via'] = opts.marksVia ?? 'rules'
  const frame = outputSize(project.style.aspectRatio, project.width, project.height, 1080)
  const tall = isTall(frame.width, frame.height)
  const sensitive = new Set(segments.filter((s) => isSensitive(s.text, language)).map((s) => s.id))
  const byId = new Map(segments.map((s) => [s.id, s]))
  const sound = opts.sound === 'none' ? undefined : opts.sound
  const duration = project.duration > 0 ? project.duration : Infinity
  const base = (kind: Graphic['kind'], start: number, end: number, auto: AutoOrigin) => {
    const d = GRAPHIC_DEFAULTS[kind]
    return { start: Math.max(0, start), end: Math.min(duration, end), place: 'auto' as const, size: d.size, enter: { ...d.enter }, exit: { ...d.exit }, ...(sound ? { sound } : {}), auto }
  }
  const candidates: Candidate[] = []

  // Counters: statistics only (§11.4); the value is always read here.
  if (opts.counters)
    for (const seg of segments) {
      if (sensitive.has(seg.id)) continue
      const tokens = wordsOf(seg, language)
      for (const n of findNumbers(seg, language)) {
        if (!n.statistic) continue
        const t = tokens[n.from]
        if (!t) continue
        const digits = String(Math.round(Math.abs(n.value))).length
        const countFor = Math.max(1.2, Math.min(2.0, 0.3 * digits))
        const start = t.start - LEAD
        const text = `${n.prefix}${n.value}${n.suffix}`
        const item: CounterGraphic = {
          id: graphicId('counter', seg.id, n.from, text),
          kind: 'counter',
          ...base('counter', start, start + countFor + 1.0, { by: 'number', via, caption: seg.id }),
          from: n.start ?? 0,
          to: n.value,
          decimals: n.decimals,
          prefix: n.prefix.slice(0, 8),
          suffix: n.suffix.slice(0, 16),
          // A bleeped word is never readable (§11.7): not as the label either.
          ...(n.label && !wordsBleeped(project, { caption: seg.id, from: n.to + 1, to: n.to + 1 }) ? { label: n.label.slice(0, GRAPHIC_TEXT_MAX) } : {}),
          // Grouped as the captions are read: Bangla for a mostly Bangla transcript that names no language.
          locale: language || 'en',
          countFor
        }
        candidates.push({ item, rank: 0, caption: seg.id })
      }
    }
  yield

  // Lists: the AI's lists when it gave valid ones, else the offline finder; one per 60 s.
  if (opts.lists) {
    // A bleeped word is never readable (§11.7): the AI's lists skip it, the offline ones show it masked.
    const lists = aiLists(opts.marks, byId, language, (span) => wordsBleeped(project, span)) ?? findLists(maskedSegments(segments, project.bleeps), language)
    let lastList = -Infinity
    for (const l of lists) {
      const seg = byId.get(l.caption)
      if (!seg || sensitive.has(seg.id)) continue
      const start = seg.start - LEAD
      if (start - lastList < LIST_EVERY) continue
      const items = l.items.slice(0, 7).map((i) => ({ text: trimText(i.text, LIST_ITEM_MAX), at: i.at }))
      if (items.length < 2) continue
      lastList = start
      const end = items[items.length - 1].at + LIST_TAIL
      const title = trimText(l.title, GRAPHIC_TEXT_MAX)
      const item: ListGraphic = {
        id: graphicId('list', seg.id, 0, `${title}|${items.map((i) => i.text).join('|')}`),
        kind: 'list',
        ...base('list', start, end, { by: 'list', via: opts.marks?.lists.length ? aiVia : via, caption: seg.id }),
        ...(title ? { title } : {}),
        marker: 'number',
        items
      }
      candidates.push({ item, rank: 1, caption: seg.id })
    }
  }
  yield

  // Keyword pop-ups: only for looks of a few words, one word or stacked words (§10.1).
  const studio = project.captions?.studio
  if (opts.keywords && studio && KEYWORD_CHUNKS.has(studio.layout.chunk)) {
    const scores = emphasisScores(segments, { language, clips: project.clips })
    const best = scores.filter((s) => s.score >= KEYWORD_SCORE && !sensitive.has(s.caption)).sort((a, b) => b.score - a.score)
    const measure = (text: string, px: number): number => graphemes(text) * px * 0.55
    const face = { stack: 'sans-serif', weight: 700, tracking: 0 }
    const chunksOf = new Map<string, { start: number; end: number; first: number; last: number }[]>()
    // The picked starts, in time order (§9.8).
    const picked: number[] = []
    for (const s of best) {
      const seg = byId.get(s.caption)
      if (!seg) continue
      // Its chunks start within the caption (§8.2): one near a picked start all the time is not
      // laid out (most of a long project's are, at one pop-up per 15 s).
      if (nearThroughout(picked, seg.start, seg.end, KEYWORD_EVERY)) continue
      let chunks = chunksOf.get(seg.id)
      if (!chunks) {
        const layout = studioLayout(seg, studio, frame.width, frame.height, measure, { faceOf: () => face, language })
        chunks = layout.chunks.map((c) => ({ start: c.start, end: c.end, first: layout.tokens[c.first]?.word ?? 0, last: layout.tokens[c.last]?.word ?? 0 }))
        chunksOf.set(seg.id, chunks)
      }
      const chunk = chunks.find((c) => c.first <= s.word && s.word <= c.last)
      if (!chunk || chunk.end - chunk.start < KEYWORD_CHUNK) continue
      if (nearIn(picked, chunk.start, KEYWORD_EVERY)) continue
      // A bleeped word is never readable (§11.7): no pop-up shows it over the mask.
      if (wordsBleeped(project, { caption: seg.id, from: s.word, to: s.to })) continue
      const words = studioWordTexts(seg.text, language)
      const text = trimText(words.slice(s.word, s.to + 1).join(' '), GRAPHIC_TEXT_MAX)
      if (!text) continue
      insertSorted(picked, chunk.start)
      const d = GRAPHIC_DEFAULTS.keyword
      const item: KeywordGraphic = {
        id: graphicId('keyword', seg.id, s.word, text),
        kind: 'keyword',
        ...base('keyword', chunk.start, chunk.end, { by: 'keyword', via, caption: seg.id }),
        size: tall ? d.size * d.tall : d.size,
        text,
        look: 'card',
        anchor: { caption: seg.id, from: s.word, to: s.to, text: words.slice(s.word, s.to + 1).join(' ').slice(0, 80) }
      }
      candidates.push({ item, rank: 2, caption: seg.id })
    }
  }
  yield

  // Emoji: the AI's picks where it gave a listed emoji on a word, else the offline words (§11.3).
  if (opts.emoji) {
    const offline = suggestEmoji(project)
    const fromAi = aiEmoji(project, opts.marks, aiVia)
    const covered = new Set(fromAi.map((g) => g.auto?.caption))
    for (const item of [...fromAi, ...offline.filter((g) => !covered.has(g.auto?.caption))]) candidates.push({ item: sound ? { ...item, sound } : item, rank: 3, caption: item.auto?.caption })
  }
  yield

  // Density: spacing, pause freezes, a cap per minute of viewing time; the kept graphics count.
  const cap = tall ? PER_MINUTE.tall : PER_MINUTE.other
  const clock = (t: number): number => (project.clips.length ? viewingTime(project.clips, t) : t)
  const pauses = (project.freezes ?? []).filter((f) => f.sound === 'pause').map((f) => f.at)
  const accepted: Graphic[] = []
  // The starts in time order: a long project has thousands of candidates (§9.8).
  const starts: number[] = []
  for (const g of keptGraphics) insertSorted(starts, clock(g.start))
  candidates.sort((a, b) => a.rank - b.rank || a.item.start - b.item.start || (a.item.id < b.item.id ? -1 : 1))
  for (const c of candidates) {
    if (c.caption && sensitive.has(c.caption)) continue
    if (!(c.item.end - c.item.start > 0.05)) continue
    const at = clock(c.item.start)
    if (nearIn(starts, at, GRAPHIC_SPACING)) continue
    if (pauses.some((p) => c.item.start >= p && c.item.start - p < AFTER_FREEZE)) continue
    // Starts in the minute up to `at`, and in the minute from it.
    const before = firstWhere(starts, (s) => s > at) - firstWhere(starts, (s) => s > at - 60)
    const after = firstWhere(starts, (s) => s >= at + 60) - firstWhere(starts, (s) => s >= at)
    if (before >= cap || after >= cap) continue
    insertSorted(starts, at)
    accepted.push(c.item)
  }

  // Title cards: lower thirds for typed names, chapter titles, quote cards (never a sound).
  const titles: TitleCard[] = []
  if (opts.speakers) {
    const seen = new Set<string>()
    for (const seg of segments) {
      const name = seg.speaker?.trim()
      if (!name || seen.has(name.toLowerCase()) || DEFAULT_SPEAKER.test(name)) continue
      seen.add(name.toLowerCase())
      titles.push(titleCard('speaker', seg.id, name, seg.start, seg.start + LOWER_THIRD, 'lower-third', { by: 'speaker', via, caption: seg.id }, duration))
    }
  }
  if (opts.chapters) {
    let lastChapter = -Infinity
    for (const ch of [...(project.chapters ?? [])].sort((a, b) => a.t - b.t)) {
      if (ch.t < CHAPTER_FIRST || ch.t - lastChapter < CHAPTER_EVERY || !ch.title.trim()) continue
      lastChapter = ch.t
      const start = ch.t + CHAPTER_DELAY
      titles.push(titleCard('chapter', ch.id, ch.title.trim(), start, start + CHAPTER_LENGTH, 'lower-third', { by: 'chapter', via, chapter: ch.id }, duration))
    }
  }
  if (opts.quotes && opts.marks) {
    let lastQuote = -Infinity
    for (const q of opts.marks.quotes) {
      const seg = byId.get(q.id)
      if (!seg || sensitive.has(seg.id) || seg.start - lastQuote < QUOTE_EVERY || wordsBleeped(project, { caption: q.id, from: q.from, to: q.to })) continue
      const words = studioWordTexts(seg.text, language)
      const text = words.slice(q.from, q.to + 1).join(' ').trim()
      if (!text) continue
      lastQuote = seg.start
      const card = titleCard('quote', seg.id, text, seg.start, Math.min(seg.end + 0.5, seg.start + QUOTE_MAX), 'quote', { by: 'quote', via: aiVia, caption: seg.id }, duration)
      titles.push(seg.speaker && !DEFAULT_SPEAKER.test(seg.speaker) ? { ...card, subtitle: `— ${seg.speaker}` } : card)
    }
  }
  const keptTimes = keptTitles.filter((c) => c.style === 'lower-third' || c.style === 'quote').map((c) => c.start)
  const newTitles = titles.filter((c) => !keptTimes.some((t) => Math.abs(t - c.start) < GRAPHIC_SPACING) && c.end - c.start > 0.05)

  const graphics = sortGraphics([...keptGraphics, ...accepted])
  const titleCards = [...keptTitles, ...newTitles].sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return withItems(project, graphics, titleCards)
}

/** The first index of the sorted `list` from which `ok` holds (once it holds for a time, it holds for every later one). */
function firstWhere(list: readonly number[], ok: (t: number) => boolean): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ok(list[mid])) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Whether a time of the sorted `list` is less than `gap` from `at`: only the times near it are read. */
function nearIn(list: readonly number[], at: number, gap: number): boolean {
  for (let i = firstWhere(list, (t) => t >= at - 2 * gap); i < list.length && !(list[i] > at + 2 * gap); i++) if (Math.abs(list[i] - at) < gap) return true
  return false
}

/** Whether one time of the sorted `list` is less than `gap` from every time from `a` to `b`, with room for rounding. */
function nearThroughout(list: readonly number[], a: number, b: number, gap: number): boolean {
  const reach = gap - 0.01
  const i = firstWhere(list, (t) => t > Math.max(a, b) - reach)
  return i < list.length && list[i] < Math.min(a, b) + reach
}

/** `t` put in its place in the sorted `list`; a time that is not a number is near none and left out. */
function insertSorted(list: number[], t: number): void {
  if (!Number.isNaN(t)) list.splice(firstWhere(list, (u) => u > t), 0, t)
}

/** Graphics in time order, as the reader keeps them. */
function sortGraphics(list: Graphic[]): Graphic[] {
  return list.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** A lower third, chapter title or quote card made automatically. */
function titleCard(kind: string, source: string, title: string, start: number, end: number, style: TitleCard['style'], auto: AutoOrigin, duration: number): TitleCard {
  const text = title.replace(/\s+/g, ' ').slice(0, 200)
  return { id: graphicId(kind, source, 0, text), start: Math.max(0, start), end: Math.min(duration, end), title: text, style, background: 'blur', auto }
}

/** The project with these graphics and title cards, or the project itself when they are what it has. */
function withItems(project: Project, graphics: Graphic[], titleCards: TitleCard[]): Project {
  const sameGraphics = deepEqual(graphics, project.graphics ?? [])
  const sameTitles = deepEqual(titleCards, project.titles ?? [])
  if (sameGraphics && sameTitles) return project
  let next: Project = project
  if (!sameGraphics) {
    const { graphics: _g, ...rest } = next
    void _g
    next = graphics.length ? { ...rest, graphics } : (rest as Project)
  }
  if (!sameTitles) next = { ...next, titles: titleCards }
  return next
}

/** Lists from the AI's word spans, or null when it gave none usable (§11.2 rule 5); none with a bleeped word (`bleeped`). */
function aiLists(
  marks: MarksAnswer | undefined,
  byId: ReadonlyMap<string, CaptionSegment>,
  language: string | undefined,
  bleeped: (span: { caption: string; from: number; to: number }) => boolean
): { title: string; items: { text: string; at: number }[]; caption: string }[] | null {
  if (!marks?.lists.length) return null
  const out: { title: string; items: { text: string; at: number }[]; caption: string }[] = []
  for (const l of marks.lists) {
    const seg = byId.get(l.id)
    if (!seg || bleeped({ caption: l.id, from: l.from, to: l.to }) || l.items.some((it) => bleeped({ caption: it.id, from: it.from, to: it.to }))) continue
    const title = studioWordTexts(seg.text, language).slice(l.from, l.to + 1).join(' ')
    const items: { text: string; at: number }[] = []
    for (const it of l.items) {
      const s = byId.get(it.id)
      if (!s) continue
      const tokens = wordsOf(s, language)
      const words = tokens.slice(it.from, it.to + 1)
      if (!words.length) continue
      items.push({ text: words.map((w) => w.text).join(' '), at: words[0].start })
    }
    items.sort((a, b) => a.at - b.at)
    if (items.length >= 2 && items.length <= 7 && items[items.length - 1].at - seg.start <= 180) out.push({ title, items, caption: seg.id })
  }
  return out.length ? out : null
}

/** Emoji the AI picked on a word (already checked against the list), anchored like the offline ones. */
function aiEmoji(project: Project, marks: MarksAnswer | undefined, via: AutoOrigin['via']): Graphic[] {
  if (!marks) return []
  const transcript = project.transcript
  const language = transcriptLanguage(transcript)
  const byId = new Map((transcript?.segments ?? []).map((s) => [s.id, s]))
  const d = GRAPHIC_DEFAULTS.emoji
  const out: Graphic[] = []
  let last = -Infinity
  for (const c of marks.captions) {
    if (!c.emoji || c.emojiWord < 0) continue
    const seg = byId.get(c.id)
    if (!seg || isSensitive(seg.text, language)) continue
    const key = c.emoji
    if (!chosenEmoji(key)) continue
    const t = wordsOf(seg, language)[c.emojiWord]
    if (!t) continue
    const start = Math.max(0, t.start - LEAD)
    if (start - last < 8) continue
    last = start
    out.push({
      id: graphicId('emoji', seg.id, t.word, key),
      kind: 'emoji',
      emoji: key,
      start,
      end: Math.min(project.duration > 0 ? project.duration : Infinity, start + d.length),
      place: 'auto',
      size: d.size,
      enter: { ...d.enter },
      exit: { ...d.exit },
      anchor: { caption: seg.id, from: t.word, to: t.word, text: t.text.slice(0, 80) },
      auto: { by: 'emoji', via, caption: seg.id }
    })
  }
  return out
}

/** Structural equality of plain data (absent and undefined fields equal). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]))
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
