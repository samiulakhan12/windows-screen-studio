/**
 * Flown's own updates over IPC (NW-15, docs/design/auto-update.md §2): only the app page may ask,
 * and every window hears the state change. The real updater runs only in a packaged Windows build;
 * an unpackaged app may use the scripted fake (SSW_UPDATES_FAKE), and is otherwise "turned off".
 */
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import type { UpdateInstallResult } from '../../shared/api/updates'
import { BUSY_COPY, type UpdateState } from '../../shared/updates/updates'
import { exportRunning } from '../exportIpc'
import { importRunning } from '../importVideo'
import { jobsSnapshot } from '../longJobs'
import { copyRunning } from '../projectsIpc'
import { isToolbarVisible } from '../recording/toolbarWindow'
import { isAppUrl } from '../security'
import { voiceCleaner } from '../voice/voiceIpc'
import { electronUpdaterPort } from './electronUpdaterPort'
import { fakeUpdaterPort, isFakeScenario } from './fakeUpdaterPort'
import { UPDATES_FILE, UpdatePrefsStore } from './updatePrefs'
import { UpdateService } from './updateService'
import type { UpdaterPort } from './updaterPort'

let service: UpdateService | null = null
const afterCheck = new Set<() => void>()

const fromApp = (e: IpcMainInvokeEvent): boolean => isAppUrl(e.senderFrame?.url ?? '')

/** Why Restart now cannot run now, or null (main checks again when it is pressed). */
export function busyReason(): string | null {
  // The recording bar shows from the countdown until the recording ends; it is only hidden (kept
  // for the next recording) afterwards, so an open but hidden bar is no recording.
  if (isToolbarVisible()) return BUSY_COPY.recording
  const jobs = jobsSnapshot()
  for (const kind of ['export', 'captions', 'analysis'] as const) if (jobs.some((j) => j.kind === kind)) return BUSY_COPY[kind]
  if (exportRunning()) return BUSY_COPY.export
  if (importRunning()) return BUSY_COPY.import
  if (voiceCleaner.busy) return BUSY_COPY.voice
  if (copyRunning()) return BUSY_COPY.copy
  return null
}

function broadcast(state: UpdateState): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !isAppUrl(w.webContents.getURL())) continue
    w.webContents.send('updates:changed', state)
  }
}

async function makePort(): Promise<UpdaterPort | null> {
  if (app.isPackaged) {
    if (process.platform !== 'win32') return null
    try {
      return await electronUpdaterPort(app)
    } catch (err) {
      console.warn('Updates are off: the updater could not start:', err)
      return null
    }
  }
  const scenario = process.env.SSW_UPDATES_FAKE
  if (!isFakeScenario(scenario)) return null
  return fakeUpdaterPort(scenario, { log: process.env.SSW_UPDATES_FAKE_LOG || undefined, quit: () => app.quit() })
}

/** Runs `fn` after every update check that ended (the model list refreshes then). */
export function onUpdateCheckEnded(fn: () => void): () => void {
  afterCheck.add(fn)
  return () => afterCheck.delete(fn)
}

/** Whether automatic updates (and the model list refresh) are on. */
export const updatesAuto = (): boolean => service?.get().auto === true

export function registerUpdatesIpc(): void {
  const prefs = new UpdatePrefsStore(path.join(app.getPath('userData'), UPDATES_FILE))
  const first = !app.isPackaged ? Number(process.env.SSW_UPDATES_FIRST_CHECK_MS) : NaN
  const ready = makePort().then((port) => {
    service = new UpdateService({
      port,
      current: app.getVersion(),
      prefs,
      busy: busyReason,
      onChange: broadcast,
      afterCheck: () => {
        for (const fn of afterCheck) fn()
      },
      firstCheckMs: Number.isFinite(first) && first >= 0 ? first : undefined
    })
    service.start()
    return service
  })

  const handle = <T>(channel: string, fn: (s: UpdateService, arg: unknown) => T | Promise<T>): void => {
    ipcMain.handle(channel, async (e, arg: unknown) => {
      if (!fromApp(e)) throw new Error('Not allowed')
      return fn(await ready, arg)
    })
  }
  handle('updates:get', (s) => s.get())
  handle('updates:check', (s) => s.check())
  handle('updates:download', (s) => s.download())
  handle('updates:install', (s): UpdateInstallResult => s.install())
  handle('updates:setAuto', (s, on) => {
    if (typeof on !== 'boolean') throw new Error('Invalid request.')
    return s.setAuto(on)
  })
}

export function disposeUpdates(): void {
  service?.dispose()
}
