/**
 * Steering the view that follows the action (docs/design/vertical-video.md §2.6): Hold the view
 * here (a 1× zoom with a fixed point, or the zoom at the playhead fixed), dragging the picture,
 * and the state the Vertical framing section shows. Pure: each edit is one project out (one
 * store.update), positions in full-frame coordinates (through crop.ts fromCrop).
 *
 * CONTRACT (part P3): signatures are frozen; bodies are to be written.
 */
import type { NormRect, Project } from '../types'

/**
 * Holds the view at `centre` (view space) at source time `t`: outside any zoom, a new 1× zoom with
 * that fixed point (3 s, fitted into the free gap, at least 1 s); inside one, that zoom's focus
 * fixed there (a region keeps its rectangle). `crop`: the project's crop (cropOf), null without.
 */
export function holdViewAt(
  project: Project,
  t: number,
  centre: { x: number; y: number },
  crop: NormRect | null
): { project: Project; zoomId: string } | { project: null; reason: 'no-room' } {
  return notImplemented(project, t, centre, crop)
}

/**
 * The picture dragged by `delta` (view units; the content follows the pointer) at source time
 * `t`: the zoom there moves its point (a region its rectangle), else Hold the view here at the
 * dragged centre; without cursor data (`noData`) and no zoom, the rest point moves.
 */
export function dragView(project: Project, t: number, delta: { x: number; y: number }, crop: NormRect | null, noData: boolean): Project {
  return notImplemented(project, t, delta, crop, noData)
}

/** What the Vertical framing section says: off, following, following without cursor data, or a frame that cannot follow. */
export function followStatus(project: Project, cursorValid: boolean, vw: number, vh: number): 'off' | 'following' | 'no-input' | 'unavailable' {
  return notImplemented(project, cursorValid, vw, vh)
}

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
