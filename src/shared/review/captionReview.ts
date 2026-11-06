/**
 * Review mode's rows for Captions Studio's automatic changes (docs/design/captions-studio.md §11.8,
 * §2.8): the look Make my captions great or Polish picked (`style`), the automatic emphasis and the
 * text fixes of Tidy captions (`emphasis` and `text`, one group row each, its single items inside),
 * and one row for each automatic emoji, pop-up, counter, list card, lower third, chapter title and
 * quote card (`emoji`, `graphic`) and each bleep (`bleep`). Pure.
 *
 * Statuses are read from the project, as for the other kinds: an item is pending while its record or
 * its `auto` is there; Keep makes it the user's (the record dropped, `auto` cleared) and Remove takes
 * it back (the look before, the text before, the item deleted). Each is one project out, so a press
 * is one undo step; a group's Keep or Remove does all its pending items in that one step.
 */
import { maskBleeped, maskWord } from '../captions/cleanup'
import { emojiEntry } from '../captions/emojiList'
import { deepEqual } from '../captions/graphicRules'
import { LEGACY_TILES, studioPreset } from '../captions/studioPresets'
import type { Bleep, CaptionAuto, CaptionMark, CaptionSegment, CaptionSettings, Graphic, Project, TitleCard } from '../types'
import type { ReviewItem, ReviewKind, ReviewStatus } from './review'

/** The kinds of this module, in the order items at the same time are listed (after Review mode's own). */
export const CAPTION_KINDS: readonly ReviewKind[] = ['style', 'emphasis', 'text', 'emoji', 'graphic', 'bleep']
const CAPTION_KIND_SET: ReadonlySet<ReviewKind> = new Set(CAPTION_KINDS)
export const isCaptionKind = (kind: ReviewKind): boolean => CAPTION_KIND_SET.has(kind)

/** The keys of the two group rows; their items' keys are `emphasis:<mark id>` and `text:<caption id>`. */
export const EMPHASIS_GROUP = 'group:emphasis'
export const TEXT_GROUP = 'group:text'
export const STYLE_KEY = 'style:look'

type StyleRecord = NonNullable<CaptionAuto['style']>
type TextRecord = NonNullable<CaptionAuto['text']>[number]

/** What the detail line says for these rows. */
const DETAIL = 'Captions Studio'
const PROVIDER_NAMES: Record<string, string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }
const STYLE_BY: Record<StyleRecord['by'], string> = { great: 'Make my captions great', polish: 'Polish' }

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
/** Text cut to `max` characters, on a word when it can. */
function short(text: string, max = 40): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/* ---------- lookups, made once per array ---------- */

function memoById<T extends { id: string }>(memo: WeakMap<readonly T[], Map<string, T>>, list: readonly T[] | undefined): ReadonlyMap<string, T> {
  if (!list?.length) return EMPTY as ReadonlyMap<string, T>
  let byId = memo.get(list)
  if (!byId) {
    byId = new Map()
    for (const x of list) if (!byId.has(x.id)) byId.set(x.id, x)
    memo.set(list, byId)
  }
  return byId
}
const EMPTY: ReadonlyMap<string, never> = new Map<string, never>()
const markMemo = new WeakMap<readonly CaptionMark[], Map<string, CaptionMark>>()
const graphicMemo = new WeakMap<readonly Graphic[], Map<string, Graphic>>()
const cardMemo = new WeakMap<readonly TitleCard[], Map<string, TitleCard>>()
const bleepMemo = new WeakMap<readonly Bleep[], Map<string, Bleep>>()
const segmentMemo = new WeakMap<readonly CaptionSegment[], Map<string, CaptionSegment>>()

