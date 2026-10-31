/**
 * The settle rule of automatic caption changes (docs/design/captions-studio.md §11.8): a hand
 * change to an automatic thing makes it the user's; marks, anchors and places follow their words.
 *
 * CONTRACT (part P4): the signature is frozen; the body is to be written.
 */
import type { Project } from '../types'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

/** `next` settled against `prev` (rules 1–4 of §11.8); `next` itself when nothing changes. */
export function settleCaptionAuto(next: Project, prev: Project): Project {
  return notImplemented('settleCaptionAuto', next, prev)
}
