/**
 * The main window's page dying (src/main/recordingIpc.ts attachRecorderWindow): the editor goes
 * with it without closing, so the transcriptions it started are stopped as closing it would
 * (MAIN-5), whether the page crashed or exited cleanly.
 */
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  userData: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-recorder-gone-')) as string,
  stops: 0,
  routes: [] as string[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, isPackaged: false, on: () => undefined },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: {},
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  globalShortcut: { register: () => true, unregister: () => undefined, unregisterAll: () => undefined },
  screen: {},
  session: {},
  shell: {},
  net: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../src/main/ai/transcribe', () => ({
  stopEveryTranscription: async () => {
    h.stops++
  }
}))
vi.mock('../src/main/windows', () => ({
  getMainWindow: () => null,
  loadRoute: (_win: unknown, route: string) => void h.routes.push(route),
  allowPopup: () => undefined
}))
vi.mock('../src/main/cursorTracker', () => ({ CursorTracker: class {} }))
vi.mock('../src/main/nativeCapture', () => ({ desktopIcons: async () => ({ ok: true }), desktopIconsSync: () => ({ ok: true }), holdDesktopIcons: async () => null }))

import { attachRecorderWindow } from '../src/main/recordingIpc'

/** A main window whose page can go away. */
function mainWindow() {
  const webContents = new EventEmitter()
  const win = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false })
  attachRecorderWindow(win as never)
  return webContents
}

beforeEach(() => {
  h.stops = 0
  h.routes.length = 0
})
afterAll(() => rmSync(h.userData, { recursive: true, force: true }))

describe('the main window page gone', () => {
  it('stops every transcription, then reloads Home', async () => {
    for (const reason of ['crashed', 'killed', 'clean-exit']) {
      const page = mainWindow()
      page.emit('render-process-gone', {}, { reason, exitCode: 1 })
      await vi.waitFor(() => expect(h.routes).toHaveLength(1))
      expect(h.stops).toBe(1)
      h.stops = 0
      h.routes.length = 0
    }
  })
})
