/**
 * The one way project.json is written (docs/design/auto-blur.md §4.6): a project with covers gets
 * the legacy shapes older Flown draws over each cover (a full-strength pixelate under an opaque box),
 * and its short covers are widened as the reader widens them, so a one-frame hit survives a write and
 * a read. A project without covers is written exactly as before: JSON.stringify(project, null, 2),
 * or without the indent for 'compact' (the version body).
 */
import { widenShort, withLegacyShapes } from '../shared/privacy/coverData'
import type { Project } from '../shared/types'

export function projectFileText(project: Project, form: 'pretty' | 'compact' = 'pretty'): string {
  let out = project
  if (project.covers?.length) {
    const covers = project.covers.map((c) => widenShort(c, project.duration))
    out = withLegacyShapes(covers.some((c, i) => c !== project.covers![i]) ? { ...project, covers } : project)
  }
  return form === 'compact' ? JSON.stringify(out) : JSON.stringify(out, null, 2)
}
