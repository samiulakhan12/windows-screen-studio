import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AiApi, TranscribeProgress } from '../shared/api/ai'

export const aiApi: AiApi = {
  listAiProviders: () => ipcRenderer.invoke('ai:listProviders'),
  getAiModelList: () => ipcRenderer.invoke('ai:modelList'),
  saveAiProvider: (input) => ipcRenderer.invoke('ai:saveProvider', input),
  removeAiProvider: (id) => ipcRenderer.invoke('ai:removeProvider', id),
  testAiProvider: (id) => ipcRenderer.invoke('ai:testProvider', id),
  transcribe: (projectId, options) => ipcRenderer.invoke('ai:transcribe', projectId, options),
  cancelTranscription: (projectId) => ipcRenderer.invoke('ai:cancelTranscription', projectId),
  onTranscribeProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, progress: TranscribeProgress): void => listener(progress)
    ipcRenderer.on('ai:transcribeProgress', handler)
    return () => ipcRenderer.removeListener('ai:transcribeProgress', handler)
  },
  aiText: (providerId, request, requestId) => ipcRenderer.invoke('ai:text', providerId, request, requestId),
  cancelAiText: (requestId) => ipcRenderer.invoke('ai:cancelText', requestId),
  draftScript: (providerId, request) => ipcRenderer.invoke('ai:draftScript', providerId, request),
  cancelScriptDraft: () => ipcRenderer.invoke('ai:cancelScriptDraft')
}
