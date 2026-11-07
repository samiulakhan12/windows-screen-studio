/**
 * Reading the stored progress bar (docs/design/editing-polish.md §4.2, §8): Project.chapterBar.
 * `show` must be a boolean, else the bar reads as absent; other unknown values read as the
 * defaults. Absent input reads as undefined, so loading a project from before wave 10 adds no key.
 */
import type { ChapterBar } from '../types'

const HEX = /^#[0-9a-f]{6}$/i
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const pick = <T>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)

/** A new bar's settings (the switch turned on). */
export const DEFAULT_CHAPTER_BAR: ChapterBar = {
  show: true,
  place: 'auto',
  style: 'float',
  labels: 'current'
}

export function readChapterBar(raw: unknown): ChapterBar | undefined {
  if (!isObject(raw) || typeof raw.show !== 'boolean') return undefined
  const bar: ChapterBar = {
    show: raw.show,
    place: pick(raw.place, ['auto', 'top', 'bottom'] as const, 'auto'),
    style: pick(raw.style, ['float', 'edge'] as const, 'float'),
    labels: pick(raw.labels, ['none', 'current', 'all'] as const, 'current')
  }
  if (typeof raw.color === 'string' && HEX.test(raw.color)) bar.color = raw.color
  if (typeof raw.onlyAtChapters === 'boolean') bar.onlyAtChapters = raw.onlyAtChapters
  return bar
}
