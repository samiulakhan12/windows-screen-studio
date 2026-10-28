import { ipcRenderer } from 'electron'
import type { StorageApi } from '../shared/api/storage'

export const storageApi: StorageApi = {
  storageScan: () => ipcRenderer.invoke('storage:scan'),
  storageSetRules: (rules) => ipcRenderer.invoke('storage:setRules', rules),
  storagePlan: () => ipcRenderer.invoke('storage:plan'),
  storageClean: (items) => ipcRenderer.invoke('storage:clean', items),
  storageNoteOpened: (id) => ipcRenderer.send('storage:opened', id),
  storageNoteClosed: (id) => ipcRenderer.send('storage:closed', id)
}
