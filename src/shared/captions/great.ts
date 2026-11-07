/**
 * Make my captions great (docs/design/captions-studio.md §11.8): options, the planner (tidy,
 * style, emphasis, emoji, graphics; one update), its notice and the button's hint. Pure.
 *
 * The planner returns the input project itself when nothing changes: generated ids come from
 * content, so a second run that finds the same things adds no undo step (editStore skips an update
 * whose result is the previous state).
 */
import type { MarksAnswer } from '../api/ai'
import type { AiProviderKind, CaptionMark, CaptionStudio, CursorTrack, Graphic, Project, SfxRef } from '../types'
import { readSfxRef } from '../audio/soundFxData'
import { autoStyleSettings, cameraLed, frameShape } from './autoStyle'
import { tidyCaptions, type CleanupChoices, type WordListEntry } from './cleanup'
import { markId, pickEmphasis } from './emphasis'
import { deepEqual, planGraphicsSteps } from './graphicRules'
import { remapAnchors, withAutoTwin } from './marks'
import { studioPreset } from './studioPresets'
import { studioWordTexts } from './words'
import { userChapters } from '../chapters/pending'

/** A choice that can be resolved per project ('auto', §2.8). */
export type Auto = boolean | 'auto'

export interface GreatOptions {
  style: boolean
  emphasis: boolean
  /** 'auto': on in camera-led tall and square frames (§11.6). */
  emoji: Auto
  keywords: Auto
  /** 'auto': on in tall and square frames. */
  counters: Auto
  lists: Auto
  speakers: boolean
  /** 'auto': on in wide frames when the project has chapters. */
  chapters: Auto
  /** Needs a provider. */
  quotes: boolean
  tidy: boolean
  /** Sound given to the pop-ups this run makes: today's synthesised ones, or a library effect (editing polish §10.7). */
  sound: 'none' | 'pop' | 'ding' | SfxRef
  /** AI provider id, or null: on this PC only. */
  provider: string | null
}

/** The options with every 'auto' resolved for one project. */
export type ResolvedGreatOptions = Omit<GreatOptions, 'emoji' | 'keywords' | 'counters' | 'lists' | 'chapters'> & {
  emoji: boolean
  keywords: boolean
  counters: boolean
  lists: boolean
  chapters: boolean
}

/** What a run changed, for its notice (§2.8). */
export interface GreatSummary {
  /** The look's name when the style step changed it; null when it did not. */
  style: string | null
  emphasised: number
  emoji: number
  counters: number
  lists: number
  keywords: number
  lowerThirds: number
  chapters: number
  quotes: number
  /** Captions the tidy step changed. */
  tidied: number
  bleeped: number
  /** The AI provider could not be reached, so the picks were made on this PC. */
  providerFailed?: true
}

export const DEFAULT_GREAT_OPTIONS: Readonly<GreatOptions> = Object.freeze({
  style: true,
  emphasis: true,
  emoji: 'auto',
  keywords: 'auto',
  counters: 'auto',
  lists: 'auto',
  speakers: true,
  chapters: 'auto',
  quotes: false,
  tidy: true,
  sound: 'none',
  provider: null
})

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const flag = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const auto = (v: unknown, d: Auto): Auto => (v === 'auto' || typeof v === 'boolean' ? v : d)

/** Stored options with the defaults for anything missing or unknown. */
export function readGreatOptions(raw: unknown): GreatOptions {
  const o = isObj(raw) ? raw : {}
  const D = DEFAULT_GREAT_OPTIONS
  return {
    style: flag(o.style, D.style),
    emphasis: flag(o.emphasis, D.emphasis),
    emoji: auto(o.emoji, D.emoji),
    keywords: auto(o.keywords, D.keywords),
    counters: auto(o.counters, D.counters),
    lists: auto(o.lists, D.lists),
    speakers: flag(o.speakers, D.speakers),
    chapters: auto(o.chapters, D.chapters),
    quotes: flag(o.quotes, D.quotes),
    tidy: flag(o.tidy, D.tidy),
    // A library effect only when it is in the catalogue (editing polish §10.7).
    sound: o.sound === 'pop' || o.sound === 'ding' || o.sound === 'none' ? o.sound : (readSfxRef(o.sound) ?? D.sound),
    provider: typeof o.provider === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.provider) ? o.provider : null
  }
}

