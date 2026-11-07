/**
 * Review mode's row for Polish's Smooth cuts step (docs/design/editing-polish.md §11): "Smooth cuts
 * at 37 cuts", Keep drops `joins.auto`, Remove puts `was` back.
 *
 * Contracts step: the exported signatures of part P1 (§17.1), stubs listing no row and changing
 * nothing. Part P1 writes the bodies.
 */
import type { Project } from "../types";
import type { ReviewItem, ReviewStatus } from "./review";

export function joinReviewItems(project: Project): ReviewItem[] {
  void project;
  return [];
}

export function joinItemStatus(
  project: Project,
  item: ReviewItem,
): ReviewStatus {
  void project;
  void item;
  return "removed";
}

export function keepJoinItems(
  project: Project,
  items: readonly ReviewItem[],
): Project {
  void items;
  return project;
}

export function removeJoinItems(
  project: Project,
  items: readonly ReviewItem[],
): Project {
  void items;
  return project;
}
