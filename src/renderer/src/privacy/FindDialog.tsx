import type { EditorServices } from '../editor/context'

/** The *Find private info* dialog (§2.5). Stub from the contracts step: part P5 draws it; until then it closes at once and shows nothing. */
export function FindDialog(props: { services: EditorServices; onClose: () => void; mode: 'find' | 'again' }): JSX.Element {
  void props
  return <></>
}
