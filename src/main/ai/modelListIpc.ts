/**
 * The suggested AI models over IPC, and their refresh after an update check while automatic updates
 * are on (NW-15, docs/design/auto-update.md §3). Packaged builds use GitHub; development and the
 * tests only an address they give (SSW_MODEL_LIST_URL).
 */
import { app, ipcMain, net } from 'electron'
import path from 'node:path'
import { MODEL_LIST_URL } from '../../shared/ai/modelList'
import { isAppUrl } from '../security'
import { onUpdateCheckEnded, updatesAuto } from '../updates/updatesIpc'
import { MODEL_CACHE_FILE, loadModelCache, modelList, refreshModelList } from './modelList'

export function registerModelListIpc(): void {
  loadModelCache(path.join(app.getPath('userData'), MODEL_CACHE_FILE), app.getVersion())
  const url = app.isPackaged ? MODEL_LIST_URL : process.env.SSW_MODEL_LIST_URL || null
  if (url) {
    onUpdateCheckEnded(() => {
      if (updatesAuto()) void refreshModelList(url, (u, init) => net.fetch(u, init))
    })
  }
  ipcMain.handle('ai:modelList', (e) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    return modelList()
  })
}