const segmentsById = (p: Project): ReadonlyMap<string, CaptionSegment> => memoById(segmentMemo, p.transcript?.segments)
const textRecordMemo = new WeakMap<readonly TextRecord[], Map<string, TextRecord>>()
function textRecords(p: Project): ReadonlyMap<string, TextRecord> {
  const list = p.captionAuto?.text
  if (!list?.length) return EMPTY
  let byCaption = textRecordMemo.get(list)
  if (!byCaption) {
    byCaption = new Map()
    for (const r of list) if (!byCaption.has(r.caption)) byCaption.set(r.caption, r)
    textRecordMemo.set(list, byCaption)
  }
  return byCaption
}

const idOf = (key: string): string => key.slice(key.indexOf(':') + 1)

/* ---------- titles ---------- */

/** A look's name for "was …": the gallery tile it came from, else the Classic look, else Clean (no captions settings: today's default). */
export function lookName(c: CaptionSettings | null | undefined): string {
  if (!c) return 'Clean'
  if (c.studio) {
    const from = c.studio.from
    if (from === 'brand') return 'Brand'
    if (from.startsWith('mine:')) return 'your style'
    return studioPreset(from)?.name ?? 'your style'
  }
  return LEGACY_TILES.find((t) => t.preset === c.preset)?.name ?? 'Clean'
}

const styleTitle = (r: StyleRecord): string => `Caption style: ${r.name} (was ${lookName(r.was)})`
const markWords = (m: Pick<CaptionMark, 'from' | 'to'>): number => Math.max(1, m.to - m.from + 1)

/** "Fixed “flown” → “Flown”": the words that differ between the text before and the text now, masked where bleeped. */
export function textFixTitle(before: string, now: string | undefined, bleeps: readonly Bleep[] | undefined): string {
  if (now === undefined) return `Fixed “${short(maskBleeped(before, bleeps))}”`
  const a = before.split(/\s+/).filter(Boolean)
  const b = now.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  let j = 0
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
  const was = a.slice(i, a.length - j).join(' ')
  const is = b.slice(i, b.length - j).join(' ')
  const show = (t: string): string => short(maskBleeped(t, bleeps))
  if (!was && !is) return `Fixed “${show(now)}”`
  return `Fixed “${show(was)}” → “${show(is)}”`
}

function graphicTitle(g: Graphic, bleeps: readonly Bleep[] | undefined): string {
  switch (g.kind) {
    case 'keyword':
      return `Pop-up “${short(maskBleeped(g.text, bleeps))}”`
    case 'emoji': {
      const e = emojiEntry(g.emoji)
      const on = g.anchor ? ` on “${short(maskBleeped(g.anchor.text, bleeps))}”` : ''
      return `Emoji ${e?.text ?? ''}${on}`.replace(/ {2,}/g, ' ')
    }
    case 'counter':
      return `Counter ${g.prefix}${g.to.toFixed(g.decimals)}${g.suffix}`
    case 'list':
      return `List: ${g.title?.trim() ? short(maskBleeped(g.title, bleeps)) : plural(g.items.length, 'item')}`
  }
}

function cardTitle(c: TitleCard, bleeps: readonly Bleep[] | undefined): string {
  const text = short(maskBleeped(c.title, bleeps))
  if (c.auto?.by === 'speaker') return `Lower third: ${text}`
  if (c.auto?.by === 'chapter') return `Chapter title: ${text}`
  if (c.auto?.by === 'quote') return `Quote: “${text}”`
  return `Title: ${text}`
}

const viaDetail = (via: string | undefined): string => (via && via !== 'rules' && PROVIDER_NAMES[via] ? `${DETAIL}, with ${PROVIDER_NAMES[via]}` : DETAIL)

/** A group row's title from its items (all those listed, reviewed or not, so it stays as first read). */
function groupTitle(kind: 'emphasis' | 'text', parts: readonly ReviewItem[]): string {
  if (kind === 'emphasis') return `Emphasis: ${plural(parts.reduce((n, p) => n + (p.words ?? 1), 0), 'word')}`
  return `Text: ${plural(parts.length, 'caption')} tidied`
}

/* ---------- the rows ---------- */

