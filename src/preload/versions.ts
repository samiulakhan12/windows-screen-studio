import { ipcRenderer } from 'electron'
import type { VersionsApi } from '../shared/api/versions'

// E-12 versions (docs/design/versions.md §2.5).
export const versionsApi: VersionsApi = {
  listVersions: (projectId) => ipcRenderer.invoke('versions:list', projectId),
  saveVersion: (projectId, project, opts) => ipcRenderer.invoke('versions:save', projectId, project, opts),
  renameVersion: (projectId, versionId, name) => ipcRenderer.invoke('versions:rename', projectId, versionId, name),
  deleteVersion: (projectId, versionId) => ipcRenderer.invoke('versions:delete', projectId, versionId),
  readVersion: (projectId, versionId) => ipcRenderer.invoke('versions:read', projectId, versionId)
}
