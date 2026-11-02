/**
 * The caption downloads' IPC (ASSETS_CHANNELS, docs/design/captions-studio.md §12): every handler
 * accepts the app's own page only (isAppUrl, as the AI and speech handlers) and catalogue ids only;
 * a download's progress (and "busy, retrying at") goes to the window that asked for it, at most
 * four times a second.
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { ASSETS_CHANNELS, type AssetProgress } from '../shared/api/assets'
import { cancelAssetDownload, downloadAsset, listAssets, removeAsset } from './assets/assetStore'
import { isAppUrl } from './security'

/** Fewest milliseconds between two progress messages of one download (a busy notice always goes). */
export const PROGRESS_EVERY_MS = 250

/** Only the app's own page may download or remove caption assets. */
export function fromApp(e: Pick<IpcMainInvokeEvent, 'senderFrame'>): void {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

/** A catalogue id from the renderer: a short lower-case name, never a path or a URL. */
export function assetId(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-z0-9-]{1,40}$/.test(v)) throw new Error('This download is not one Flown offers.')
  return v
}

/** Progress for one sender, throttled; the last one and every busy notice always arrive. */
function progressTo(sender: WebContents): (p: AssetProgress) => void {
  let last = 0
  return (p) => {
    const now = Date.now()
    if (p.retryAt === undefined && p.received < p.total && now - last < PROGRESS_EVERY_MS) return
    last = now
    if (!sender.isDestroyed()) sender.send(ASSETS_CHANNELS.progress, p)
  }
}

export function registerAssetsIpc(): void {
  ipcMain.handle(ASSETS_CHANNELS.list, (e) => {
    fromApp(e)
    return listAssets()
  })
  ipcMain.handle(ASSETS_CHANNELS.download, (e, id: unknown) => {
    fromApp(e)
    return downloadAsset(assetId(id), { signal: new AbortController().signal, onProgress: progressTo(e.sender) })
  })
  ipcMain.handle(ASSETS_CHANNELS.cancel, (e, id: unknown) => {
    fromApp(e)
    cancelAssetDownload(assetId(id))
  })
  ipcMain.handle(ASSETS_CHANNELS.remove, (e, id: unknown) => {
    fromApp(e)
    return removeAsset(assetId(id))
  })
}
