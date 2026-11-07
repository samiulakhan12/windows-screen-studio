/**
 * Adding and editing animated callouts (docs/design/editing-polish.md §2.3, §7): step badges,
 * speech bubbles, an item's motions and sound, and a badge's or a tail's pin. Each is one project
 * out (one store.update, one undo step).
 *
 * Contracts step: the exported signatures of part P3 (§17.3), stubs that change nothing. Part P3
 * writes the bodies.
 */
import type { CalloutMotion, Project, SfxRef } from '../types'

export function addBadge(project: Project, t: number, at: { pin: { x: number; y: number } | null; x: number; y: number }, language: string | null): { project: Project; id: string } {
  void t
  void at
  void language
  return { project, id: '' }
}

export function addBubble(
  project: Project,
  t: number,
  at: {
    pin: { x: number; y: number }
    body: { dx: number; dy: number }
    x: number
    y: number
  }
): { project: Project; id: string } {
  void t
  void at
  return { project, id: '' }
}

/** An item's motions and sound (null: the default). */
export function withCallout(
  project: Project,
  ref: { kind: 'annotation' | 'shape' | 'title'; id: string },
  patch: {
    enter?: CalloutMotion | null
    exit?: CalloutMotion | null
    sound?: 'none' | SfxRef | null
  }
): Project {
  void ref
  void patch
  return project
}

/** A badge's or a tail's pin moved, with where it shows in the frame written to x, y. */
export function movePin(project: Project, id: string, pin: { x: number; y: number }, shownAt: { x: number; y: number }): Project {
  void id
  void pin
  void shownAt
  return project
}

/** A bubble's body moved around its tip. */
export function moveBody(project: Project, id: string, body: { dx: number; dy: number }, shownAt: { x: number; y: number }): Project {
  void id
  void body
  void shownAt
  return project
}
