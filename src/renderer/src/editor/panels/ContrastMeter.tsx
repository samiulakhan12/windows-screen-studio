/**
 * The contrast meter (docs/design/captions-studio.md §7.3): the static figure with a dependable
 * surround, else measured at the playhead while paused, with Fix.
 *
 * CONTRACT (part P3): the signature is frozen; the body is to be written.
 */
import type { Project } from '../../../../shared/types'

/** The body of a frozen signature part P3 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P3)`)
}

export function ContrastMeter(props: { project: Project; t: number; paused: boolean }): JSX.Element {
  return notImplemented('ContrastMeter', props)
}
