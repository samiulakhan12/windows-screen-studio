/**
 * The model manager's IPC (SPEECH_CHANNELS, docs/design/offline-captions.md §5.1). Every handler
 * accepts the app's own page only (isAppUrl, as the AI handlers) and catalog ids only; 'speech:changed'
 * goes to the app's windows, at most 4 times a second.
 */
import { app, BrowserWindow, ipcMain, powerMonitor, shell, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { SPEECH_CHANNELS } from '../../shared/api/speech'
import { speechModel } from '../../shared/speech/catalog'
import { isAppUrl } from '../security'
import { resetSpeechWatchdogs, stopAllSpeech } from './helper'
import { onSpeechChanged, speechState, speechStore } from './service'

/** Fewest milliseconds between two 'speech:changed' messages. */
export const CHANGED_EVERY_MS = 250

/** Only the app's own page may manage speech models. */
function fromApp(e: IpcMainInvokeEvent): void {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

/** A catalog id from the renderer; anything else (a path, a URL) is refused. */
function modelId(v: unknown): string {
  const spec = speechModel(v)
  if (!spec) throw new Error('Unknown speech model.')
  return spec.id
}

/**
 * Calls `send` at most once per `everyMs`: the first change at once, later ones folded into one
 * call at the end of the interval (the last state always arrives).
 */
export function throttle(send: () => void, everyMs: number): () => void {
  let last = 0
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer) return
    const wait = Math.max(0, last + everyMs - Date.now())
    timer = setTimeout(() => {
      timer = null
      last = Date.now()
      send()
    }, wait)
  }
}

/** Sends the state to every window showing the app's page. */
async function broadcast(): Promise<void> {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && isAppUrl(w.webContents.getURL()))
  if (windows.length === 0) return
  const state = await speechState().catch((err) => {
    console.warn(`Speech state could not be read: ${err instanceof Error ? err.message : String(err)}`)
    return null
  })
  if (!state) return
  for (const w of windows) if (!w.isDestroyed()) w.webContents.send(SPEECH_CHANNELS.changed, state)
}

export function registerSpeechIpc(): void {
  onSpeechChanged(throttle(() => void broadcast(), CHANGED_EVERY_MS))
  ipcMain.handle(SPEECH_CHANNELS.state, (e) => {
    fromApp(e)
    return speechState()
  })
  ipcMain.handle(SPEECH_CHANNELS.download, (e, id: unknown) => {
    fromApp(e)
    return speechStore().download(modelId(id))
  })
  ipcMain.handle(SPEECH_CHANNELS.cancelDownload, (e, id: unknown, discard: unknown) => {
    fromApp(e)
    return speechStore().cancelDownload(modelId(id), discard === true)
  })
  ipcMain.handle(SPEECH_CHANNELS.remove, (e, id: unknown) => {
    fromApp(e)
    return speechStore().remove(modelId(id))
  })
  ipcMain.handle(SPEECH_CHANNELS.setDefault, (e, id: unknown) => {
    fromApp(e)
    return speechStore().setDefault(modelId(id))
  })
  ipcMain.handle(SPEECH_CHANNELS.showFolder, async (e) => {
    fromApp(e)
    // The fixed models folder only: nothing from the renderer becomes a path.
    const dir = speechStore().dir
    await fs.mkdir(dir, { recursive: true })
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
  })
  // Sleep never looks like a frozen helper.
  try {
    powerMonitor.on('resume', resetSpeechWatchdogs)
  } catch {
    // powerMonitor is not available (tests).
  }
  void speechStore()
    .sweepStaleParts()
    .catch(() => undefined)
  app.on('will-quit', () => {
    // A download stops and keeps its part; helpers die at once.
    speechStore().stopDownloads()
    stopAllSpeech()
  })
}
