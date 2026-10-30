/**
 * Opening a recording at a moment found by search (docs/design/search.md §2.10), and the words
 * Home shows and reads out for a moment (§5).
 */
import type { Clip } from '../types'
import type { SearchKind } from './types'

/**
 * Where the editor's playhead goes for a moment at source second `t`: `t` itself when a clip keeps
 * it, else the start of the next kept clip (else the end of the last one), `cut` then true.
 */
export function momentTarget(clips: readonly Pick<Clip, 'start' | 'end'>[], t: number): { t: number; cut: boolean } {
  const sorted = [...clips].filter((c) => c.end > c.start).sort((a, b) => a.start - b.start)
  if (!sorted.length || !Number.isFinite(t)) return { t: Math.max(0, Number.isFinite(t) ? t : 0), cut: false }
  if (sorted.some((c) => t >= c.start && t < c.end)) return { t, cut: false }
  const next = sorted.find((c) => c.start > t)
  if (next) return { t: next.start, cut: true }
  const last = sorted[sorted.length - 1]
  // Before the end, so the frame shown is one that is kept.
  return { t: Math.max(last.start, last.end - 0.05), cut: true }
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
export function resultsSummary(count: number, query: string): string {
  if (count === 0) return `No recordings match "${query}".`
  return `${plural(count, 'recording')} found`
}
