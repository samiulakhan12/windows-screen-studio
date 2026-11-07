/**
 * The preview's handles of step badges and speech-bubble tails (docs/design/editing-polish.md
 * §2.3, §12): drag them, or move them with the arrow keys.
 *
 * Contracts step: the exported signature of part P3 (§17.3), mounted by PreviewStage; the stub
 * shows nothing. Part P3 writes the body.
 */
import type { SceneLayout } from '../../../shared/engine/layout'
import type { Project } from '../../../shared/types'
import type { Selection } from './selection'

/** What the preview shows at the playhead (useSceneView). */
type SceneView = SceneLayout

export function CalloutHandles(props: { project: Project; selection: Selection; view: SceneView }): JSX.Element | null {
  void props
  return null
}
