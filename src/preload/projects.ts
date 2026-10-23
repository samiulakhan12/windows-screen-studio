import { ipcRenderer } from 'electron'
import type { ProjectsApi } from '../shared/api/projects'

export const projectsApi: ProjectsApi = {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  loadProject: (id) => ipcRenderer.invoke('projects:load', id),
  saveProject: (project, meta) => ipcRenderer.invoke('projects:save', project, meta),
  saveProjectSync: (project, meta) => {
    try {
      return ipcRenderer.sendSync('projects:saveSync', project, meta) ?? { ok: false, error: 'No response from the app' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  revealProject: (id) => ipcRenderer.invoke('projects:reveal', id),
  pickBackgroundImage: (id) => ipcRenderer.invoke('projects:pickBackground', id),
  backgroundUrl: (id, path) => ipcRenderer.invoke('projects:backgroundUrl', id, path)
}
