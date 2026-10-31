/**
 * Generating graphics from captions (docs/design/captions-studio.md §10.2): one switch per kind,
 * density limits, ownership and ids made from content.
 *
 * CONTRACT (part P4): signatures are frozen; bodies are to be written.
 */
import type { MarksAnswer } from '../api/ai'
import type { Project } from '../types'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

/** The project with the automatic graphics, lower thirds, chapter titles and quote cards made again. */
export function planGraphics(
  project: Project,
  opts: { keywords: boolean; emoji: boolean; counters: boolean; lists: boolean; speakers: boolean; chapters: boolean; quotes: boolean; sound: 'none' | 'pop' | 'ding'; marks?: MarksAnswer }
): Project {
  return notImplemented('planGraphics', project, opts)
}

/** A generated item's id: 'g-' and the FNV-1a hash of kind, source, first word and text (§10.2). */
export function graphicId(kind: string, source: string, word: number, text: string): string {
  return notImplemented('graphicId', kind, source, word, text)
}
