/**
 * AI on this PC over IPC (docs/design/smart-tools.md §9.4): LOCAL_AI_CHANNELS, each handler taking
 * only the app's own page (fromApp) and only catalogue ids. The state goes to every app window
 * when it changes, at most every 250 ms. The processor comes only from the speech helpers' probe
 * (§9.5): ssw-llm is never started to find out. The helper exits when the app quits, after 120 s
 * without a request, and when the last window closes.
 */
import { app, BrowserWindow, ipcMain, powerMonitor, type IpcMainInvokeEvent } from 'electron'
import os from 'node:os'
import { LOCAL_AI_CHANNELS, type LocalAiState } from '../../shared/api/localAi'
import { isLocalModelId, isLocalModelUse } from '../../shared/localAi/catalog'
import { isAppUrl } from '../security'
import { probedProcessor, selectHelper } from '../speech/helper'
import { llmHelperPath } from './engine'
import { currentEngine } from './localTextClient'
import { configureLocalModels, localAiState, localModels } from './models'

/** Only the app's own page. */
function fromApp(e: IpcMainInvokeEvent): void {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

/** A catalogue id from the page, or an error. */
function modelId(raw: unknown): string {
  if (!isLocalModelId(raw)) throw new Error('Unknown model.')
  return raw
}

/** State to every app window at most this often. */
export const CHANGED_EVERY_MS = 250

/**
 * The processor as AI on this PC needs it (§9.5): AVX2, FMA and F16C, read only from the speech
 * helpers' probe (run once a session by selectHelper, with the compatible build when packaged);
 * null when the probe failed or this build has no speech helper.
 */
export async function processorOk(probe: () => Promise<unknown> = selectHelper, probed = probedProcessor): Promise<boolean | null> {
  if (!probed()) await probe().catch(() => null)
  const cpu = probed()
  if (!cpu) return null
  return cpu.avx2 && cpu.fma && cpu.f16c && cpu.avx && cpu.sse42
}

/** Calls `send` at most once per `everyMs`; the last change always arrives. */
function throttle(send: () => void, everyMs: number): () => void {
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

async function broadcast(): Promise<void> {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && isAppUrl(w.webContents.getURL()))
  if (!windows.length) return
  const state: LocalAiState | null = await localAiState().catch(() => null)
  if (!state) return
  for (const w of windows) if (!w.isDestroyed()) w.webContents.send(LOCAL_AI_CHANNELS.changed, state)
}

export function registerLocalAiIpc(): void {
  const changed = throttle(() => void broadcast(), CHANGED_EVERY_MS)
  configureLocalModels({
    pc: () => ({ totalMemBytes: os.totalmem(), freeMemBytes: os.freemem(), helper: llmHelperPath() !== null }),
    processor: () => processorOk(),
    unload: async (file) => {
      const eng = currentEngine()
      if (eng?.loadedModel === file) await eng.unload()
    },
    held: () => currentEngine()?.loadedModel ?? null,
    onChange: changed
  })
  const downloads = new Map<string, AbortController>()
  ipcMain.handle(LOCAL_AI_CHANNELS.state, (e) => {
    fromApp(e)
    return localAiState()
  })
  ipcMain.handle(LOCAL_AI_CHANNELS.download, async (e, raw: unknown) => {
    fromApp(e)
    const id = modelId(raw)
    const controller = new AbortController()
    downloads.set(id, controller)
    try {
      return await localModels().download(id, { signal: controller.signal, onProgress: () => changed() })
    } finally {
      if (downloads.get(id) === controller) downloads.delete(id)
    }
  })
  ipcMain.handle(LOCAL_AI_CHANNELS.cancel, (e, raw: unknown) => {
    fromApp(e)
    const id = modelId(raw)
    downloads.get(id)?.abort()
    return localModels().cancel(id)
  })
  ipcMain.handle(LOCAL_AI_CHANNELS.remove, (e, raw: unknown) => {
    fromApp(e)
    return localModels().remove(modelId(raw))
  })
  ipcMain.handle(LOCAL_AI_CHANNELS.setUse, (e, raw: unknown) => {
    fromApp(e)
    if (!isLocalModelUse(raw)) throw new Error('Unknown choice.')
    return localModels().setUse(raw)
  })
  // Sleep never looks like a frozen helper.
  try {
    powerMonitor.on('resume', () => currentEngine()?.resetWatchdogs())
  } catch {
    // powerMonitor is not available (tests).
  }
  void localModels()
    .sweepStaleParts()
    .catch(() => undefined)
  // The helper gives its memory back when the last window closes, and dies with the app.
  app.on('window-all-closed', () => void currentEngine()?.unload())
  app.on('will-quit', () => {
    localModels().stopDownloads()
    void currentEngine()?.dispose()
  })
}