const byTime = (a: ReviewItem, b: ReviewItem): number => a.start - b.start || a.key.localeCompare(b.key)

function group(kind: 'emphasis' | 'text', key: string, parts: ReviewItem[]): ReviewItem {
  parts.sort(byTime)
  return { key, kind, start: parts[0].start, end: parts[0].end, title: groupTitle(kind, parts), detail: DETAIL, members: parts.map((p) => p.key), parts }
}

/** Captions Studio's automatic changes still automatic in `project` (pending by construction), not in order. */
export function captionReviewItems(project: Project): ReviewItem[] {
  const items: ReviewItem[] = []
  const segs = segmentsById(project)
  const bleeps = project.bleeps
  const first = project.transcript?.segments[0]
  const style = project.captionAuto?.style
  if (style) {
    const at = first?.start ?? project.clips[0]?.start ?? 0
    items.push({ key: STYLE_KEY, kind: 'style', start: at, end: first?.end ?? at, title: styleTitle(style), detail: STYLE_BY[style.by] ?? DETAIL, style })
  }
  const marks = (project.captionMarks ?? []).filter((m) => m.auto)
  if (marks.length) {
    const parts = marks.map((m): ReviewItem => {
      const seg = segs.get(m.caption)
      const at = seg?.start ?? 0
      return { key: `emphasis:${m.id}`, kind: 'emphasis', start: at, end: seg?.end ?? at, title: `Emphasis on “${short(maskBleeped(m.text, bleeps))}”`, detail: DETAIL, words: markWords(m) }
    })
    items.push(group('emphasis', EMPHASIS_GROUP, parts))
  }
  const records = project.captionAuto?.text ?? []
  if (records.length) {
    const seen = new Set<string>()
    const parts: ReviewItem[] = []
    for (const r of records) {
      if (seen.has(r.caption)) continue
      seen.add(r.caption)
      const seg = segs.get(r.caption)
      const at = seg?.start ?? 0
      parts.push({ key: `text:${r.caption}`, kind: 'text', start: at, end: seg?.end ?? at, title: textFixTitle(r.text, seg?.text, bleeps), detail: DETAIL, text: r })
    }
    items.push(group('text', TEXT_GROUP, parts))
  }
  for (const g of project.graphics ?? []) {
    if (!g.auto) continue
    items.push({ key: `graphic:${g.id}`, kind: g.kind === 'emoji' ? 'emoji' : 'graphic', start: g.start, end: g.end, title: graphicTitle(g, bleeps), detail: viaDetail(g.auto.via) })
  }
  for (const c of project.titles ?? []) {
    if (!c.auto) continue
    items.push({ key: `card:${c.id}`, kind: 'graphic', start: c.start, end: c.end, title: cardTitle(c, bleeps), detail: viaDetail(c.auto.via) })
  }
  for (const b of bleeps ?? []) {
    if (b.auto) items.push({ key: `bleep:${b.id}`, kind: 'bleep', start: b.start, end: b.end, title: `Bleeped “${maskWord(b.word)}”`, detail: DETAIL })
  }
  return items
}

/** How many rows captionReviewItems gives, counted without making them (the Review button's count). */
export function captionPendingCount(project: Project): number {
  let n = project.captionAuto?.style ? 1 : 0
  if (project.captionMarks?.some((m) => m.auto)) n++
  if (project.captionAuto?.text?.length) n++
  for (const g of project.graphics ?? []) if (g.auto) n++
  for (const c of project.titles ?? []) if (c.auto) n++
  for (const b of project.bleeps ?? []) if (b.auto) n++
  return n
}

/* ---------- statuses ---------- */

/** Whether `c` is the look `was` (absent when `was` is null). */
const sameLook = (c: CaptionSettings | undefined, was: CaptionSettings | null): boolean => (was === null ? c === undefined : deepEqual(c, was))

