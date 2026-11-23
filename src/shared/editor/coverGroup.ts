/**
 * Covers among the items selected together (docs/design/auto-blur.md §14.4): the branches every
 * switch of multi-select and group edit takes for the kind 'cover'. Covers are items of the Covers
 * row; a group's bar selects every cover of its group; a time move moves only covers with one key
 * (a followed cover stays, privacy.cover.timeKept); delete writes suggestions' paths to
 * privacy.rejected; the look is the colour. Every change drops `found`, `missed` and `thin`.
 */
import { pathKeys } from '../privacy/coverPath'
import type { Cover, Project } from '../types'
import { deleteCovers, moveCoverTime, setCoverColour } from './coverEdit'
import type { Look } from './groupEdit'
import type { ItemEntry, ItemTrack } from './multiSelect'

/** The Covers row's items, by start. */
export function coverItems(project: Project): ItemEntry[] {
  return (project.covers ?? []).map((c) => ({ key: `cover:${c.id}` as const, kind: 'cover' as const, id: c.id, track: 'covers' as const, start: c.start, end: c.end }))
}

/** The timeline row covers sit on. */
export function coverTrackOf(): ItemTrack {
  return 'covers'
}

/** Whether a cover follows moving text (more than one key): it keeps its times when moved (§2.3). */
export const followsText = (c: Pick<Cover, 'path'>): boolean => pathKeys(c).length > 1

/**
 * Covers `ids` moved in time by `dt`: covers with one key move (held inside the recording); a cover
 * that follows text is left in place and listed in `refused` (the caller says privacy.cover.timeKept).
 */
export function moveCoversInTime(project: Project, ids: readonly string[], dt: number): { project: Project; refused: string[] } {
  let q = project
  const refused: string[] = []
  for (const id of ids) {
    const next = moveCoverTime(q, id, dt)
    if (next === null) {
      if ((q.covers ?? []).some((c) => c.id === id)) refused.push(id)
      continue
    }
    q = next
  }
  return { project: q, refused }
}

/** The project without covers `ids`, suggestions' paths written to privacy.rejected (one update). */
export function deleteCoverItems(project: Project, ids: readonly string[]): Project {
  return deleteCovers(project, ids)
}

/** A cover's look: its colour. */
export function coverLookOf(cover: Cover): Look {
  return { cls: 'cover', values: { 'cover.color': cover.color }, label: '' }
}

/** The look's colour on covers `ids` (each change drops `found`). */
export function pasteCoverLook(project: Project, ids: readonly string[], look: Look): Project {
  const color = look.values['cover.color']
  return typeof color === 'string' ? setCoverColour(project, ids, color) : project
}

/** Whether cover `id` can be selected: it is in the project. */
export function validCoverSelection(project: Project, id: string): boolean {
  return (project.covers ?? []).some((c) => c.id === id)
}

/** The covers a group's bar selects (§2.3): every cover of the group of `coverId`, or that cover alone without a group. */
export function groupCoverIds(project: Project, coverId: string): string[] {
  const covers = project.covers ?? []
  const c = covers.find((x) => x.id === coverId)
  if (!c) return []
  if (!c.group) return [c.id]
  return covers.filter((x) => x.group === c.group).map((x) => x.id)
}
