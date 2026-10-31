/**
 * Cues of a translated track (docs/design/captions-studio.md §11.10): each spoken cue's output
 * times with the track's text.
 *
 * CONTRACT (part P4): signatures are frozen; bodies are to be written.
 */
import type { Project } from '../types'
import type { Cue } from './subtitles'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

export function trackCues(project: Project, language: string): Cue[] {
  return notImplemented('trackCues', project, language)
}

/** A WebVTT file of the track (`names`: speaker names in the cues). */
export function trackVtt(project: Project, language: string, names: boolean): string {
  return notImplemented('trackVtt', project, language, names)
}
