import { ipcRenderer } from 'electron'
import type { PrefsApi } from '../shared/api/prefs'

export const prefsApi: PrefsApi = {
  getPref: (key) => ipcRenderer.invoke('prefs:get', key),
  setPref: (key, value) => ipcRenderer.invoke('prefs:set', key, value)
}
