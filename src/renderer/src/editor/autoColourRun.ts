/**
 * Running Auto colour on the camera's frames (docs/design/editing-polish.md §9.6).
 *
 * Contracts step: the exported signature of part P4 (§17.4), a stub that finds nothing. Part P4
 * writes the body.
 */
import type { ColorGrade, Project } from '../../../shared/types'

export async function runAutoColour(deps: { project: Project; webcamUrl: string; signal: AbortSignal }): Promise<ColorGrade | null> {
  void deps
  return null
}