/** The options resolved for this project and frame (§2.8, §11.6). */
export function resolveGreatOptions(o: GreatOptions, project: Project, frame: { w: number; h: number }): ResolvedGreatOptions {
  const short = frameShape(frame) !== 'wide'
  let led: boolean | null = null
  const camera = (): boolean => (led ??= cameraLed(project, frame))
  const pick = (v: Auto, when: () => boolean): boolean => (v === 'auto' ? when() : v)
  return {
    ...o,
    emoji: pick(o.emoji, () => short && camera()),
    keywords: pick(o.keywords, () => short && camera()),
    counters: pick(o.counters, () => short),
    lists: pick(o.lists, () => short),
    // Auto: wide videos with chapters of the user's; found chapters waiting for review switch nothing on (smart-tools.md §7.7).
    chapters: pick(o.chapters, () => !short && userChapters(project).length > 0),
    quotes: o.quotes && o.provider !== null
  }
}

/** Emphasis marks from the AI's word indexes (already checked by validateMarksAnswer): a phrase or up to 2 words a caption. */
function aiMarks(project: Project, marks: MarksAnswer): CaptionMark[] {
  const segs = new Map((project.transcript?.segments ?? []).map((s) => [s.id, s]))
  const language = project.transcript?.language
  const out: CaptionMark[] = []
  for (const c of marks.captions) {
    const seg = segs.get(c.id)
    if (!seg || !c.emphasis.length) continue
    const words = studioWordTexts(seg.text, language)
    const idx = [...new Set(c.emphasis)].filter((i) => i >= 0 && i < words.length).sort((a, b) => a - b)
    // Adjacent indexes are one phrase.
    let from = idx[0]
    for (let k = 1; k <= idx.length; k++) {
      if (k < idx.length && idx[k] === idx[k - 1] + 1) continue
      const to = idx[k - 1]
      const text = words.slice(from, to + 1).join(' ').slice(0, 80)
      out.push({ id: markId(seg.id, from, text), caption: seg.id, from, to, text, auto: true })
      from = idx[k]
    }
  }
  return out
}

/** The marks in caption order, as the reader keeps them. */
function sortMarks(project: Project, marks: CaptionMark[]): CaptionMark[] {
  const order = new Map((project.transcript?.segments ?? []).map((s, i) => [s.id, i]))
  return marks.sort((a, b) => (order.get(a.caption) ?? 0) - (order.get(b.caption) ?? 0) || a.from - b.from)
}

/** Words inside auto marks (the notice's "38 words emphasised"). */
const markedWords = (marks: readonly CaptionMark[] | undefined): number => (marks ?? []).filter((m) => m.auto).reduce((n, m) => n + m.to - m.from + 1, 0)

/** What the planner plans from (§11.8). */
export interface GreatInput {
  project: Project
  frame: { w: number; h: number }
  brand?: CaptionStudio | null
  cleanup: CleanupChoices
  words: readonly WordListEntry[]
  /** The AI's picks; their word indexes name the captions as the tidy step leaves them (what greatRun asks on). */
  marks?: MarksAnswer
  by: 'great' | 'polish'
  /** The provider kind the AI marks came from (their items' `auto.via`). */
  marksVia?: AiProviderKind
  /** The marks came through a service (smart-tools.md §10.6): its host, carried by the AI picks' `auto`. */
  marksHost?: string
  /** The recording's cursor: words said near a click score more (§11.1). */
  cursor?: CursorTrack
}

/** The planner (§11.8): the input project itself when nothing changes. */
export function planCaptionsGreat(input: GreatInput, options: GreatOptions): { project: Project; summary: GreatSummary } {
  const steps = planCaptionsGreatSteps(input, options)
  for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value
}

/**
 * The planner a step at a time (tidy; style and emphasis; each kind of graphic): the editor runs it
 * with a moment between the steps, so it is never held for the whole plan (§9.8).
 */
