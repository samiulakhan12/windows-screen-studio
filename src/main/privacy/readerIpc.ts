/**
 * The text reader's channels (docs/design/auto-blur.md §10.7, §5.12): its state, its download,
 * cancelling and removing it. Every handler checks its sender first, the download's included (a
 * frame that is not Flown's own page can start no network), then refuses any argument (these
 * channels take none). One state for the whole app (finding 29): it goes to every app window on
 * each change, at most every 250 ms while a download runs, so Find's dialog and Settings always
 * show the same one, a failure with its reason included (finding 26).
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { PRIVACY_CHANNELS, type ReaderState } from '../../shared/api/privacy'
import { isAppUrl } from '../security'
import { cancelReaderDownload, downloadReader, onReaderState, readerState, removeReader } from './readerModels'

/** State to every app window at most this often while it changes. */
export const READER_STATE_EVERY_MS = 250

const fromApp = (e: IpcMainInvokeEvent): void => {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

/** These channels take no argument. */
const noArgs = (args: unknown[]): void => {
  if (args.length) throw new Error('Not allowed')
}

/** Sends `state` to every window showing Flown's own page. */
export function sendReaderState(state: ReaderState, windows: () => BrowserWindow[] = () => BrowserWindow.getAllWindows()): void {
  for (const w of windows()) {
    if (w.isDestroyed() || !isAppUrl(w.webContents.getURL())) continue
    w.webContents.send(PRIVACY_CHANNELS.readerProgress, state)
  }
}

/** `send` at most every `everyMs` while a download's progress changes; any other change at once. */
export function throttled(send: (s: ReaderState) => void, everyMs = READER_STATE_EVERY_MS): (s: ReaderState) => void {
  let last = 0
  let timer: NodeJS.Timeout | null = null
  let latest: ReaderState | null = null
  return (s) => {
    latest = s
    const now = Date.now()
    if (s.status !== 'downloading' || now - last >= everyMs) {
      if (timer) clearTimeout(timer)
      timer = null
      last = now
      send(s)
      return
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        if (latest) send(latest)
      }, everyMs - (now - last))
    }
  }
}

export function registerReaderIpc(): void {
  onReaderState(throttled((s) => sendReaderState(s)))
  ipcMain.handle(PRIVACY_CHANNELS.readerState, (e, ...args: unknown[]) => {
    fromApp(e)
    noArgs(args)
    return readerState()
  })
  ipcMain.handle(PRIVACY_CHANNELS.downloadReader, (e, ...args: unknown[]) => {
    fromApp(e)
    noArgs(args)
    return downloadReader(() => undefined, new AbortController().signal)
  })
  ipcMain.handle(PRIVACY_CHANNELS.cancelReaderDownload, async (e, ...args: unknown[]) => {
    fromApp(e)
    noArgs(args)
    await cancelReaderDownload()
  })
  ipcMain.handle(PRIVACY_CHANNELS.removeReader, (e, ...args: unknown[]) => {
    fromApp(e)
    noArgs(args)
    return removeReader()
  })
}
