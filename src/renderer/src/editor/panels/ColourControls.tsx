/**
 * The colour controls of the screen or the camera: looks, sliders, LUT, Compare, Reset
 * (docs/design/editing-polish.md §2.5, §12).
 *
 * Contracts step: the exported signature of part P4 (§17.4); the stub shows nothing. Part P4 writes
 * the body.
 */
import type { Project } from '../../../../shared/types'

export function ColourControls(props: { project: Project; which: 'screen' | 'camera' }): JSX.Element {
  void props
  return <></>
}
