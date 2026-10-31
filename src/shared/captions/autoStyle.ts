/**
 * Auto style (docs/design/captions-studio.md §11.6): the look new captions get for the frame's
 * shape and whether the camera leads, and the gate that never replaces a look picked by hand.
 *
 * CONTRACT (part P4): signatures are frozen; bodies are to be written.
 */
import type { CaptionStudio, Project } from '../types'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

/** The tile Auto style picks for the project, its look and the reason shown; null when the gate says no. */
export function autoStyle(project: Project, frame: { w: number; h: number }, brand?: CaptionStudio | null): { tile: string; studio: CaptionStudio; reason: string } | null {
  return notImplemented('autoStyle', project, frame, brand)
}

/** Whether automation may change the look (no `picked`; a Studio look set by automation, or the default legacy look). */
export function autoStyleAllowed(project: Project): boolean {
  return notImplemented('autoStyleAllowed', project)
}

/** `next` with Auto style's look when it is the project's first transcript (`transcribe`, Polish's captions step); no record. */
export function autoStyleOnFirstCaptions(prev: Project, next: Project, frame: { w: number; h: number }, brand?: CaptionStudio | null): Project {
  return notImplemented('autoStyleOnFirstCaptions', prev, next, frame, brand)
}

/** The camera covers at least 20% of the frame, or a camera-only or large-camera layout shows, for half the viewing time. */
export function cameraLed(project: Project, frame: { w: number; h: number }): boolean {
  return notImplemented('cameraLed', project, frame)
}

/** The tile with the gallery's "Suggested" badge (§2.5). */
export function suggestedTile(project: Project, frame: { w: number; h: number }): string {
  return notImplemented('suggestedTile', project, frame)
}
