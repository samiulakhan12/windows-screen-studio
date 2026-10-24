/**
 * Reading stored title cards and chapters: defaults for missing fields, texts cut to length, and
 * entries that cannot be shown rejected. One rule for loading a project (project.ts) and for the
 * editor (editor/titles.ts), like shapeData.ts for shapes.
 */
import type { Chapter, TitleCard, TitleCardStyle } from '../types'

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
const STYLES: TitleCardStyle[] = ['centered', 'lower-third', 'big']
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
  return card
}

/** A stored chapter inside the recording, or null when its time is unusable. */
export function readChapter(raw: Partial<Chapter> | null | undefined, duration = Infinity): Chapter | null {
  if (!raw || typeof raw !== 'object' || !finite(raw.t)) return null
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    t: Math.min(Math.max(0, raw.t), Math.max(0, duration)),
    title: typeof raw.title === 'string' ? cleanChapterName(raw.title) : 'Chapter'
  }
}
