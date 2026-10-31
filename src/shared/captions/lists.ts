/**
 * Lists spoken in captions (docs/design/captions-studio.md §11.5): an announcement and its items.
 *
 * CONTRACT (part P4): the signature is frozen; the body is to be written.
 */
import type { CaptionSegment } from '../types'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

/** The lists announced in the captions, with 2 items or more. */
export function findLists(segments: readonly CaptionSegment[], language?: string): { title: string; items: { text: string; at: number }[]; caption: string }[] {
  return notImplemented('findLists', segments, language)
}
