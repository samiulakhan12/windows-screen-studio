import { ipcRenderer } from 'electron'
import type { AssetProgress, AssetsApi } from '../shared/api/assets'
import { subscribe } from './ipc'

// Channel names as in ASSETS_CHANNELS (src/shared/api/assets.ts), written out like the other
// preload files, so the sandboxed preload bundle imports nothing but types. The main process
// handlers are in src/main/assetsIpc.ts, with their sender checks.
export const assetsApi: AssetsApi = {
  listAssets: () => ipcRenderer.invoke('assets:list'),
  downloadAsset: (id) => ipcRenderer.invoke('assets:download', id),
  cancelAssetDownload: (id) => ipcRenderer.invoke('assets:cancel', id),
  removeAsset: (id) => ipcRenderer.invoke('assets:remove', id),
  onAssetProgress: (cb) => subscribe<AssetProgress>('assets:progress', cb)
}
