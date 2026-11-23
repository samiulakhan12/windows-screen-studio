/**
 * Covers among the items selected together (docs/design/auto-blur.md §14.4): the branches every
 * switch of multi-select and group edit takes for the kind 'cover'. Stubs from the contracts step:
 * part P1 fills them. Until then covers are not selectable with others (validCoverSelection is false,
 * so validSelection drops them), list no items and are never moved, deleted or restyled here.
 */
import type { Cover, Project } from '../types'
import type { Look } from './groupEdit'
import type { ItemEntry, ItemTrack } from './multiSelect'

/** The Covers row's items, by start. Stub: none. */
export function coverItems(project: Project): ItemEntry[] {
  void project
  return []
}

/** The timeline row covers sit on. */
export function coverTrackOf(): ItemTrack {
  return 'covers'
}

/** Covers moved in time by `dt`: only covers with one key move; a followed cover is refused (privacy.cover.timeKept). Stub: nothing moves. */
export function moveCoversInTime(project: Project, ids: readonly string[], dt: number): { project: Project; refused: string[] } {
  void ids
  void dt
  return { project, refused: [] }
}

/** The project without covers `ids`, suggestions' paths written to privacy.rejected. Stub: the project itself. */
export function deleteCoverItems(project: Project, ids: readonly string[]): Project {
  void ids
  return project
}

/** A cover's look: its colour. */
export function coverLookOf(cover: Cover): Look {
  return { cls: 'cover', values: { 'cover.color': cover.color }, label: '' }
}

/** The look's colour on covers `ids` (each change drops `found`). Stub: the project itself. */
export function pasteCoverLook(project: Project, ids: readonly string[], look: Look): Project {
  void ids
  void look
  return project
}

/** Whether cover `id` can be selected. Stub: never (covers are not selectable yet). */
export function validCoverSelection(project: Project, id: string): boolean {
  void project
  void id
  return false
}

/** The covers a group's bar selects: every cover of the group of `coverId`. Stub: none. */
export function groupCoverIds(project: Project, coverId: string): string[] {
  void project
  void coverId
  return []
}
