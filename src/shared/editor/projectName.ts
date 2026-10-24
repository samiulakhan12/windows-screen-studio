import type { Project } from '../types'

/** The name a recording gets when its name is emptied. */
export const UNTITLED = 'Untitled recording'

/**
 * `project` as it is saved: never with a blank name, which would leave a blank row in the
 * library. Applied to every save, since the name field may never lose focus (the window is
 * closed while it is empty).
 */
export function withSavedName(project: Project): Project {
  return project.name.trim() ? project : { ...project, name: UNTITLED }
}
