/**
 * The project's LUTs, loaded, checked and parsed (docs/design/editing-polish.md §9.5): fetched from
 * the project folder, their SHA-256 checked, parsed with the same strict parser main uses.
 *
 * Contracts step: the exported signatures of part P4 (§17.4), stubs: no LUT is loaded, and
 * prepareLuts resolves at once (prepareEditingAssets awaits it). Part P4 writes the bodies.
 */
import type { CubeLut } from '../../../shared/render/cubeLut'
import type { Project } from '../../../shared/types'

/** The parsed LUT of a grade, or null while it loads (or when it is missing or changed). */
export function lutFor(project: Project, which: 'screen' | 'camera'): CubeLut | null {
  void project
  void which
  return null
}

/** What is wrong with a grade's LUT, or null. */
export function lutProblem(project: Project, which: 'screen' | 'camera'): string | null {
  void project
  void which
  return null
}

/** Loads both grades' LUTs (awaited before an export's first frame). */
export async function prepareLuts(project: Project): Promise<void> {
  void project
}

/** Calls `cb` when a LUT becomes ready; returns the function that stops it. */
export function onLutReady(cb: () => void): () => void {
  void cb
  return () => undefined
}
