import type { SaveMeta, SyncSaveResult } from '../editor/autosave'
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
  /** URL of a background image stored in the project folder, or null if it is missing. */
  backgroundUrl(projectId: string, path: string): Promise<string | null>
}
