/**
 * Opening a recording at a moment found by search (docs/design/search.md §2.10), and the words
 * Home shows and reads out for a moment (§5).
 */
import type { Clip } from '../types'
import type { SearchKind } from './types'

/** Whether nothing of `start..end` is kept (no clip overlaps it; a point is cut when no clip holds it). */
export function isCut(kept: readonly (readonly [number, number])[], start: number, end: number): boolean {
  if (!kept.length) return false
  return !kept.some(([s, e]) => (end > start ? s < end && e > start : start >= s && start < e))
}

/**
 * Where the editor's playhead goes for a moment from source second `t` to `end`: `t` itself when a
 * clip keeps it, else the start of the next kept clip (else the end of the last one). `cut` is true
 * when nothing of the moment is kept, as its result says (`isCut`): a caption whose first word was
 * cut opens where the rest of it is, with no notice.
 */
export function momentTarget(clips: readonly Pick<Clip, 'start' | 'end'>[], t: number, end = t): { t: number; cut: boolean } {
  const sorted = [...clips].filter((c) => c.end > c.start).sort((a, b) => a.start - b.start)
  if (!sorted.length || !Number.isFinite(t)) return { t: Math.max(0, Number.isFinite(t) ? t : 0), cut: false }
  if (sorted.some((c) => t >= c.start && t < c.end)) return { t, cut: false }
  const cut = isCut(sorted.map((c) => [c.start, c.end] as const), t, end)
  const next = sorted.find((c) => c.start > t)
  if (next) return { t: next.start, cut }
  const last = sorted[sorted.length - 1]
  // Before the end, so the frame shown is one that is kept.
  return { t: Math.max(last.start, last.end - 0.05), cut }
}

/** Short label of where the words were found. */
export const KIND_LABEL: Record<SearchKind, string> = {
  name: 'Name',
  file: 'File',
  chapter: 'Chapter',
  title: 'Title',
  text: 'On screen',
  said: 'Said',
  notes: 'Notes'
}

/** "1:23", "1:02:03" (whole seconds). */
export function clockTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toString().padStart(2, '0')
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** "1 minute 23 seconds", for screen readers. */
export function spokenTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts: string[] = []
  if (h) parts.push(plural(h, 'hour'))
  if (m) parts.push(plural(m, 'minute'))
  if (sec || !parts.length) parts.push(plural(sec, 'second'))
  return parts.join(' ')
}

/** The live region's sentence: "3 recordings found", "No recordings match "x"." */
export function resultsSummary(count: number, query: string, limit = Infinity): string {
  if (count === 0) return `No recordings match "${query}".`
  if (count >= limit) return `The first ${count} recordings found. Add a word to narrow them.`
  return `${plural(count, 'recording')} found`
}
