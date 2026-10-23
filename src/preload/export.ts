import { ipcRenderer } from 'electron'
import type { ExportApi } from '../shared/api/export'

export const exportApi: ExportApi = {
  chooseExportPath: (name, format) => ipcRenderer.invoke('export:choosePath', name, format),
  exportCapabilities: () => ipcRenderer.invoke('export:capabilities'),
  exportStart: (projectId, job) => ipcRenderer.invoke('export:start', projectId, job),
  exportFrame: (data) => ipcRenderer.invoke('export:frame', data),
  exportFinish: () => ipcRenderer.invoke('export:finish'),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
  copyFileToClipboard: (file) => ipcRenderer.invoke('export:copyToClipboard', file),
  showItemInFolder: (file) => ipcRenderer.invoke('shell:showItem', file)
}
