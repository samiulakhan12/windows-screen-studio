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
  pickCursorImage: (id) => ipcRenderer.invoke('projects:pickCursorImage', id),
  pickAsset: (id, kind) => ipcRenderer.invoke('projects:pickAsset', id, kind),
  assetUrl: (id, file) => ipcRenderer.invoke('projects:assetUrl', id, file),
  detectStill: (id, minSeconds, crop) => ipcRenderer.invoke('projects:detectStill', id, minSeconds, crop),
  stopAnalysis: (id) => ipcRenderer.invoke('projects:stopAnalysis', id),
  backgroundUrl: (id, path) => ipcRenderer.invoke('projects:backgroundUrl', id, path),
  getStyleDefaults: () => ipcRenderer.invoke('styleDefaults:get'),
  saveStyleDefaults: (look) => ipcRenderer.invoke('styleDefaults:save', look),
  resetStyleDefaults: () => ipcRenderer.invoke('styleDefaults:reset')
}
