import { ipcRenderer } from 'electron'
import type { ShareApi } from '../shared/api/share'
import { subscribe } from './ipc'

export const shareApi: ShareApi = {
  shareTargets: (refresh) => ipcRenderer.invoke('share:targets', refresh === true),
  shareSetFolder: (id, on) => ipcRenderer.invoke('share:setFolder', id, on),
  sharePickFolder: () => ipcRenderer.invoke('share:pickFolder'),
  shareAddHook: (label, url) => ipcRenderer.invoke('share:addHook', label, url),
  shareRemoveHook: (id) => ipcRenderer.invoke('share:removeHook', id),
  shareTestHook: (id) => ipcRenderer.invoke('share:testHook', id),
  shareOffer: (file, meta, auto) => ipcRenderer.invoke('share:offer', file, meta, auto),
  shareStart: (file, targets, meta) => ipcRenderer.invoke('share:start', file, targets, meta),
  shareCancel: (runId) => ipcRenderer.invoke('share:cancel', runId),
  shareRuns: (file) => ipcRenderer.invoke('share:runs', file),
  onShareUpdate: (listener) => subscribe('share:update', listener)
}
