import type { EditorServices } from '../editor/context'
import type { SceneView } from './stubProps'

/** The magnified view of what is under a peeked cover (§2.8), preview only. Stub from the contracts step: part P1 draws it; until then nothing. */
export function PeekInset(props: { services: EditorServices; view: SceneView }): JSX.Element | null {
  void props
  return null
}
