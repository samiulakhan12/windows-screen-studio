/**
 * The pack's YouTube description (docs/design/publish-pack.md §2.3, §4.7): the AI's text, then the
 * chapters of the edited video as YouTube timestamps, added by Flown (never by the AI). The dialog's
 * Copy and the export bundle's description file both use composeYoutubeDescription, so they never
 * disagree. Pure.
 */
import { musicCredit } from '../audio/soundLibrary'
import { planOf, videoDuration } from '../engine/freeze'
import { outputChapters, youtubeChapters, type OutputChapter } from '../render/chapters'
import { descriptionText } from '../render/exportBundle'
import type { Project } from '../types'
import { cutAt, typedText } from './text'

/** YouTube's limit for a description (characters). */
export const YOUTUBE_DESCRIPTION_MAX = 5000

/** The heading line above the timestamps. */
export const CHAPTERS_HEADING = 'Chapters'

/**
 * The music credit the description ends with (editing polish §10.10, owner decision 4): "Music:
 * <title> by <artist> (CC0)" while a library bed is the music, else null. Loyalty Freak Music asks
 * for credit where possible, and it is the best answer to a false Content ID claim.
 */
export function youtubeMusicCredit(project: Partial<Pick<Project, 'audio'>>): string | null {
  return project.audio ? musicCredit(project as Project) : null
}

/** The chapters of the edited `project` (output seconds), its length, and the music credit, as the export writes them. */
export function projectYoutubeChapters(project: Pick<Project, 'clips' | 'freezes' | 'chapters'> & Partial<Pick<Project, 'audio'>>): { chapters: OutputChapter[]; duration: number; credit: string | null } {
  const plan = planOf(project)
  return { chapters: outputChapters(project.chapters ?? [], project.clips, plan), duration: videoDuration(project.clips, plan), credit: youtubeMusicCredit(project) }
}

/**
 * The description's text as "Use for exports" saves it and Copy composes it: as typed (typedText),
 * at most YouTube's 5 000 characters. So the export's file is exactly what Copy gives.
 */
export const descriptionBody = (text: unknown): string => typedText(text, YOUTUBE_DESCRIPTION_MAX)

/** `s` without "<" and ">", which YouTube refuses in a description: they become "‹" and "›". */
const withoutAngleBrackets = (s: string): string => s.replace(/</g, '‹').replace(/>/g, '›')

/**
 * The description: `text`, then (with chapters) a blank line, "Chapters" and one "0:00 Intro" line
 * per chapter, with "<" and ">" as "‹" and "›" ("Settings › Export"). Over YouTube's 5 000
 * characters, the text is cut to fit (the timestamps are kept whole: cutAt). With a music `credit`
 * (youtubeMusicCredit), it is the last line, after a blank line, and the rest makes room for it.
 */
export function composeYoutubeDescription(text: string, chapters: readonly OutputChapter[], duration: number, credit: string | null = null): string {
  const last = credit ? withoutAngleBrackets(credit.replace(/\s+/g, ' ').trim()) : ''
  if (!last) return composeWithin(text, chapters, duration, YOUTUBE_DESCRIPTION_MAX)
  const rest = composeWithin(text, chapters, duration, YOUTUBE_DESCRIPTION_MAX - [...last].length - 2)
  return rest ? `${rest}\n\n${last}` : last
}

/** composeYoutubeDescription without the credit, in at most `max` characters. */
function composeWithin(text: string, chapters: readonly OutputChapter[], duration: number, max: number): string {
  const body = withoutAngleBrackets(text.trim())
  const list = chapters.length ? withoutAngleBrackets(youtubeChapters(chapters, duration).text) : ''
  if (!list) return cutAt(body, max)
  const tail = `${CHAPTERS_HEADING}\n${list}`
  if (!body) return cutAt(tail, max)
  const room = max - [...tail].length - 2
  if (room <= 0) return cutAt(tail, max)
  return `${cutAt(body, room)}\n\n${tail}`
}

/**
 * What any export can write of the saved description `text`, for the link check (§4.8): the
 * description composed with `chapters` (as Copy and an export with them write it) and, when that cuts
 * the text to fit them, the rest of the text from the piece the cut fell in, which an export with
 * fewer chapters, or none, writes too. So Use for exports asks about all of it.
 */
export function descriptionToCheck(text: string, chapters: readonly OutputChapter[], duration: number, credit: string | null = null): string {
  const composed = composeYoutubeDescription(text, chapters, duration, credit)
  const whole = composeYoutubeDescription(text, [], duration, credit)
  if (!whole || composed === whole || composed.startsWith(`${whole}\n\n`)) return composed
  let same = 0
  while (same < whole.length && composed[same] === whole[same]) same++
  return `${composed}\n\n${whole.slice(whole.slice(0, same).search(/[^\t\n\f\r ]*$/))}`
}

/**
 * The export bundle's description file: the copy pack's saved description composed with the chapters
 * of this export, as the dialog's Copy gives it; without one, or for a part of "one file per chapter",
 * the standard description (exportBundle.ts descriptionText).
 */
export function exportDescription(
  project: Pick<Project, 'publish'> & Partial<Pick<Project, 'audio'>>,
  title: string,
  length: number,
  chapters: readonly OutputChapter[],
  part?: { index: number; count: number; of: string }
): string {
  if (project.publish?.description && !part) return `${composeYoutubeDescription(project.publish.description, chapters, length, youtubeMusicCredit(project))}\n`
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
