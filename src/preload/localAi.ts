import { ipcRenderer } from 'electron'
import { LOCAL_AI_CHANNELS, type LocalAiApi, type LocalAiProgress, type LocalAiState } from '../shared/api/localAi'
import { subscribe } from './ipc'

/** AI on this PC (docs/design/smart-tools.md §9.4); main answers once part P4's localAiIpc.ts registers. */
export const localAiApi: LocalAiApi = {
  localAiState: () => ipcRenderer.invoke(LOCAL_AI_CHANNELS.state),
  downloadLocalModel: (id) => ipcRenderer.invoke(LOCAL_AI_CHANNELS.download, id),
  cancelLocalDownload: (id) => ipcRenderer.invoke(LOCAL_AI_CHANNELS.cancel, id),
  removeLocalModel: (id) => ipcRenderer.invoke(LOCAL_AI_CHANNELS.remove, id),
  setLocalModelUse: (use) => ipcRenderer.invoke(LOCAL_AI_CHANNELS.setUse, use),
  onLocalAiState: (listener) => subscribe<LocalAiState>(LOCAL_AI_CHANNELS.changed, listener),
  onLocalAiProgress: (listener) => subscribe<LocalAiProgress>(LOCAL_AI_CHANNELS.progress, listener)
}