export function* planCaptionsGreatSteps(input: GreatInput, options: GreatOptions): Generator<void, { project: Project; summary: GreatSummary }, void> {
  const start = input.project
  const o = resolveGreatOptions(options, start, input.frame)
  // Polish runs unattended on long tutorials: in wide frames only style, emphasis and tidy (§11.8).
  const wide = frameShape(input.frame) === 'wide'
  const graphicsOn = !(input.by === 'polish' && wide)
  const summary: GreatSummary = { style: null, emphasised: 0, emoji: 0, counters: 0, lists: 0, keywords: 0, lowerThirds: 0, chapters: 0, quotes: 0, tidied: 0, bleeped: 0 }
  let p = start
  if (!p.transcript?.segments.length) return { project: start, summary }

  // 1. Tidy: the saved Clean up choices, rules 1–4; bleeping only when the user turned it on.
  if (o.tidy) {
    const t = tidyCaptions(p, { ...input.cleanup, ai: false, words: input.words })
    // The marks and anchors there move onto the tidied words ("twenty five" is now "25"): the
    // steps below pick words of the tidied text, and the store's settle moves only what the input had.
    p = renewMovedMarks(remapAnchors(t.project, start), start)
    summary.tidied = t.changed
    summary.bleeped = t.bleeped
  }
  yield

  // 2. Style, recording the look before the first automatic change.
  if (o.style) {
    const s = autoStyleSettings(p, input.frame, input.brand)
    if (s && !deepEqual(s.settings, p.captions)) {
      const had = p.captionAuto?.style
      const was = had ? had.was : (p.captions ?? null)
      const name = s.tile === 'brand' ? 'Brand' : (studioPreset(s.tile)?.name ?? s.tile)
      // Speaker names the speakers rule turned on go with the look on Remove (also from an earlier run).
      const names = had?.names || (s.settings.showSpeaker === true && p.captions?.showSpeaker !== true)
      p = { ...p, captions: s.settings, captionAuto: { ...p.captionAuto, style: { was, by: input.by, name, ...(names ? { names: true as const } : {}) } } }
      summary.style = name
    }
  }

  // 3. Emphasis: the automatic marks made again (the user's kept); the Studio twin on a legacy look.
  if (o.emphasis) {
    const own = (p.captionMarks ?? []).filter((m) => !m.auto)
    const base: Project = own.length ? { ...p, captionMarks: own } : withoutMarks(p)
    const fromAi = input.marks ? aiMarks(base, input.marks).filter((m) => !own.some((u) => u.caption === m.caption)) : []
    const picks = fromAi.length ? fromAi : pickEmphasis(base, { cursor: input.cursor })
    const marks = sortMarks(p, [...own, ...picks])
    if (!deepEqual(marks, p.captionMarks ?? [])) p = marks.length ? { ...p, captionMarks: marks } : withoutMarks(p)
    if (picks.length) p = withAutoTwin(p)
  }

  yield

  // 4–5. Emoji and graphics.
  if (graphicsOn) {
    p = yield* planGraphicsSteps(p, {
      keywords: o.keywords,
      emoji: o.emoji,
      counters: o.counters,
      lists: o.lists,
      speakers: o.speakers,
      chapters: o.chapters,
      quotes: o.quotes && !!input.marks,
      sound: o.sound,
      ...(input.marks ? { marks: input.marks } : {}),
      ...(input.marksVia ? { marksVia: input.marksVia } : {}),
      ...(input.marksHost ? { marksHost: input.marksHost } : {})
    })
    // A keyword pop-up's words are never also emphasised (§10.1).
    const anchored = (p.graphics ?? []).filter((g): g is Extract<Graphic, { kind: 'keyword' }> => g.kind === 'keyword' && !!g.auto && !!g.anchor)
    if (anchored.length && p.captionMarks?.some((m) => m.auto)) {
      const marks = p.captionMarks.filter((m) => !m.auto || !anchored.some((g) => g.anchor!.caption === m.caption && g.anchor!.from <= m.to && m.from <= g.anchor!.to))
      if (marks.length !== p.captionMarks.length) p = marks.length ? { ...p, captionMarks: marks } : withoutMarks(p)
    }
  }

  summary.emphasised = markedWords(p.captionMarks)
  const autoGraphics = (p.graphics ?? []).filter((g) => g.auto)
  summary.emoji = autoGraphics.filter((g) => g.kind === 'emoji').length
  summary.counters = autoGraphics.filter((g) => g.kind === 'counter').length
  summary.lists = autoGraphics.filter((g) => g.kind === 'list').length
  summary.keywords = autoGraphics.filter((g) => g.kind === 'keyword').length
  const autoTitles = (p.titles ?? []).filter((c) => c.auto)
  summary.lowerThirds = autoTitles.filter((c) => c.auto?.by === 'speaker').length
  summary.chapters = autoTitles.filter((c) => c.auto?.by === 'chapter').length
  summary.quotes = autoTitles.filter((c) => c.auto?.by === 'quote').length
  return { project: deepEqual(p, start) ? start : p, summary }
}

