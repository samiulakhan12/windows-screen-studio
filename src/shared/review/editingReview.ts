/**
 * Review mode's rows for editing polish's automatic changes (docs/design/editing-polish.md §11):
 * Polish's Smooth cuts step (joinReview.ts, kind 'join') and Auto colour (colourReview.ts, kind
 * 'colour'), listed after Captions Studio's kinds at equal times. Each row is pending while its
 * record (`joins.auto`, `grade.auto`) is there; Keep and Remove are each one project out. A project
 * without those records (every project from before) lists nothing.
 */
import type { Project } from "../types";
import {
  colourItemStatus,
  colourReviewItems,
  keepColourItems,
  removeColourItems,
} from "./colourReview";
import type { ReviewKind } from "./copy";
import {
  joinItemStatus,
  joinReviewItems,
  keepJoinItems,
  removeJoinItems,
} from "./joinReview";
import type { ReviewItem, ReviewStatus } from "./review";

/** The kinds of this module, in the order items at the same time are listed (after Captions Studio's). */
export const EDITING_KINDS: readonly ReviewKind[] = ["join", "colour"];
const EDITING_KIND_SET: ReadonlySet<ReviewKind> = new Set(EDITING_KINDS);
export const isEditingKind = (kind: ReviewKind): boolean =>
  EDITING_KIND_SET.has(kind);

/** Editing polish's automatic changes still automatic in `project` (pending by construction), not in order. */
export function editingReviewItems(project: Project): ReviewItem[] {
  if (!project.joins?.auto && !project.grade?.auto) return [];
  return [...joinReviewItems(project), ...colourReviewItems(project)];
}

/** How many rows editingReviewItems gives (the Review button's count). */
export function editingPendingCount(project: Project): number {
  return editingReviewItems(project).length;
}

export function editingItemStatus(
  project: Project,
  item: ReviewItem,
): ReviewStatus {
  return item.kind === "join"
    ? joinItemStatus(project, item)
    : colourItemStatus(project, item);
}

/** `project` with editing polish's pending `items` kept: one project out (`project` itself when nothing changes). */
export function keepEditingItems(
  project: Project,
  items: readonly ReviewItem[],
): Project {
  const joins = items.filter((i) => i.kind === "join");
  const colours = items.filter((i) => i.kind === "colour");
  let next = joins.length ? keepJoinItems(project, joins) : project;
  if (colours.length) next = keepColourItems(next, colours);
  return next;
}

/** `project` with editing polish's pending `items` removed: one project out (`project` itself when nothing changes). */
export function removeEditingItems(
  project: Project,
  items: readonly ReviewItem[],
): Project {
  const joins = items.filter((i) => i.kind === "join");
  const colours = items.filter((i) => i.kind === "colour");
  let next = joins.length ? removeJoinItems(project, joins) : project;
  if (colours.length) next = removeColourItems(next, colours);
  return next;
}
