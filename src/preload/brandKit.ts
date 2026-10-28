import { ipcRenderer } from 'electron'
import type { BrandKitApi } from '../shared/api/brandKit'

export const brandKitApi: BrandKitApi = {
  getBrandKit: () => ipcRenderer.invoke('brandKit:get'),
  saveBrandKit: (kit) => ipcRenderer.invoke('brandKit:save', kit),
  pickBrandFile: (kind) => ipcRenderer.invoke('brandKit:pickFile', kind),
  brandFile: (file) => ipcRenderer.invoke('brandKit:file', file),
  copyBrandKitInto: (projectId) => ipcRenderer.invoke('brandKit:copyInto', projectId)
}
