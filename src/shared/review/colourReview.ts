/**
 * Review mode's row for Auto colour (docs/design/editing-polish.md §11): "Camera colour balanced",
 * detail "Auto colour", at the first clip's start. Pending while Auto colour's record
 * (`grade.auto`) is there; Keep drops the record (the colour becomes the user's), Remove puts back
 * the camera's colour from before the first run (deleted when there was none) and drops the record.
 * Each is one project out, so one undo step. Once settled, the row reads kept while the camera's
 * grade is still what Auto colour set when the row was listed, removed otherwise.
 */
import { withProjectGrade } from '../editor/colourEdit'
import type { ColorGrade, Project } from '../types'
import type { ReviewItem, ReviewStatus } from './review'

export const COLOUR_KEY = 'colour:camera'
export const COLOUR_TITLE = 'Camera colour balanced'
export const COLOUR_DETAIL = 'Auto colour'

/** The camera grade Auto colour had set when each row was listed (its status reads it after Keep). */
const setWhenListed = new WeakMap<ReviewItem, string>()
const keyOf = (g: ColorGrade | undefined): string => JSON.stringify(g ?? null)

export function colourReviewItems(project: Project): ReviewItem[] {
  if (!project.grade?.auto) return []
  const at = project.clips[0]?.start ?? 0
  const item: ReviewItem = { key: COLOUR_KEY, kind: 'colour', start: at, end: at, title: COLOUR_TITLE, detail: COLOUR_DETAIL }
  setWhenListed.set(item, keyOf(project.grade.camera))
  return [item]
}

export function colourItemStatus(project: Project, item: ReviewItem): ReviewStatus {
  if (item.key !== COLOUR_KEY) return 'removed'
  if (project.grade?.auto) return 'pending'
  const set = setWhenListed.get(item)
  if (set !== undefined) return set !== keyOf(undefined) && keyOf(project.grade?.camera) === set ? 'kept' : 'removed'
  // A row made elsewhere: kept while the camera has a colour of its own.
  return project.grade?.camera ? 'kept' : 'removed'
}

const lists = (items: readonly ReviewItem[]): boolean => items.some((i) => i.key === COLOUR_KEY)

export function keepColourItems(project: Project, items: readonly ReviewItem[]): Project {
  const g = project.grade
  if (!g?.auto || !lists(items)) return project
  const { auto: _auto, ...rest } = g
  return withProjectGrade(project, rest)
}

export function removeColourItems(project: Project, items: readonly ReviewItem[]): Project {
  const g = project.grade
  if (!g?.auto || !lists(items)) return project
  const { auto, camera: _camera, ...rest } = g
  return withProjectGrade(project, auto.camera ? { ...rest, camera: auto.camera } : rest)
}
