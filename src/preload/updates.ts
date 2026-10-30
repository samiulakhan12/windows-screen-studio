import { ipcRenderer } from 'electron'
import type { UpdatesApi } from '../shared/api/updates'
import { subscribe } from './ipc'

export const updatesApi: UpdatesApi = {
  updatesGet: () => ipcRenderer.invoke('updates:get'),
  updatesCheck: () => ipcRenderer.invoke('updates:check'),
  updatesDownload: () => ipcRenderer.invoke('updates:download'),
  updatesInstall: () => ipcRenderer.invoke('updates:install'),
  updatesSetAuto: (on) => ipcRenderer.invoke('updates:setAuto', on),
  onUpdatesChanged: (listener) => subscribe('updates:changed', listener)
}
