import { ipcRenderer } from 'electron'
import type { ProcessingProgress, RecorderCommand, RecordingApi, ToolbarStatus } from '../shared/api/recording'
import { subscribe } from './ipc'

export const recordingApi: RecordingApi = {
  getSources: (kinds) => ipcRenderer.invoke('sources:list', kinds),
  prepareCapture: (request) => ipcRenderer.invoke('recording:prepare', request),
  appendRecordingChunk: (token, kind, data) => ipcRenderer.invoke('recording:chunk', token, kind, data),
  startNativeVideo: (token) => ipcRenderer.invoke('recording:startNative', token),
  recordingStarted: (token, info) => ipcRenderer.invoke('recording:started', token, info),
  setRecordingStatus: (token, status) => ipcRenderer.invoke('recording:status', token, status),
  saveRecording: (token, payload) => ipcRenderer.invoke('recording:save', token, payload),
  cancelRecording: (token) => ipcRenderer.invoke('recording:cancel', token),
  sendRecorderCommand: (command) => ipcRenderer.invoke('recording:command', command),
  getRecordingStatus: () => ipcRenderer.invoke('recording:getStatus'),
  pickRegion: (sourceId) => ipcRenderer.invoke('recording:pickRegion', sourceId),
  finishRegion: (region) => ipcRenderer.send('region:done', region),
  listUnfinishedRecordings: () => ipcRenderer.invoke('recordings:unfinished'),
  recoverRecording: (id) => ipcRenderer.invoke('recordings:recover', id),
  finishProcessingLater: () => ipcRenderer.invoke('recordings:finishLater'),
  openPrivacySettings: (kind) => ipcRenderer.invoke('recording:privacySettings', kind),
  onRecorderCommand: (cb) => subscribe<RecorderCommand>('recorder:command', cb),
  onRecorderWarning: (cb) => subscribe<string>('recorder:warning', cb),
  onRecordingStatus: (cb) => subscribe<ToolbarStatus>('recording:status', cb),
  onProcessing: (cb) => subscribe<ProcessingProgress>('processing', cb)
}
