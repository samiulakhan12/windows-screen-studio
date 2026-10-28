import { ipcRenderer, webUtils } from 'electron'
import type { ImportApi, ImportProgress } from '../shared/api/import'
import { subscribe } from './ipc'

export const importApi: ImportApi = {
  importPickedVideo: () => ipcRenderer.invoke('import:pick'),
  importVideoFile: (path) => ipcRenderer.invoke('import:file', path),
  cancelImport: () => ipcRenderer.invoke('import:cancel'),
  onImportProgress: (cb) => subscribe<ImportProgress>('import:progress', cb),
  importPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
}
