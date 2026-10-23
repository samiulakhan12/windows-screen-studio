import { ipcRenderer } from 'electron'
import type { ExportApi } from '../shared/api/export'

export const exportApi: ExportApi = {
  chooseExportPath: (name, format) => ipcRenderer.invoke('export:choosePath', name, format),
  exportStart: (projectId, job) => ipcRenderer.invoke('export:start', projectId, job),
  exportFrame: (frame) => ipcRenderer.invoke('export:frame', frame),
  exportFinish: () => ipcRenderer.invoke('export:finish'),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
  showItemInFolder: (file) => ipcRenderer.invoke('shell:showItem', file)
}
