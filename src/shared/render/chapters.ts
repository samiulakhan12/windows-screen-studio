/**
 * Chapters of an exported video: the project's chapters (source time) mapped onto the edited
 * output, as written into the file's metadata and as YouTube-style timestamps. Pure.
 */
import { outputDuration } from '../engine/timeline'
import type { Chapter, Clip } from '../types'
import { viewingTime } from './overlays'

/** Chapters landing closer together than this in the output (seconds) are one place. */
export const MIN_CHAPTER_GAP = 0.1
/** Most chapters an export writes. */
export const MAX_CHAPTERS = 1000

/** A chapter of the exported video. */
export interface OutputChapter {
  /** Output seconds. */
  start: number
  title: string
}

/**
 * The chapters of the edited video, in output seconds and in order: each source time is mapped
 * through the clips (one inside a cut starts where the video goes on, one at or past the end is
 * left out), an empty name becomes "Chapter n", and of chapters landing in the same place
 * (within MIN_CHAPTER_GAP) only the last one in the recording stays, the one nearest its content.
 */
export function outputChapters(chapters: readonly Chapter[], clips: Clip[]): OutputChapter[] {
  if (!chapters.length || !clips.length) return []
  const total = outputDuration(clips)
  const out: OutputChapter[] = []
  const sorted = [...chapters].filter((c) => Number.isFinite(c.t)).sort((a, b) => a.t - b.t)
  sorted.forEach((c, i) => {
    const start = Math.max(0, viewingTime(clips, c.t))
    if (start > total - MIN_CHAPTER_GAP) return
    const chapter = { start, title: c.title.replace(/\s+/g, ' ').trim() || `Chapter ${i + 1}` }
    const last = out[out.length - 1]
    if (last && start - last.start < MIN_CHAPTER_GAP) out[out.length - 1] = chapter
    else out.push(chapter)
  })
  return out.slice(0, MAX_CHAPTERS)
}

/** "0:00", "4:05", or "1:02:03" when `hours`. */
export function formatTimestamp(seconds: number, hours = false): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return hours ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${h * 60 + m}:${sec}`
}

/** What YouTube asks of the timestamps in a description before it shows them as chapters. */
export const YOUTUBE_RULES = { minChapters: 3, minLength: 10 }

export interface YouTubeChapters {
  /** One "0:00 Intro" line per chapter. */
  text: string
  /** Why YouTube would not turn these into chapters (empty when it would). */
  problems: string[]
}

/**
 * The chapters as YouTube description timestamps ("0:00 Intro"), at whole seconds of the
 * `duration`-second video, and what keeps YouTube from using them: the first must be at 0:00,
 * there must be at least 3, and each must last at least 10 seconds.
 */
export function youtubeChapters(chapters: readonly OutputChapter[], duration: number): YouTubeChapters {
  const hours = duration >= 3600
  // Timestamps are whole seconds: two chapters in the same second are one.
  const rows: { s: number; title: string }[] = []
  for (const c of chapters) {
    const s = Math.floor(c.start + 1e-6)
    if (rows.length && rows[rows.length - 1].s === s) rows[rows.length - 1] = { s, title: c.title }
    else rows.push({ s, title: c.title })
  }
  const text = rows.map((r) => `${formatTimestamp(r.s, hours)} ${r.title}`).join('\n')
  const problems: string[] = []
  if (rows.length === 0) return { text, problems: ['Add chapters first.'] }
  if (rows[0].s !== 0) problems.push('YouTube needs the first chapter at 0:00: add one at the start of the video.')
  if (rows.length < YOUTUBE_RULES.minChapters) problems.push(`YouTube needs at least ${YOUTUBE_RULES.minChapters} chapters.`)
  const short = rows.find((r, i) => (i + 1 < rows.length ? rows[i + 1].s : duration) - r.s < YOUTUBE_RULES.minLength)
  if (short) problems.push(`YouTube needs every chapter to last at least ${YOUTUBE_RULES.minLength} seconds ("${short.title}" is shorter).`)
  return { text, problems }
}
