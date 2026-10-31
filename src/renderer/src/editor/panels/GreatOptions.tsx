/**
 * The options of Make my captions great (§2.8): a dialog popover, focus kept inside, Esc returns to its button. Mounted with props { project: Project } (docs/design/captions-studio.md §14.4).
 *
 * CONTRACT (part P4): the signature is frozen; the body is to be written.
 */
import type { Project } from '../../../../shared/types'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

export function GreatOptionsPopover(props: { project: Project }): JSX.Element {
  return notImplemented('GreatOptionsPopover', props)
}
