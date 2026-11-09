import { ipcRenderer } from 'electron'
import type { UiApi } from '../shared/api/ui'

/** The UI language's calls (docs/design/output-and-languages.md §9.4). The preload makes no text itself. */
export const uiApi: UiApi = {
  uiInfo: () => ipcRenderer.invoke('ui:info'),
  setUiPrefs: (prefs) => ipcRenderer.invoke('ui:setPrefs', prefs),
  relaunch: (reopenProjectId) => ipcRenderer.invoke('ui:relaunch', reopenProjectId),
  noteLanguageSeen: (language) => ipcRenderer.invoke('ui:noteSeen', language),
  confirm: (request) => ipcRenderer.invoke('ui:confirm', request)
}
