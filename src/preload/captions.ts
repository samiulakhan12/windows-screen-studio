import { ipcRenderer } from 'electron'
import type { CaptionsApi } from '../shared/api/captions'

export const captionsApi: CaptionsApi = {
  saveCaptions: (defaultName, format, content) => ipcRenderer.invoke('captions:save', defaultName, format, content)
}
