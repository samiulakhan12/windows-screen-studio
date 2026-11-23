import type { Selection } from '../editor/selection'
import type { Project } from '../../../shared/types'
import type { SceneView } from './stubProps'

/** The selected cover's eight handles and group outlines on the preview (§2.2). Stub from the contracts step: part P1 draws them; until then nothing. */
export function CoverHandles(props: { project: Project; selection: Selection; view: SceneView }): JSX.Element | null {
  void props
  return null
}
