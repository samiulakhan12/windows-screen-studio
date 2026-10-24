import { clamp } from '../engine/math'
import { keptBounds } from '../engine/timeline'
import { HEX_COLOR } from '../engine/titleData'
import type { Chapter, Clip, TitleCard, TitleCardStyle } from '../types'

export { CHAPTER_MAX_CHARS, cleanChapterName, cleanTitle, readChapter, readTitleCard, TITLE_MAX_CHARS } from '../engine/titleData'

/*
 * Title cards and chapters: factories and editing rules (times, names, colours), so the editor,
 * the timeline and the renderer agree. Reading stored ones is in engine/titleData.ts. Pure.
 */

/** Default length (seconds) of a new title card. */
export const DEFAULT_TITLE_LENGTH = 3
/** Shortest a title card can be dragged (it fades in and out within it). */
export const MIN_TITLE_LENGTH = 0.5
/** Chapters closer than this (source seconds) are the same place: adding one there selects the other. */
export const CHAPTER_NEAR = 0.1

export const TITLE_STYLES: { value: TitleCardStyle; label: string; title: string }[] = [
  { value: 'centered', label: 'Centered', title: 'A full-frame card with the title in the middle' },
  { value: 'big', label: 'Big', title: 'A full-frame card with a very large title' },
  { value: 'lower-third', label: 'Lower third', title: 'A band at the bottom, over the video' }
]

export const TITLE_BACKGROUNDS: { value: TitleCard['background']; label: string; title: string }[] = [
  { value: 'blur', label: 'Blurred video', title: 'The video behind it, blurred and darkened' },
  { value: 'solid', label: 'Colour', title: 'A solid colour' },
  { value: 'style', label: 'Project background', title: "The project's background, as set in the Style panel" }
]

/** Colour of a solid card when none is chosen. */
export const DEFAULT_TITLE_COLOR = '#14141c'
export const TITLE_COLORS = ['#14141c', '#ffffff', '#7c3aed', '#2563eb', '#0d9488', '#e11d48', '#f59e0b']
export const TITLE_TEXT_COLORS = ['#ffffff', '#14141c', '#facc15', '#a5f3fc', '#f9a8d4']

let idCounter = 0
const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** A new title card starting at `t` (or ending at the recording's end when `t` is too late to fit it). */
export function createTitleCard(t: number, duration: number, init: Partial<Omit<TitleCard, 'id'>> = {}): TitleCard {
  const length = Math.min(DEFAULT_TITLE_LENGTH, Math.max(0, duration))
  const start = clamp(t, 0, Math.max(0, duration - length))
  return { id: newId('c'), start, end: Math.min(duration, start + length), title: 'Title', style: 'centered', background: 'blur', ...init }
}

/**
 * Start and end of a new title card for the playhead at `t`: it starts there, DEFAULT_TITLE_LENGTH
 * long, inside the kept part of the recording (near the end it starts earlier instead of being cut off).
 */
export function titleTimesAt(t: number, project: { duration: number; clips?: Clip[] }): { start: number; end: number } {
  let lo = 0
  let hi = Math.max(0, project.duration)
  if (project.clips?.length) {
    const kept = keptBounds(project.clips)
    const a = clamp(kept.start, 0, hi)
    const b = clamp(kept.end, a, hi)
    if (b - a >= MIN_TITLE_LENGTH) {
      lo = a
      hi = b
    }
  }
  const length = Math.min(DEFAULT_TITLE_LENGTH, hi - lo)
  const start = clamp(t, lo, hi - length)
  return { start, end: start + length }
}

/** New start/end for a move or edge drag on the timeline; title cards may overlap each other. */
export function dragTitleTimes(initial: { start: number; end: number }, mode: 'move' | 'start' | 'end', dt: number, duration: number): { start: number; end: number } {
  let { start, end } = initial
  // A card already shorter than the minimum may grow but not shrink further.
  const short = end - start < MIN_TITLE_LENGTH
  if (mode === 'move') {
    const len = end - start
    start = clamp(start + dt, 0, Math.max(0, duration - len))
    end = start + len
  } else if (mode === 'start') {
    start = clamp(start + dt, Math.min(0, start), short ? start : end - MIN_TITLE_LENGTH)
  } else {
    end = clamp(end + dt, short ? end : start + MIN_TITLE_LENGTH, Math.max(duration, end))
  }
  return { start, end }
}

export const titleVisibleAt = (card: { start: number; end: number }, t: number): boolean => t >= card.start && t < card.end

/* ---------- colours ---------- */


/** Relative luminance (0 black .. 1 white) of a #rrggbb colour. */
export function luminance(hex: string): number {
  if (!HEX_COLOR.test(hex)) return 0
  const lin = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5)
}

/** The solid colour of a card (its own, or the default). */
export const titleColorOf = (card: Pick<TitleCard, 'color'>): string => (card.color && HEX_COLOR.test(card.color) ? card.color : DEFAULT_TITLE_COLOR)

/** The text colour of a card: its own, or white (dark on a light solid colour). */
export function titleTextColorOf(card: Pick<TitleCard, 'textColor' | 'color' | 'background'>): string {
  if (card.textColor && HEX_COLOR.test(card.textColor)) return card.textColor
  return card.background === 'solid' && luminance(titleColorOf(card)) > 0.45 ? '#14141c' : '#ffffff'
}

/* ---------- chapters ---------- */

/** A new chapter at `t`. */
export function createChapter(t: number, title = 'Chapter'): Chapter {
  return { id: newId('h'), t: Math.max(0, t), title }
}

/** Chapters in time order (the stored order is free). */
export const sortedChapters = (chapters: readonly Chapter[]): Chapter[] => [...chapters].sort((a, b) => a.t - b.t)

/** Name of the next new chapter: "Chapter 3" when there are two. */
export function nextChapterName(chapters: readonly Chapter[]): string {
  let n = chapters.length + 1
  const names = new Set(chapters.map((c) => c.title))
  while (names.has(`Chapter ${n}`)) n++
  return `Chapter ${n}`
}

/** The chapter within CHAPTER_NEAR of `t`, if any. */
export const chapterNear = (chapters: readonly Chapter[], t: number): Chapter | null => chapters.find((c) => Math.abs(c.t - t) < CHAPTER_NEAR) ?? null

/** The first chapter after `t` (a hair past `t`, so pressing again moves on), or null. */
export function nextChapter(chapters: readonly Chapter[], t: number): Chapter | null {
  return sortedChapters(chapters).find((c) => c.t > t + 1e-3) ?? null
}

/** The last chapter before `t`, or null. */
export function previousChapter(chapters: readonly Chapter[], t: number): Chapter | null {
  const before = sortedChapters(chapters).filter((c) => c.t < t - 1e-3)
  return before[before.length - 1] ?? null
}

