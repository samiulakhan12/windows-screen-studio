/**
 * Text tab, Chapters: Progress bar on the video and its settings (docs/design/editing-polish.md §2.4).
 *
 * Contracts step: the exported signature of part P2 (§17.2), mounted by TextPanel; the stub shows
 * nothing. Part P2 writes the body.
 */
import type { Project } from '../../../../shared/types'

export function ChapterBarSection(props: { project: Project }): JSX.Element {
  void props
  return <></>
}
