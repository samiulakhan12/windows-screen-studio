/**
 * User's saved default look ("Save as default style" in the editor), applied to every
 * new recording.
 *
 * CONTRACT: the editor area implements load/save (stored as JSON in userData) and the
 * IPC + UI; the recording area calls applyStyleDefaults() when it creates a project.
 */
import type { Project } from '../shared/types'

/** The parts of a project's look that can be saved as defaults. Image backgrounds are not saved. */
export type StyleDefaults = Pick<Project, 'style' | 'cursor' | 'webcam' | 'effects'>

export async function loadStyleDefaults(): Promise<StyleDefaults | null> {
  return null
}

export async function saveStyleDefaults(_defaults: StyleDefaults | null): Promise<void> {
  // Implemented by the editor area.
}

/**
 * Returns `project` with saved defaults applied. Recording-specific facts win over defaults:
 * cursor.show stays off when the OS cursor is in the video, webcam.show follows hasWebcam.
 */
export function applyStyleDefaults(project: Project, defaults: StyleDefaults | null): Project {
  if (!defaults) return project
  return project
}
