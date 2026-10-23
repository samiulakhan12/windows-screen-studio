import { ipcRenderer } from 'electron'
import type { ProjectsApi } from '../shared/api/projects'

export const projectsApi: ProjectsApi = {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  loadProject: (id) => ipcRenderer.invoke('projects:load', id),
  saveProject: (project) => ipcRenderer.invoke('projects:save', project),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  revealProject: (id) => ipcRenderer.invoke('projects:reveal', id),
  pickBackgroundImage: (id) => ipcRenderer.invoke('projects:pickBackground', id)
}
