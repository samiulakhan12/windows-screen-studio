import type { Project } from '../types'

/**
 * The name a recording gets when its name is emptied, and the name copies, clips and versions
 * start from when it has none. It is written into the project file, so it is the same in every UI
 * language (docs/design/output-and-languages.md §9.7): a project's name is the user's content.
 */
export const UNTITLED = 'Untitled recording'

/**
 * `project` as it is saved: never with a blank name, which would leave a blank row in the
 * library. Applied to every save, since the name field may never lose focus (the window is
 * closed while it is empty).
 */
export function withSavedName(project: Project): Project {
  return project.name.trim() ? project : { ...project, name: UNTITLED }
}
