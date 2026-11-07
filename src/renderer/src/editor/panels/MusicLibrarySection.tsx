/**
 * Audio tab, Music: the Library list (docs/design/editing-polish.md §2.6).
 *
 * Contracts step: the exported signature of part P5 (§17.5), mounted by AudioPanel; the stub shows
 * nothing. Part P5 writes the body.
 */
import type { Project } from '../../../../shared/types'

export function MusicLibrarySection(props: { project: Project }): JSX.Element {
  void props
  return <></>
}
