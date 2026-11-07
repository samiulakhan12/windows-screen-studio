/**
 * Review mode's row for Auto colour (docs/design/editing-polish.md §11): "Camera colour balanced",
 * Keep drops `grade.auto`, Remove puts the camera's colour back.
 *
 * Contracts step: the exported signatures of part P4 (§17.4), stubs listing no row and changing
 * nothing. Part P4 writes the bodies.
 */
import type { Project } from '../types'
import type { ReviewItem, ReviewStatus } from './review'

export function colourReviewItems(project: Project): ReviewItem[] {
  void project
  return []
}

export function colourItemStatus(project: Project, item: ReviewItem): ReviewStatus {
  void project
  void item
  return 'removed'
}

export function keepColourItems(project: Project, items: readonly ReviewItem[]): Project {
  void items
  return project
}

export function removeColourItems(project: Project, items: readonly ReviewItem[]): Project {
  void items
  return project
}
