import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { RecorderCommand, StudioApi } from '../shared/api'
import type { RecordingStatus } from '../shared/types'

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: StudioApi = {
  platform: process.platform,
  getSources: () => ipcRenderer.invoke('sources:list'),
  prepareCapture: (sourceId, systemAudio) => ipcRenderer.invoke('recording:prepare', sourceId, systemAudio),
  recordingStarted: (startedAt) => ipcRenderer.invoke('recording:started', startedAt),
  setRecordingStatus: (status) => ipcRenderer.invoke('recording:status', status),
  saveRecording: (payload) => ipcRenderer.invoke('recording:save', payload),
  cancelRecording: () => ipcRenderer.invoke('recording:cancel'),
  sendRecorderCommand: (command) => ipcRenderer.invoke('recording:command', command),
  onRecorderCommand: (cb) => subscribe<RecorderCommand>('recorder:command', cb),
  onRecordingStatus: (cb) => subscribe<RecordingStatus>('recording:status', cb),
  onProcessing: (cb) => subscribe<string>('processing', cb),

  listProjects: () => ipcRenderer.invoke('projects:list'),
  loadProject: (id) => ipcRenderer.invoke('projects:load', id),
  saveProject: (project) => ipcRenderer.invoke('projects:save', project),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  revealProject: (id) => ipcRenderer.invoke('projects:reveal', id),
  pickBackgroundImage: (id) => ipcRenderer.invoke('projects:pickBackground', id),

  chooseExportPath: (name, format) => ipcRenderer.invoke('export:choosePath', name, format),
  exportStart: (projectId, job) => ipcRenderer.invoke('export:start', projectId, job),
  exportFrame: (frame) => ipcRenderer.invoke('export:frame', frame),
  exportFinish: () => ipcRenderer.invoke('export:finish'),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
  showItemInFolder: (file) => ipcRenderer.invoke('shell:showItem', file)
}

contextBridge.exposeInMainWorld('api', api)
