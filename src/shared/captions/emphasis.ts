/**
 * Auto emphasis, offline (docs/design/captions-studio.md §11.1): a score per word, and the picks.
 *
 * CONTRACT (part P4): signatures are frozen; bodies are to be written.
 */
import type { CaptionMark, CaptionSegment, Clip, CursorTrack, Project } from '../types'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

/** Every word's score (candidates at 2.5 or more), with phrases of capitalised words joined (`to`). */
export function emphasisScores(segments: readonly CaptionSegment[], ctx: { language?: string; cursor?: CursorTrack; clips: Clip[] }): { caption: string; word: number; to: number; score: number }[] {
  return notImplemented('emphasisScores', segments, ctx)
}

/** The automatic marks for captions without marks: at most one word in eight (§11.1). */
export function pickEmphasis(project: Project, opts?: { maxShare?: number }): CaptionMark[] {
  return notImplemented('pickEmphasis', project, opts)
}
