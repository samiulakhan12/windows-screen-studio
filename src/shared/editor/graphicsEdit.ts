/**
 * Editing motion graphics (docs/design/captions-studio.md §10.5): each function is one update.
 *
 * CONTRACT (part P1): signatures are frozen; bodies are to be written.
 */
import type { Graphic, Project } from '../types'

/** The body of a frozen signature part P1 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

/** A graphic of `kind` added at source time `at` (1.6 s, placed automatically), and its id. */
export function addGraphic(project: Project, kind: Graphic['kind'], at: number, init?: Partial<Graphic>): { project: Project; id: string } {
  return notImplemented('addGraphic', project, kind, at, init)
}

export function updateGraphic(project: Project, id: string, patch: Partial<Graphic>): Project {
  return notImplemented('updateGraphic', project, id, patch)
}

export function moveGraphics(project: Project, ids: readonly string[], dt: number): Project {
  return notImplemented('moveGraphics', project, ids, dt)
}

export function trimGraphic(project: Project, id: string, edge: 'start' | 'end', t: number): Project {
  return notImplemented('trimGraphic', project, id, edge, t)
}

export function deleteGraphics(project: Project, ids: readonly string[]): Project {
  return notImplemented('deleteGraphics', project, ids)
}

/** A graphic placed by the user, or automatically again ('auto'). */
export function placeGraphicAt(project: Project, id: string, place: Graphic['place']): Project {
  return notImplemented('placeGraphicAt', project, id, place)
}
