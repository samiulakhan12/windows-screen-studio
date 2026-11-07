/**
 * Review mode's rows for found chapters (docs/design/smart-tools.md §13.1): "Chapter “Set up
 * billing” at 1:05", Keep drops `auto`, Remove deletes the chapter and its pending chapter-title
 * card. Part P2 writes the bodies; until then the contracts' stubs list nothing and change nothing.
 */
import type { Project } from '../types'
import type { ReviewItem, ReviewStatus } from './review'

/** A row for each pending found chapter, `chapter:<id>`. */
export function chapterReviewItems(project: Project): ReviewItem[] {
  void project
  return []
}

/** How many found chapters wait for review. */
export function chapterPendingCount(project: Project): number {
  void project
  return 0
}

/** Pending while the chapter has `auto`; removed when it is gone; kept otherwise. */
export function chapterItemStatus(project: Project, item: ReviewItem): ReviewStatus {
  void project
  void item
  return 'removed'
}

/** `project` with the found chapters of `items` kept (`auto` dropped), in one edit. */
export function keepChapterItems(project: Project, items: readonly ReviewItem[]): Project {
  void items
  return project
}

/** `project` without the found chapters of `items` and their pending chapter-title cards, in one edit. */
export function removeChapterItems(project: Project, items: readonly ReviewItem[]): Project {
  void items
  return project
}
