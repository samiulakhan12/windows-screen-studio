import { ipcRenderer } from 'electron'
import type { ExportBundleApi } from '../shared/api/exportBundle'

export const exportBundleApi: ExportBundleApi = {
  writeSidecar: (anchor, kind, content, language) => ipcRenderer.invoke('exportBundle:write', anchor, kind, content, ...(language ? [language] : []))
}
