/**
 * Emphasis marks and per-caption places (docs/design/captions-studio.md §2.7, §11.1): toggling
 * emphasis, and keeping marks, word anchors and places on their words through edits.
 *
 * CONTRACT (part P1): signatures are frozen; bodies are to be written.
 */
import type { CaptionMark, Project } from '../types'

/** The body of a frozen signature part P1 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

/** The marks of each caption, by caption id. */
export function marksByCaption(marks: readonly CaptionMark[] | undefined): ReadonlyMap<string, readonly CaptionMark[]> {
  return notImplemented('marksByCaption', marks)
}

/** Emphasis toggled on the words of `spans` (removed when all are emphasised, else added; tone 2 with Ctrl+Shift+B); the twin on a legacy look. */
export function toggleEmphasis(project: Project, spans: readonly { caption: string; from: number; to: number }[], tone?: 2): Project {
  return notImplemented('toggleEmphasis', project, spans, tone)
}

/** Every emphasis mark removed. */
export function clearEmphasis(project: Project): Project {
  return notImplemented('clearEmphasis', project)
}

/** Marks, graphic anchors and captionPlaces of `next` remapped after its captions changed from `prev`'s (§11.1); `next` itself when nothing changed. */
export function remapAnchors(next: Project, prev: Project): Project {
  return notImplemented('remapAnchors', next, prev)
}

/** Caption `caption` placed at the top or the bottom, or back to the look's place (null). */
export function withCaptionPlace(project: Project, caption: string, position: 'top' | 'bottom' | null): Project {
  return notImplemented('withCaptionPlace', project, caption, position)
}