/** An item of one of these kinds (a group row, or one item inside one), read from `project`. */
export function captionItemStatus(project: Project, item: ReviewItem): ReviewStatus {
  if (item.parts) {
    const all = item.parts.map((p) => captionItemStatus(project, p))
    if (all.includes('pending')) return 'pending'
    return all.every((s) => s === 'removed') ? 'removed' : 'kept'
  }
  const key = item.key
  if (key === STYLE_KEY) {
    if (project.captionAuto?.style) return 'pending'
    return item.style && sameLook(project.captions, item.style.was) ? 'removed' : 'kept'
  }
  const id = idOf(key)
  const tagged = (x: { auto?: unknown } | undefined): ReviewStatus => (!x ? 'removed' : x.auto ? 'pending' : 'kept')
  if (key.startsWith('emphasis:')) return tagged(memoById(markMemo, project.captionMarks).get(id))
  if (key.startsWith('graphic:')) return tagged(memoById(graphicMemo, project.graphics).get(id))
  if (key.startsWith('card:')) return tagged(memoById(cardMemo, project.titles).get(id))
  if (key.startsWith('bleep:')) return tagged(memoById(bleepMemo, project.bleeps).get(id))
  if (key.startsWith('text:')) {
    if (textRecords(project).has(id)) return 'pending'
    const seg = segmentsById(project).get(id)
    return !seg || (item.text && seg.text === item.text.text) ? 'removed' : 'kept'
  }
  return 'removed'
}

/**
 * The panel's group row `shown` brought up to date with `now` (the same group in the project now,
 * or undefined when none of it is pending): its items are those it listed plus those pending now,
 * each in its current version, so an item reviewed inside the group stays listed, marked.
 */
export function mergeGroup(shown: ReviewItem, now: ReviewItem | undefined): ReviewItem {
  if (!now) return shown
  if (!shown.parts) return now
  const fresh = new Map((now.parts ?? []).map((p) => [p.key, p]))
  const parts = shown.parts.map((p) => fresh.get(p.key) ?? p)
  const had = new Set(shown.parts.map((p) => p.key))
  for (const p of now.parts ?? []) if (!had.has(p.key)) parts.push(p)
  parts.sort(byTime)
  const kind = now.kind === 'emphasis' ? 'emphasis' : 'text'
  return { ...now, start: parts[0].start, end: parts[0].end, title: groupTitle(kind, parts), members: parts.map((p) => p.key), parts }
}

/* ---------- Keep and Remove ---------- */

/** Group rows given as their items (`members`, listed in `parts`). */
export function expandGroups(items: readonly ReviewItem[]): ReviewItem[] {
  return items.flatMap((i) => i.parts ?? [i])
}

/** The project with these records (none: the field removed). */
function withAuto(p: Project, auto: CaptionAuto): Project {
  if (auto.style || auto.text?.length) return { ...p, captionAuto: auto }
  if (!p.captionAuto) return p
  const { captionAuto: _gone, ...rest } = p
  void _gone
  return rest
}

/** `list` without `auto` on the ids in `ids`. */
function cleared<T extends { id: string; auto?: unknown }>(list: readonly T[], ids: ReadonlySet<string>): T[] {
  return list.map((x) => {
    if (!ids.has(x.id) || !x.auto) return x
    const { auto: _a, ...rest } = x
    void _a
    return rest as T
  })
}

/** The project with `field` set to `list`, or without it when the list is empty. */
function withList<K extends 'captionMarks' | 'graphics' | 'bleeps'>(p: Project, field: K, list: NonNullable<Project[K]>): Project {
  if (list.length) return { ...p, [field]: list }
  const { [field]: _gone, ...rest } = p
  void _gone
  return rest as Project
}

/** The ids of `items` whose key starts with `prefix`. */
const idsOf = (items: readonly ReviewItem[], prefix: string): Set<string> => new Set(items.filter((i) => i.key.startsWith(prefix)).map((i) => idOf(i.key)))

