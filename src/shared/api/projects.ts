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
  saveProject(project: Project): Promise<void>
  deleteProject(id: string): Promise<void>
  revealProject(id: string): Promise<void>
  pickBackgroundImage(projectId: string): Promise<{ url: string; path: string } | null>
}
