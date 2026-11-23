/**
 * Review's private rows (docs/design/auto-blur.md §2.7, §14.3): one row per group of found covers or
 * private bleeps, with its places as parts. Stubs from the contracts step with the shapes
 * smartReview.ts has: part P5 fills them. Until then there is no private row, nothing is pending, and
 * Keep and Remove change nothing.
 */
import type { PrivateKind, Project } from '../types'
import type { ReviewItem, ReviewStatus } from './review'

/** One row per group, its places as `parts`. Stub: none. */
export function privacyReviewItems(project: Project): ReviewItem[] {
  void project
  return []
}

/** How many private rows wait (through privacyIndex). Stub: none. */
export function privacyPendingCount(project: Project): number {
  void project
  return 0
}

/** A private row's status, read from its covers' `found` and its bleeps' `auto`. Stub: kept. */
export function privacyStatus(project: Project, item: ReviewItem): ReviewStatus {
  void project
  void item
  return 'kept'
}

/** Keep covered: every cover and bleep of the rows the user's. Stub: the project itself. */
export function privacyKeep(project: Project, items: readonly ReviewItem[]): Project {
  void items
  return project
}

/** Uncover: the rows' covers and bleeps deleted, their paths remembered as rejected places. Stub: the project itself. */
export function privacyRemove(project: Project, items: readonly ReviewItem[]): Project {
  void items
  return project
}

/** The private rows in Review's order: Check rows first, then by start (for ReviewPanel). Stub: as given. */
export function privacyOrder(items: readonly ReviewItem[], project: Project): ReviewItem[] {
  void project
  return [...items]
}

/** The kinds of the private rows present, for the kind filter. Stub: none. */
export function privacyKinds(project: Project): PrivateKind[] {
  void project
  return []
}

/** Done reviewing: every waiting private suggestion kept. Stub: the project itself. */
export function doneReviewing(project: Project): Project {
  return project
}