/**
 * The automatic marks the tidy moved, under new ids from their new words. The store's settle reads
 * a mark that kept its id and `auto` but changed as a hand edit (§11.8 rule 3); a new id is
 * automation's own change, so the mark stays automatic.
 */
function renewMovedMarks(p: Project, start: Project): Project {
  const was = new Map((start.captionMarks ?? []).map((m) => [m.id, m]))
  const moved = (m: CaptionMark): boolean => !!m.auto && was.has(m.id) && !deepEqual(was.get(m.id), m)
  if (!p.captionMarks?.some(moved)) return p
  const taken = new Set([...was.keys(), ...p.captionMarks.map((m) => m.id)])
  const captionMarks = p.captionMarks.map((m) => {
    if (!moved(m)) return m
    const base = markId(m.caption, m.from, m.text)
    let id = base
    for (let k = 2; taken.has(id); k++) id = `${base}~${k}`
    taken.add(id)
    return { ...m, id }
  })
  return { ...p, captionMarks }
}

function withoutMarks(p: Project): Project {
  const { captionMarks: _m, ...rest } = p
  void _m
  return rest
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * "Captions: Bold Pop, 38 words emphasised, 3 emoji, 1 counter, 1 list" followed by `review`
 * (reviewHint: ". Review (Shift + R)") and `undo` (undoHint: " · Ctrl + Z to undo"), §2.8.
 */
export function greatNotice(s: GreatSummary, undo = '', review = ''): string {
  const parts: string[] = []
  if (s.style) parts.push(s.style)
  if (s.emphasised) parts.push(`${plural(s.emphasised, 'word')} emphasised`)
  if (s.emoji) parts.push(`${s.emoji} emoji`)
  if (s.keywords) parts.push(plural(s.keywords, 'pop-up'))
  if (s.counters) parts.push(plural(s.counters, 'counter'))
  if (s.lists) parts.push(plural(s.lists, 'list'))
  if (s.lowerThirds) parts.push(plural(s.lowerThirds, 'lower third'))
  if (s.chapters) parts.push(plural(s.chapters, 'chapter title'))
  if (s.quotes) parts.push(plural(s.quotes, 'quote card'))
  if (s.tidied) parts.push(`${plural(s.tidied, 'caption')} tidied`)
  if (s.bleeped) parts.push(`${plural(s.bleeped, 'word')} bleeped`)
  const failed = s.providerFailed ? ' The AI provider could not be reached, so Flown picked on this PC.' : ''
  if (!parts.length) return `Your captions already have all of this.${failed}`
  return `Captions: ${parts.join(', ')}${review}${undo}${failed ? `.${failed}` : ''}`
}

/** The hint under the button, from the resolved options (§2.4). */
export function greatHint(o: ResolvedGreatOptions): string {
  const parts: string[] = []
  if (o.style) parts.push("a style for this video's shape")
  if (o.emphasis) parts.push('key words')
  if (o.emoji) parts.push('emoji')
  if (o.keywords) parts.push('keyword pop-ups')
  if (o.counters) parts.push('counters')
  if (o.lists) parts.push('list cards')
  if (o.speakers) parts.push('speaker names')
  if (o.chapters) parts.push('chapter titles')
  if (o.quotes) parts.push('quote cards')
  const tidy = o.tidy ? 'tidies the text' : ''
  if (!parts.length) return tidy ? `Tidies the text.` : 'Choose what it does in its options.'
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return tidy ? `Adds ${list}, and ${tidy}.` : `Adds ${list}.`
}
