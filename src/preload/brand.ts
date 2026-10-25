import { ipcRenderer } from 'electron'
import type { BrandApi } from '../shared/api/brand'

export const brandApi: BrandApi = {
  getAppInfo: () => ipcRenderer.invoke('brand:app-info'),
  openCompanyWebsite: () => ipcRenderer.invoke('brand:open-website')
}
