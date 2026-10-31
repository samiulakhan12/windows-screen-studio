/**
 * Runs Make my captions great (docs/design/captions-studio.md §11.8): gathers the AI marks first
 * (cancellable), then one sealed update of the planner: one undo step.
 *
 * CONTRACT (part P4): the signature is frozen; the body is to be written.
 */
import type { GreatOptions } from '../../../shared/captions/great'
import type { EditStore } from '../../../shared/editor/editStore'
import type { Project } from '../../../shared/types'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

export async function runCaptionsGreat(deps: { store: EditStore<Project>; frame: { w: number; h: number }; options: GreatOptions; signal: AbortSignal }): Promise<{ notice: string } | null> {
  return notImplemented('runCaptionsGreat', deps)
}
