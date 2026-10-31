/**
 * What a card replaces while it shows (docs/design/captions-studio.md §10.1): the chunk holding
 * an anchored keyword's words, and the caption of an automatic quote card. Used by the Studio
 * layer and the legacy shownAt (one of its three guarded calls).
 *
 * CONTRACT (part P1): the signature is frozen; the body is to be written.
 */
import type { Project } from '../types'

/** The body of a frozen signature part P1 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

/** The captions and chunks replaced at source time `t`; empty without anchored keywords and automatic quote cards. */
export function replacedAt(project: Project, t: number): { captions: ReadonlySet<string>; chunks: readonly { caption: string; word: number }[] } {
  return notImplemented('replacedAt', project, t)
}
