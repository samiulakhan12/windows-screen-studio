import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUSY_COPY } from '../src/shared/updates/updates'

/** What Restart now checks first (updatesIpc busyReason, docs/design/auto-update.md §1.5). */
const h = vi.hoisted(() => ({
  windows: [] as unknown[],
  barShown: false,
  exporting: false
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0.7.1', quit: () => undefined },
  BrowserWindow: { getAllWindows: () => h.windows },
  ipcMain: { handle: () => undefined }
}))
vi.mock('../src/main/recording/toolbarWindow', () => ({ isToolbarVisible: () => h.barShown }))
vi.mock('../src/main/exportIpc', () => ({ exportRunning: () => h.exporting }))
vi.mock('../src/main/importVideo', () => ({ importRunning: () => false }))
vi.mock('../src/main/longJobs', () => ({ jobsSnapshot: () => [] }))
vi.mock('../src/main/projectsIpc', () => ({ copyRunning: () => false }))
vi.mock('../src/main/voice/voiceIpc', () => ({ voiceCleaner: { busy: false } }))
vi.mock('../src/main/updates/electronUpdaterPort', () => ({ electronUpdaterPort: async () => null }))

/** The recording bar once a recording ended: hidden and kept for the next one, still on its route. */
const keptBar = {
  isDestroyed: () => false,
  isVisible: () => false,
  webContents: { getURL: () => 'file:///C:/Program%20Files/Flown/resources/app.asar/out/renderer/index.html#/toolbar' }
}

describe('Restart now while nothing runs', () => {
  beforeEach(() => {
    h.windows.length = 0
    h.barShown = false
    h.exporting = false
  })

  it('is allowed after a recording ended, although its bar is kept hidden', async () => {
    const { busyReason } = await import('../src/main/updates/updatesIpc')
    h.windows.push(keptBar)
    expect(busyReason()).toBeNull()
  })

  it('is refused while the recording bar shows (countdown, recording, paused)', async () => {
    const { busyReason } = await import('../src/main/updates/updatesIpc')
    h.windows.push(keptBar)
    h.barShown = true
    expect(busyReason()).toBe(BUSY_COPY.recording)
  })

  it('is still refused while an export runs', async () => {
    const { busyReason } = await import('../src/main/updates/updatesIpc')
    h.exporting = true
    expect(busyReason()).toBe(BUSY_COPY.export)
  })
})
