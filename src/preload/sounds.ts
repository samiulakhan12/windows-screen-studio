import { ipcRenderer } from 'electron'
import { SOUNDS_CHANNELS, type SoundsApi } from '../shared/api/sounds'

/** The unwanted-sound finder (docs/design/sound-finder.md): decoding the open project's sound, and its cached scores. */
export const soundsApi: SoundsApi = {
  soundsCached: (projectId, source) => ipcRenderer.invoke(SOUNDS_CHANNELS.cached, projectId, source),
  soundsOpen: (projectId, source) => ipcRenderer.invoke(SOUNDS_CHANNELS.open, projectId, source),
  soundsRead: (stream) => ipcRenderer.invoke(SOUNDS_CHANNELS.read, stream),
  soundsClose: (stream) => ipcRenderer.invoke(SOUNDS_CHANNELS.close, stream),
  soundsSave: (projectId, source, entry) => ipcRenderer.invoke(SOUNDS_CHANNELS.save, projectId, source, entry)
}
