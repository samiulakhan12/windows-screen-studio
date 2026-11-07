import { ipcRenderer } from 'electron'
import { SMART_PROJECT_CHANNELS, type DuplicateProgress, type ProjectsApi } from '../shared/api/projects'
import { subscribe } from './ipc'

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
  importAssetData: (id, kind, name, bytes) => ipcRenderer.invoke('projects:importAssetData', id, kind, name, bytes),
  clipboardImage: (withBytes) => ipcRenderer.invoke('projects:clipboardImage', withBytes),
  assetUrl: (id, file) => ipcRenderer.invoke('projects:assetUrl', id, file),
  detectStill: (id, minSeconds, crop) => ipcRenderer.invoke('projects:detectStill', id, minSeconds, crop),
  stopAnalysis: (id) => ipcRenderer.invoke('projects:stopAnalysis', id),
  backgroundUrl: (id, path) => ipcRenderer.invoke('projects:backgroundUrl', id, path),
  getStyleDefaults: () => ipcRenderer.invoke('styleDefaults:get'),
  saveStyleDefaults: (look) => ipcRenderer.invoke('styleDefaults:save', look),
  resetStyleDefaults: () => ipcRenderer.invoke('styleDefaults:reset'),
  // X-04 duplicate (docs/design/vertical-video.md §4.7).
  duplicateProject: (sourceId, copy) => ipcRenderer.invoke('projects:duplicate', sourceId, copy),
  onDuplicateProgress: (listener) => subscribe<DuplicateProgress>('projects:duplicateProgress', listener),
  cancelDuplicate: () => {
    void ipcRenderer.invoke('projects:duplicateCancel').catch(() => undefined)
  },
  // Smart tools (docs/design/smart-tools.md §20.0): the scene scan (part P2) and what copies cost (part P3).
  detectScenes: (id, crop) => ipcRenderer.invoke(SMART_PROJECT_CHANNELS.detectScenes, id, crop),
  onSceneProgress: (listener) => subscribe<{ id: string; fraction: number }>(SMART_PROJECT_CHANNELS.sceneProgress, listener),
  copyCost: (id) => ipcRenderer.invoke(SMART_PROJECT_CHANNELS.copyCost, id)
}
