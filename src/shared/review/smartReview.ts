/**
 * Smart tools' rows in Review mode (docs/design/smart-tools.md §13.1), hooked into review.ts after
 * Captions Studio's (captionReview.ts) and editing polish's (editingReview.ts) at equal times: a row
 * for each found chapter (part P2's chapterReview.ts). The shorter version's cuts are AutoCut records
 * (`by: 'short'`) and ride the cut rows with their own kind; its smooth cuts ride wave 10's join row.
 *
 * Every function returns at once, without calling chapterReview, for a project without found
 * chapters (every project from before wave 11): no rows, a count of 0, the project itself.
 */
import { pendingChapters } from '../chapters/pending'
import type { Project } from '../types'
import { chapterItemStatus, chapterPendingCount, chapterReviewItems, keepChapterItems, removeChapterItems } from './chapterReview'
import type { ReviewKind, ReviewStatus } from './copy'
import type { ReviewItem } from './review'

/** The kinds this aggregator answers for: 'chapter' only ('short' rides the cut rows). */
export function isSmartKind(kind: ReviewKind): boolean {
  return kind === 'chapter'
}

const hasFound = (project: Project): boolean => pendingChapters(project).length > 0

/** The rows of the found chapters waiting for review. */
export function smartReviewItems(project: Project): ReviewItem[] {
  return hasFound(project) ? chapterReviewItems(project) : []
}

/** How many of them wait (the Review button's count). */
export function smartPendingCount(project: Project): number {
  return hasFound(project) ? chapterPendingCount(project) : 0
}

/** A found chapter row's status, read from `project`. */
export function smartItemStatus(project: Project, item: ReviewItem): ReviewStatus {
  return chapterItemStatus(project, item)
}

/** `project` with the smart rows of `items` kept; itself when there are none. */
export function keepSmartItems(project: Project, items: readonly ReviewItem[]): Project {
  const mine = items.filter((i) => isSmartKind(i.kind))
  return mine.length ? keepChapterItems(project, mine) : project
}

/** `project` with the smart rows of `items` removed; itself when there are none. */
export function removeSmartItems(project: Project, items: readonly ReviewItem[]): Project {
  const mine = items.filter((i) => isSmartKind(i.kind))
  return mine.length ? removeChapterItems(project, mine) : project
}
