import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { SpeechApi, SpeechState } from '../shared/api/speech'

/** Captions on this PC: the model manager (channel names are SPEECH_CHANNELS, checked by tests/speechContracts.test.ts). */
export const speechApi: SpeechApi = {
  getSpeechState: () => ipcRenderer.invoke('speech:state'),
  downloadSpeechModel: (id) => ipcRenderer.invoke('speech:download', id),
  cancelSpeechDownload: (id, discard) => ipcRenderer.invoke('speech:cancelDownload', id, discard === true),
  removeSpeechModel: (id) => ipcRenderer.invoke('speech:remove', id),
  setDefaultSpeechModel: (id) => ipcRenderer.invoke('speech:setDefault', id),
  showSpeechModelsFolder: () => ipcRenderer.invoke('speech:showFolder'),
  onSpeechState: (listener) => {
    const handler = (_e: IpcRendererEvent, state: SpeechState): void => listener(state)
    ipcRenderer.on('speech:changed', handler)
    return () => ipcRenderer.removeListener('speech:changed', handler)
  }
}
