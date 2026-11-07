/**
 * Applying found chapters, settling them and Polish's step (docs/design/smart-tools.md §7.7, §13.3).
 * Part P2 writes the bodies; the contracts' stubs return their input, so nothing changes until then.
 */
import type { SceneScan } from '../api/projects'
import type { PolishInput } from '../editor/polish'
import type { ChapterOrigin, Project } from '../types'

/** `project` with the found chapters `found` in place of its pending ones (and their pending chapter-title cards), in one update. */
export function withFoundChapters(project: Project, found: readonly { t: number; title: string; origin: ChapterOrigin }[]): Project {
  void found
  return project
}

/** `project` without its pending found chapters (Review's Remove all found chapters). */
export function withoutPendingChapters(project: Project): Project {
  return project
}

/** The settle chain's step: a found chapter edited by hand (its `t` or `title` changed, its `auto` the same object) loses `auto`. `next` itself when nothing applies. */
export function settleChapters(next: Project, prev: Project): Project {
  void prev
  return next
}

/** Polish's Find chapters step: offline, Normal, every signal, `by: 'polish'`. */
export function polishChapters(project: Project, input: PolishInput & { scan: SceneScan | null }): Project {
  void input
  return project
}
