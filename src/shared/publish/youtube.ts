/**
 * The pack's YouTube description (docs/design/publish-pack.md §2.3, §4.7): the AI's text, then the
 * chapters of the edited video as YouTube timestamps, added by Flown (never by the AI). The dialog's
 * Copy and the export bundle's description file both use composeYoutubeDescription, so they never
 * disagree. Pure.
 */
import { planOf, videoDuration } from '../engine/freeze'
import { outputChapters, youtubeChapters, type OutputChapter } from '../render/chapters'
import { descriptionText } from '../render/exportBundle'
import type { Project } from '../types'
import { cutAt } from './text'

/** YouTube's limit for a description (characters). */
export const YOUTUBE_DESCRIPTION_MAX = 5000

/** The heading line above the timestamps. */
export const CHAPTERS_HEADING = 'Chapters'

/** The chapters of the edited `project` (output seconds) and its length, as the export writes them. */
export function projectYoutubeChapters(project: Pick<Project, 'clips' | 'freezes' | 'chapters'>): { chapters: OutputChapter[]; duration: number } {
  const plan = planOf(project)
  return { chapters: outputChapters(project.chapters ?? [], project.clips, plan), duration: videoDuration(project.clips, plan) }
}

/**
 * The description: `text`, then (with chapters) a blank line, "Chapters" and one "0:00 Intro" line
 * per chapter. Over YouTube's 5 000 characters, the text is cut to fit (the timestamps are kept whole).
 */
export function composeYoutubeDescription(text: string, chapters: readonly OutputChapter[], duration: number): string {
  const body = text.trim()
  const list = chapters.length ? youtubeChapters(chapters, duration).text : ''
  if (!list) return cutAt(body, YOUTUBE_DESCRIPTION_MAX)
  const tail = `${CHAPTERS_HEADING}\n${list}`
  if (!body) return cutAt(tail, YOUTUBE_DESCRIPTION_MAX)
  const room = YOUTUBE_DESCRIPTION_MAX - [...tail].length - 2
  if (room <= 0) return cutAt(tail, YOUTUBE_DESCRIPTION_MAX)
  return `${cutAt(body, room)}\n\n${tail}`
}

/**
 * The export bundle's description file: the copy pack's saved description composed with the chapters
 * of this export, as the dialog's Copy gives it; without one, or for a part of "one file per chapter",
 * the standard description (exportBundle.ts descriptionText).
 */
export function exportDescription(
  project: Pick<Project, 'publish'>,
  title: string,
  length: number,
  chapters: readonly OutputChapter[],
  part?: { index: number; count: number; of: string }
): string {
  if (project.publish?.description && !part) return `${composeYoutubeDescription(project.publish.description, chapters, length)}\n`
  return descriptionText(title, length, chapters, part)
}

/** Tags as YouTube's tag field takes them: comma separated. */
export const tagsText = (tags: readonly string[]): string => tags.join(', ')

/** Tags typed or edited in the dialog, back to a list (commas or line breaks separate them). */
export const parseTags = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
