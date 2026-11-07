/**
 * Auto colour for the camera (docs/design/editing-polish.md §9.6): Shades-of-Gray on the
 * background, gentle levels, offline.
 *
 * Contracts step: the exported signatures of part P4 (§17.4), stubs. Part P4 writes the bodies.
 */
import type { Rect } from '../engine/layout'
import type { ColorGrade, Project } from '../types'

export interface ColourSample {
  pixels: Uint8ClampedArray
  mask: Uint8ClampedArray | null
  w: number
  h: number
  face: Rect | null
}

/** The camera grade that balances `samples`, or null when they say nothing. */
export function autoCameraGrade(samples: readonly ColourSample[]): ColorGrade | null {
  void samples
  return null
}

/** The camera graded `grade`, with Auto colour's record (an existing one kept). */
export function withAutoColour(project: Project, grade: ColorGrade): Project {
  void grade
  return project
}
