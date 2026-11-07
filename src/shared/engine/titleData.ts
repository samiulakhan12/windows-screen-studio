/**
 * Reading stored title cards and chapters: defaults for missing fields, texts cut to length, and
 * entries that cannot be shown rejected. One rule for loading a project (project.ts) and for the
 * editor (editor/titles.ts), like shapeData.ts for shapes.
 */
import { catalogId, CATALOG_PREFIX } from '../captions/fontCatalog'
import { readAutoOrigin, readHost } from '../captions/studioData'
import { readFontId } from '../render/fonts'
import { readCalloutFields } from '../render/calloutData'
import type { Chapter, ChapterOrigin, ChapterSignal, TitleCard, TitleCardStyle } from '../types'

/** Longest title or subtitle kept, in characters. */
export const TITLE_MAX_CHARS = 200
/** Longest chapter name kept, in characters (YouTube shows about 100). */
export const CHAPTER_MAX_CHARS = 100

export const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** Title text as stored and drawn: no carriage returns, at most TITLE_MAX_CHARS. */
export const cleanTitle = (text: string): string => text.replace(/\r/g, '').slice(0, TITLE_MAX_CHARS)

/** A chapter name as stored: one line (control characters become spaces), at most CHAPTER_MAX_CHARS. */
export const cleanChapterName = (name: string): string => name.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, CHAPTER_MAX_CHARS)

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const STYLES: TitleCardStyle[] = ['centered', 'lower-third', 'big', 'quote']
const BACKGROUNDS: TitleCard['background'][] = ['blur', 'solid', 'style']

/**
 * A stored title card with every field usable (inside a recording of `duration` seconds), or null
 * when it cannot be shown (hand-edited or damaged files): unknown style or background fall back to
 * the defaults, bad colours are dropped, texts are cut to TITLE_MAX_CHARS.
 */
export function readTitleCard(raw: Partial<TitleCard> | null | undefined, duration = Infinity): TitleCard | null {
  if (!raw || typeof raw !== 'object' || !finite(raw.start) || !finite(raw.end)) return null
  const start = Math.max(0, raw.start)
  const end = Math.min(raw.end, duration)
  if (!(end - start > 0.01)) return null
  const card: TitleCard = {
    id: typeof raw.id === 'string' ? raw.id : '',
    start,
    end,
    title: typeof raw.title === 'string' ? cleanTitle(raw.title) : '',
    style: STYLES.includes(raw.style as TitleCardStyle) ? (raw.style as TitleCardStyle) : 'centered',
    background: BACKGROUNDS.includes(raw.background as TitleCard['background']) ? (raw.background as TitleCard['background']) : 'blur'
  }
  if (typeof raw.subtitle === 'string') card.subtitle = cleanTitle(raw.subtitle)
  if (typeof raw.color === 'string' && HEX_COLOR.test(raw.color)) card.color = raw.color
  if (typeof raw.textColor === 'string' && HEX_COLOR.test(raw.textColor)) card.textColor = raw.textColor
  // A brand font, or a Captions Studio catalogue font ('cat:<id>'; an unknown one is dropped, so the card uses its default font).
  const font = typeof raw.font === 'string' && raw.font.startsWith(CATALOG_PREFIX) ? (catalogId(raw.font) ? raw.font : undefined) : readFontId(raw.font)
  if (font) card.font = font
  if (raw.brand === 'intro' || raw.brand === 'outro') card.brand = raw.brand
  // Made automatically and not reviewed yet (Captions Studio §11.8): kept when `by` and `via` are valid.
  const auto = readAutoOrigin(raw.auto)
  if (auto) card.auto = auto
  // How it comes in and goes out, and its sound (editing polish §7.1), when readable.
  Object.assign(card, readCalloutFields(raw as Record<string, unknown>, 'title'))
  return card
}

const ORIGIN_BY: readonly ChapterOrigin['by'][] = ['find', 'polish']
const SIGNALS: readonly ChapterSignal[] = ['start', 'page', 'screen', 'pause', 'idle', 'cue', 'section', 'topic', 'card', 'ai']
const NAMES: readonly ChapterOrigin['name'][] = ['card', 'sentence', 'phrase', 'cut', 'number', 'ai']
const VIA: readonly NonNullable<ChapterOrigin['via']>[] = ['openai', 'gemini', 'anthropic', 'local']

/**
 * A found chapter's stored origin (smart-tools.md §4.2), or undefined: `by` in its list; `from` 1 to
 * 3 known signals in their order (unknown ones dropped; none left drops the origin); `name` in its
 * list; `via` a provider kind or 'local'; `host` as readHost reads it. Any other failure drops the
 * origin, never the chapter, which is then the user's.
 */
export function readChapterOrigin(raw: unknown): ChapterOrigin | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (!ORIGIN_BY.includes(o.by as ChapterOrigin['by']) || !NAMES.includes(o.name as ChapterOrigin['name']) || !Array.isArray(o.from)) return undefined
  const from: ChapterSignal[] = []
  for (const f of o.from) if (SIGNALS.includes(f as ChapterSignal) && !from.includes(f as ChapterSignal) && from.length < 3) from.push(f as ChapterSignal)
  if (!from.length) return undefined
  const origin: ChapterOrigin = { by: o.by as ChapterOrigin['by'], from, name: o.name as ChapterOrigin['name'] }
  if (o.via !== undefined) {
    if (!VIA.includes(o.via as NonNullable<ChapterOrigin['via']>)) return undefined
    origin.via = o.via as ChapterOrigin['via']
  }
  if (o.host !== undefined) {
    const host = readHost(o.host)
    if (!host) return undefined
    origin.host = host
  }
  return origin
}

/** A stored chapter inside the recording, or null when its time is unusable. A found chapter keeps its readable `auto` (§4.2). */
export function readChapter(raw: Partial<Chapter> | null | undefined, duration = Infinity): Chapter | null {
  if (!raw || typeof raw !== 'object' || !finite(raw.t)) return null
  const chapter: Chapter = {
    id: typeof raw.id === 'string' ? raw.id : '',
    t: Math.min(Math.max(0, raw.t), Math.max(0, duration)),
    title: typeof raw.title === 'string' ? cleanChapterName(raw.title) : 'Chapter'
  }
  const auto = readChapterOrigin(raw.auto)
  if (auto) chapter.auto = auto
  return chapter
}
