/**
 * Camera tab: Colour, with Auto colour (docs/design/editing-polish.md §2.5).
 *
 * Contracts step: the exported signature of part P4 (§17.4), mounted by CameraPanel; the stub
 * shows nothing. Part P4 writes the body.
 */
import type { Project } from '../../../../shared/types'

export function CameraColourSection(props: { project: Project }): JSX.Element | null {
  void props
  return null
}
