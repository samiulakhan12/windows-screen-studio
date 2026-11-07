/**
 * Found chapters waiting for review and the user's own (docs/design/smart-tools.md §7.7). A found
 * chapter (`auto` set) is live like a pending zoom: exports, the YouTube description and the
 * progress bar use it. Three places count user chapters only, so a found chapter changes nothing
 * there until it is kept: the copy pack's link check, Captions Studio's Auto chapter titles and the
 * step badges' numbering. Pure.
 */
import type { Chapter, Project } from '../types'

/** The chapters Find chapters or Polish made and the user has not kept or edited yet. */
export function pendingChapters(project: Pick<Project, 'chapters'>): Chapter[] {
  return (project.chapters ?? []).filter((c) => !!c.auto)
}

/** The user's chapters: every chapter without `auto` (all of them in a project from before wave 11). */
export function userChapters(project: Pick<Project, 'chapters'>): Chapter[] {
  const all = project.chapters ?? []
  return all.some((c) => c.auto) ? all.filter((c) => !c.auto) : all
}
