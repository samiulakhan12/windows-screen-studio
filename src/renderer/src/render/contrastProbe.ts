/**
 * The contrast meter's measurement (docs/design/captions-studio.md §7.3): paused and after a seek
 * only, on a `willReadFrequently` canvas, never during playback.
 *
 * CONTRACT (part P2): the signature is frozen; the body is to be written.
 */
import type { CaptionStudio, Project } from '../../../shared/types'

/** The body of a frozen signature part P2 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P2)`)
}

export function probeContrast(project: Project, t: number, studio: CaptionStudio): Promise<{ ratio: number; at: number } | null> {
  return notImplemented('probeContrast', project, t, studio)
}
