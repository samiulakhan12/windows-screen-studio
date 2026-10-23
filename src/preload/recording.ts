import { ipcRenderer } from 'electron'
import type { RecorderCommand, RecordingApi } from '../shared/api/recording'
import type { RecordingStatus } from '../shared/types'
import { subscribe } from './ipc'

export const recordingApi: RecordingApi = {
  getSources: () => ipcRenderer.invoke('sources:list'),
  prepareCapture: (sourceId, systemAudio) => ipcRenderer.invoke('recording:prepare', sourceId, systemAudio),
  recordingStarted: (startedAt) => ipcRenderer.invoke('recording:started', startedAt),
  setRecordingStatus: (status) => ipcRenderer.invoke('recording:status', status),
  saveRecording: (payload) => ipcRenderer.invoke('recording:save', payload),
  cancelRecording: () => ipcRenderer.invoke('recording:cancel'),
  sendRecorderCommand: (command) => ipcRenderer.invoke('recording:command', command),
  onRecorderCommand: (cb) => subscribe<RecorderCommand>('recorder:command', cb),
  onRecordingStatus: (cb) => subscribe<RecordingStatus>('recording:status', cb),
  onProcessing: (cb) => subscribe<string>('processing', cb)
}
