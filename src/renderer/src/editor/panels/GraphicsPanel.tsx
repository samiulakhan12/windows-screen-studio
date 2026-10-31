/**
 * Inspector › Graphics (docs/design/captions-studio.md §2.11): Add pop-ups from captions, the Add
 * menu and the list of graphics, or the selected graphic's fields.
 *
 * CONTRACT (part P3): the signature is frozen; the body is to be written.
 */
import type { Project } from '../../../../shared/types'
import type { Selection } from '../selection'

/** The body of a frozen signature part P3 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P3)`)
}

export function GraphicsPanel(props: { project: Project; selection: Selection }): JSX.Element {
  return notImplemented('GraphicsPanel', props)
}
