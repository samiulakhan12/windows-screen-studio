import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { VOICE_CHANNELS, type VoiceApi, type VoiceProgress } from '../shared/api/voice'

/** Clean voice (docs/design/clean-voice.md): the cleaned stems of the open project. */
export const voiceApi: VoiceApi = {
  voiceStatus: (projectId, source, strength) => ipcRenderer.invoke(VOICE_CHANNELS.status, projectId, source, strength),
  prepareVoice: (projectId, source, strength, remake) => ipcRenderer.invoke(VOICE_CHANNELS.prepare, projectId, source, strength, remake === true),
  cancelVoice: (projectId) => ipcRenderer.invoke(VOICE_CHANNELS.cancel, projectId),
  onVoiceProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, p: VoiceProgress): void => listener(p)
    ipcRenderer.on(VOICE_CHANNELS.progress, handler)
    return () => ipcRenderer.removeListener(VOICE_CHANNELS.progress, handler)
  }
}
