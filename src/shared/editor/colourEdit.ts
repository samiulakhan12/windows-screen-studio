/**
 * Editing the colour of the screen and the camera (docs/design/editing-polish.md §2.5, §16): each
 * one project out.
 *
 * Contracts step: the exported signatures of part P4 (§17.4), stubs that change nothing
 * (`settleGrade` returns `next` itself). Part P4 writes the bodies.
 */
import type { ColorGrade, ColorLut, LookId, Project } from '../types'

export function withGrade(project: Project, which: 'screen' | 'camera', patch: Partial<ColorGrade> | null): Project {
  void which
  void patch
  return project
}

export function resetSlider(project: Project, which: 'screen' | 'camera', key: keyof ColorGrade): Project {
  void which
  void key
  return project
}

export function withLook(project: Project, which: 'screen' | 'camera', look: LookId | null, strength?: number): Project {
  void which
  void look
  void strength
  return project
}

export function withLut(project: Project, which: 'screen' | 'camera', lut: ColorLut | null): Project {
  void which
  void lut
  return project
}

/** `next` with Auto colour's record dropped when the camera grade was changed by hand; `next` itself when nothing applies. */
export function settleGrade(next: Project, prev: Project): Project {
  void prev
  return next
}
