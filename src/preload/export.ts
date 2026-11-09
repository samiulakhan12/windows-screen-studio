import { ipcRenderer } from 'electron'
import type { ExportApi } from '../shared/api/export'

export const exportApi: ExportApi = {
  chooseExportPath: (name, format) => ipcRenderer.invoke('export:choosePath', name, format),
  chooseExportFolder: () => ipcRenderer.invoke('export:chooseFolder'),
  exportBatchPath: (folder, fileName) => ipcRenderer.invoke('export:batchPath', folder, fileName),
  exportCapabilities: () => ipcRenderer.invoke('export:capabilities'),
  analyzeAudio: (projectId, sources) => ipcRenderer.invoke('export:analyzeAudio', projectId, sources),
  exportStart: (projectId, job) => ipcRenderer.invoke('export:start', projectId, job),
  exportFrame: (data) => ipcRenderer.invoke('export:frame', data),
  exportFinish: () => ipcRenderer.invoke('export:finish'),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
  saveThumbnail: (file, png) => ipcRenderer.invoke('export:saveThumbnail', file, png),
  copyFileToClipboard: (file) => ipcRenderer.invoke('export:copyToClipboard', file),
  showItemInFolder: (file) => ipcRenderer.invoke('shell:showItem', file),
  // Output and languages (wave 12, docs/design/output-and-languages.md §4.2).
  probeCodec: (codec) => ipcRenderer.invoke('export:probeCodec', codec),
  exportErrorCode: () => ipcRenderer.invoke('export:errorCode'),
  writeTimeline: (request) => ipcRenderer.invoke('export:writeTimeline', request),
  savePresetFile: (defaultName, presets) => ipcRenderer.invoke('export:savePresetFile', defaultName, presets),
  openPresetFile: () => ipcRenderer.invoke('export:openPresetFile')
}