/**
 * The project with Captions Studio's pending `items` (single items, not groups) kept: the style and
 * text records dropped, `auto` cleared on marks, graphics, title cards and bleeps. `project` itself
 * when nothing changes.
 */
export function keepCaptionItems(project: Project, items: readonly ReviewItem[]): Project {
  if (items.length === 0) return project
  let next = project
  const texts = idsOf(items, 'text:')
  const style = items.some((i) => i.key === STYLE_KEY)
  if (style || texts.size) {
    const auto: CaptionAuto = { ...next.captionAuto }
    if (style) delete auto.style
    if (texts.size && auto.text) auto.text = auto.text.filter((r) => !texts.has(r.caption))
    if (auto.text && !auto.text.length) delete auto.text
    next = withAuto(next, auto)
  }
  const marks = idsOf(items, 'emphasis:')
  if (marks.size && next.captionMarks) next = { ...next, captionMarks: cleared(next.captionMarks, marks) }
  const graphics = idsOf(items, 'graphic:')
  if (graphics.size && next.graphics) next = { ...next, graphics: cleared(next.graphics, graphics) }
  const cards = idsOf(items, 'card:')
  if (cards.size && next.titles) next = { ...next, titles: cleared(next.titles, cards) }
  const bleeps = idsOf(items, 'bleep:')
  if (bleeps.size && next.bleeps) next = { ...next, bleeps: cleared(next.bleeps, bleeps) }
  return next
}

/**
 * The project with Captions Studio's pending `items` (single items, not groups) removed: the look
 * before the first automatic change put back (no captions settings when there were none), the text
 * and words before put back on each tidied caption, and the marks, graphics, title cards and bleeps
 * deleted. Records go with what they record. `project` itself when nothing changes.
 */
export function removeCaptionItems(project: Project, items: readonly ReviewItem[]): Project {
  if (items.length === 0) return project
  let next = project
  const texts = idsOf(items, 'text:')
  const style = items.some((i) => i.key === STYLE_KEY) ? next.captionAuto?.style : undefined
  if (style) {
    if (style.was === null) {
      const { captions: _c, ...rest } = next
      void _c
      next = rest
    } else next = { ...next, captions: style.was }
  }
  if (texts.size && next.transcript) {
    const back = new Map((next.captionAuto?.text ?? []).filter((r) => texts.has(r.caption)).map((r) => [r.caption, r]))
    const segments = next.transcript.segments.map((s) => {
      const r = back.get(s.id)
      if (!r) return s
      const { words: _w, ...rest } = s
      void _w
      return r.words ? { ...rest, text: r.text, words: r.words } : { ...rest, text: r.text }
    })
    next = { ...next, transcript: { ...next.transcript, segments } }
  }
  if (style || texts.size) {
    const auto: CaptionAuto = { ...next.captionAuto }
    if (style) delete auto.style
    if (texts.size && auto.text) auto.text = auto.text.filter((r) => !texts.has(r.caption))
    if (auto.text && !auto.text.length) delete auto.text
    next = withAuto(next, auto)
  }
  const drop = <T extends { id: string }>(list: readonly T[] | undefined, ids: ReadonlySet<string>): T[] | null => (ids.size && list ? list.filter((x) => !ids.has(x.id)) : null)
  const marks = drop(next.captionMarks, idsOf(items, 'emphasis:'))
  if (marks) next = withList(next, 'captionMarks', marks)
  const graphics = drop(next.graphics, idsOf(items, 'graphic:'))
  if (graphics) next = withList(next, 'graphics', graphics)
  // Title cards stay a list (a new project has `titles: []`), as Make my captions great leaves it.
  const cards = drop(next.titles, idsOf(items, 'card:'))
  if (cards) next = { ...next, titles: cards }
  const bleeps = drop(next.bleeps, idsOf(items, 'bleep:'))
  if (bleeps) next = withList(next, 'bleeps', bleeps)
  return next
}
