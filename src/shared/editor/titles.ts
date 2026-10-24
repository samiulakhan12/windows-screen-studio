import type { Chapter, TitleCard } from '../types'

/** Default length (seconds) of a new title card. */
export const DEFAULT_TITLE_LENGTH = 3

let idCounter = 0
const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** A new title card starting at `t`, clamped to the recording. */
export function createTitleCard(t: number, duration: number, init: Partial<Omit<TitleCard, 'id'>> = {}): TitleCard {
  const start = Math.max(0, Math.min(t, duration - 0.1))
  return { id: newId('c'), start, end: Math.min(duration, start + DEFAULT_TITLE_LENGTH), title: 'Title', style: 'centered', background: 'blur', ...init }
}

/** A new chapter at `t`. */
export function createChapter(t: number, title = 'Chapter'): Chapter {
  return { id: newId('h'), t: Math.max(0, t), title }
}
