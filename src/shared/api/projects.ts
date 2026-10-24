import type { SaveMeta, SyncSaveResult } from '../editor/autosave'
import type { StyleDefaults } from '../editor/styleDefaults'
import type { CursorTrack, Project, ProjectSummary } from '../types'

export interface LoadedProject {
  project: Project
  cursor: CursorTrack
  dir: string
  screenUrl: string
  webcamUrl: string | null
  backgroundUrl: string | null
}

export interface ProjectsApi {
  listProjects(): Promise<ProjectSummary[]>
  loadProject(id: string): Promise<LoadedProject>
  /** `meta` lets main drop a save that arrives after a newer one from the same editor session. */
  saveProject(project: Project, meta?: SaveMeta): Promise<void>
  /** Blocking save for when the window is closing (beforeunload). Never throws. */
  saveProjectSync(project: Project, meta?: SaveMeta): SyncSaveResult
  deleteProject(id: string): Promise<void>
  revealProject(id: string): Promise<void>
  pickBackgroundImage(projectId: string): Promise<{ url: string; path: string } | null>
  /**
   * Lets the user pick an image for a custom cursor and copies it into the project folder
   * (cursor.<ext>); null when cancelled. Rejects with a readable message for an unsupported
   * or oversized file.
   */
  pickCursorImage(projectId: string): Promise<{ url: string; path: string } | null>
  /** URL of a background image stored in the project folder, or null if it is missing. */
  backgroundUrl(projectId: string, path: string): Promise<string | null>
  /** The look new recordings start with, or null when the built-in look is used. */
  getStyleDefaults(): Promise<StyleDefaults | null>
  /**
   * Saves `look` (usually a project's style, cursor, camera and effects) as the look of new
   * recordings and returns what was stored: image backgrounds and cursor/camera visibility are left out.
   */
  saveStyleDefaults(look: StyleDefaults): Promise<StyleDefaults | null>
  /** Forgets the saved look, so new recordings use the built-in one again. */
  resetStyleDefaults(): Promise<void>
}
