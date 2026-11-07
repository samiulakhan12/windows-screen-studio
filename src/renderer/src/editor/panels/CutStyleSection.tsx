/**
 * Clip tab, a cut selected: the Cut style section (docs/design/editing-polish.md §2.1).
 *
 * Contracts step: the exported signature of part P1 (§17.1), mounted by ClipPanel; the stub shows
 * nothing. Part P1 writes the body.
 */
import type { Project } from '../../../../shared/types'

export function CutStyleSection(props: { project: Project; gap: { start: number; end: number } }): JSX.Element | null {
  void props
  return null
}
