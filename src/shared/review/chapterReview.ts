/**
 * Review mode's rows for found chapters (docs/design/smart-tools.md §13.1): "Chapter “Set up
 * billing” at 1:05" (video time), what found it ("Find chapters · screen change and pause"), Keep
 * drops `auto` (the chapter is then the user's), Remove deletes the chapter and the pending
 * chapter-title card made from it, each in one edit. Pending while the chapter has `auto`; removed
 * when it is gone; kept otherwise.
 */
import { calloutOf, badgesByChapterOf } from '../render/calloutData'
import { formatTimestamp } from '../render/chapters'
import { planOf, videoTimesAt } from '../engine/freeze'
import { withoutChapters } from '../chapters/chapterAuto'
import { pendingChapters } from '../chapters/pending'
import type { AiProviderKind, ChapterOrigin, ChapterSignal, Project } from '../types'
import type { ReviewItem, ReviewStatus } from './review'
import { fmt } from '../i18n/fmt'
import { t, type MessageKey } from '../i18n/t'

export const CHAPTER_KEY = 'chapter:'

/** The message naming each signal in a row's detail (lower case: the signals are listed in a line of facts). */
const SIGNAL_WORDS: Readonly<Record<ChapterSignal, MessageKey>> = {
  start: 'review.chapter.signal.start',
  page: 'review.chapter.signal.page',
  screen: 'review.chapter.signal.screen',
  pause: 'review.chapter.signal.pause',
  idle: 'review.chapter.signal.idle',
  cue: 'review.chapter.signal.cue',
  section: 'review.chapter.signal.section',
  topic: 'review.chapter.signal.topic',
  card: 'review.chapter.signal.card',
  ai: 'review.chapter.signal.ai'
}

const KIND_NAMES: Record<AiProviderKind, string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }

/** Where an AI ran, as a select's choice and the service's own name: this PC, a service's host, the provider's name, or no name ("AI"). */
const placeOf = (origin: ChapterOrigin): { where: 'local' | 'named' | 'other'; place: string } =>
  origin.via === 'local' ? { where: 'local', place: '' } : origin.host ? { where: 'named', place: origin.host } : origin.via ? { where: 'named', place: KIND_NAMES[origin.via] } : { where: 'other', place: '' }

/** Whether the project numbers step badges automatically, by chapter: keeping a found chapter restarts their numbers there. */
function restartsBadges(project: Project): boolean {
  if (project.effects?.badgesByChapter === false) return false
  if (!(project.annotations ?? []).some((a) => a.style === 'badge' && calloutOf(a).number === 'auto')) return false
  return badgesByChapterOf(project.effects ?? {}, 2)
}

/** A found chapter's detail (§13.1): the tool, what found it, who named it, and what keeping it does. */
export function chapterDetail(origin: ChapterOrigin, badges: boolean): string {
  const tool = origin.from.includes('ai') ? t('review.chapter.tool.ai', placeOf(origin)) : t(origin.by === 'polish' ? 'review.chapter.tool.polish' : 'review.chapter.tool.find')
  // The detail is a line of facts with middle dots between them.
  const parts = [tool]
  const signals = origin.from.filter((s) => s !== 'ai').map((s) => t(SIGNAL_WORDS[s]))
  if (signals.length) parts.push(fmt.list(signals))
  if (origin.name === 'ai') parts.push(t('review.chapter.namedBy', placeOf(origin)))
  if (badges) parts.push(t('review.chapter.restartsSteps'))
  return parts.join(' · ')
}

/** A row for each pending found chapter, `chapter:<id>`, in time order. */
export function chapterReviewItems(project: Project): ReviewItem[] {
  const pending = pendingChapters(project).filter((c) => Number.isFinite(c.t))
  if (!pending.length) return []
  const clips = project.clips
  const times = clips.length ? videoTimesAt(clips, planOf(project), pending.map((c) => c.t)) : pending.map((c) => c.t)
  const badges = restartsBadges(project)
  return pending
    .map((c, i) => ({
      key: `${CHAPTER_KEY}${c.id}`,
      kind: 'chapter' as const,
      start: c.t,
      end: c.t,
      title: t('review.chapter.title', { title: c.title.replace(/\s+/g, ' ').trim(), time: formatTimestamp(times[i], times[i] >= 3600) }),
      detail: chapterDetail(c.auto!, badges)
    }))
    .sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
}

/** How many found chapters wait for review. */
export function chapterPendingCount(project: Project): number {
  return pendingChapters(project).length
}

const idOf = (item: ReviewItem): string | null => (item.key.startsWith(CHAPTER_KEY) ? item.key.slice(CHAPTER_KEY.length) : null)

/** Pending while the chapter has `auto`; removed when it is gone; kept otherwise. */
export function chapterItemStatus(project: Project, item: ReviewItem): ReviewStatus {
  const id = idOf(item)
  const chapter = id === null ? undefined : (project.chapters ?? []).find((c) => c.id === id)
  if (!chapter) return 'removed'
  return chapter.auto ? 'pending' : 'kept'
}

/** The ids of the pending found chapters `items` name. */
function pendingIds(project: Project, items: readonly ReviewItem[]): Set<string> {
  const wanted = new Set(items.map(idOf).filter((id): id is string => id !== null))
  return new Set(pendingChapters(project).filter((c) => wanted.has(c.id)).map((c) => c.id))
}

/** `project` with the found chapters of `items` kept (`auto` dropped), in one edit; itself when none is pending. */
export function keepChapterItems(project: Project, items: readonly ReviewItem[]): Project {
  const ids = pendingIds(project, items)
  if (!ids.size) return project
  return {
    ...project,
    chapters: (project.chapters ?? []).map((c) => {
      if (!ids.has(c.id)) return c
      const { auto: _auto, ...mine } = c
      return mine
    })
  }
}

/** `project` without the found chapters of `items` and their pending chapter-title cards, in one edit; itself when none is pending. */
export function removeChapterItems(project: Project, items: readonly ReviewItem[]): Project {
  return withoutChapters(project, pendingIds(project, items))
}
