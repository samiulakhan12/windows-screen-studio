/**
 * Review mode's row for Polish's Smooth cuts step (docs/design/editing-polish.md §11): "Smooth cuts
 * at 37 cuts", Keep drops `joins.auto`, Remove puts `was` back. Pending while the record is there;
 * after that, kept while every cut's style is still the Smooth Polish set, removed otherwise.
 */
import { cutsWithoutOwnStyle } from '../editor/joinsEdit'
import { planOf } from '../engine/freeze'
import { cutsOf } from '../render/joins'
import type { Project, ProjectJoins } from '../types'
import type { ReviewItem, ReviewStatus } from './review'

export const JOIN_ALL_KEY = 'join:all'
export const JOIN_DETAIL = 'Polish'

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The row's title, with the cut count now ("Smooth cuts at 37 cuts"). */
export const joinTitle = (cuts: number): string => `Smooth cuts at ${plural(cuts, 'cut')}`

export function joinReviewItems(project: Project): ReviewItem[] {
  if (!project.joins?.auto) return []
  const first = cutsOf(project.clips, planOf(project))[0]
  const at = first ? project.clips[first.index].start : (project.clips[0]?.start ?? 0)
  return [{ key: JOIN_ALL_KEY, kind: 'join', start: at, end: at, title: joinTitle(cutsWithoutOwnStyle(project)), detail: JOIN_DETAIL }]
}

export function joinItemStatus(project: Project, item: ReviewItem): ReviewStatus {
  if (item.key !== JOIN_ALL_KEY) return 'removed'
  const j = project.joins
  if (j?.auto) return 'pending'
  return j?.all && j.all.kind === 'smooth' && Object.keys(j.all).length === 1 ? 'kept' : 'removed'
}

/** `project` with `joins` (an empty one deleted). */
function withJoins(project: Project, joins: ProjectJoins): Project {
  if (Object.keys(joins).length > 0) return { ...project, joins }
  const { joins: _gone, ...rest } = project
  return rest
}

const lists = (items: readonly ReviewItem[]): boolean => items.some((i) => i.key === JOIN_ALL_KEY)

export function keepJoinItems(project: Project, items: readonly ReviewItem[]): Project {
  const j = project.joins
  if (!j?.auto || !lists(items)) return project
  const { auto: _auto, ...rest } = j
  return withJoins(project, rest)
}

export function removeJoinItems(project: Project, items: readonly ReviewItem[]): Project {
  const j = project.joins
  if (!j?.auto || !lists(items)) return project
  const { auto, all: _all, ...rest } = j
  return withJoins(project, auto.was ? { all: auto.was, ...rest } : rest)
}
