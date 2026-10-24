import { timelineGaps } from '../../../shared/editor/clips'
import type { Project } from '../../../shared/types'

/** What the user has selected on the timeline. Times are source seconds. */
export type Selection =
  | { kind: 'zoom'; id: string }
  | { kind: 'annotation'; id: string }
  | { kind: 'clip'; id: string }
  | { kind: 'shape'; id: string }
  | { kind: 'spotlight'; id: string }
  | { kind: 'layout'; id: string }
  | { kind: 'title'; id: string }
  | { kind: 'chapter'; id: string }
  | { kind: 'gap'; start: number; end: number }
  | { kind: 'range'; start: number; end: number }
  | null

/** The selection if it still refers to something in `project` (e.g. after undo), else null. */
export function validSelection(sel: Selection, project: Project): Selection {
  if (!sel) return null
  switch (sel.kind) {
    case 'zoom':
      return project.zooms.some((z) => z.id === sel.id) ? sel : null
    case 'annotation':
      return project.annotations.some((a) => a.id === sel.id) ? sel : null
    case 'clip':
      return project.clips.some((c) => c.id === sel.id) ? sel : null
    case 'shape':
      return (project.shapes ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'spotlight':
      return (project.spotlights ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'layout':
      return (project.layouts ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'title':
      return (project.titles ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'chapter':
      return (project.chapters ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'gap':
      return timelineGaps(project.clips, project.duration).some((g) => Math.abs(g.start - sel.start) < 1e-6 && Math.abs(g.end - sel.end) < 1e-6)
        ? sel
        : null
    case 'range':
      return sel.end - sel.start > 0.01 ? sel : null
  }
}

export const selectionKey = (sel: Selection): string => (!sel ? '' : 'id' in sel ? `${sel.kind}:${sel.id}` : `${sel.kind}:${sel.start}:${sel.end}`)
