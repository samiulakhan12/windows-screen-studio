import type { DuplicateProgress } from '../../../shared/api/projects'
import type { CopyKind } from '../../../shared/editor/duplicate'
import type { Project } from '../../../shared/types'

/*
 * The title bar's copy menu and the progress of a copy being made (X-04, NW-05,
 * docs/design/vertical-video.md §2.2, §2.3).
 *
 * CONTRACT (part P4): the props are frozen; the bodies are to be written. The editor (part P3)
 * mounts CopyMenu in its title bar and CopyProgress while a copy runs.
 */

/** The copy button right of the name field and its menu: Make a vertical version, Make a square version, Duplicate. */
export function CopyMenu(props: { project: Project; vw: number; vh: number; run(kind: CopyKind): void }): JSX.Element {
  void props
  throw new Error('not implemented')
}

/** The modal shown while a copy takes longer than 0.5 s: what is copied, a progress bar and Cancel. */
export function CopyProgress(props: { kind: CopyKind; name: string; progress: DuplicateProgress | null; onCancel(): void }): JSX.Element {
  void props
  throw new Error('not implemented')
}
