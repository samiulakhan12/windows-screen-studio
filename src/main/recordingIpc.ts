import { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RecorderCommand, SaveRecordingPayload } from '../shared/api/recording'
import { createProject } from '../shared/engine/project'
import { generateAutoZooms } from '../shared/engine/zoom'
import type { CaptureSource, RecordingStatus } from '../shared/types'
import { CursorTracker } from './cursorTracker'
import { runFfmpeg } from './ffmpeg'
import * as projects from './projects'
import { proxyArgs } from './proxyArgs'
import { getMainWindow, loadRoute, preloadPath, sendToMain } from './windows'

const STOP_SHORTCUT = 'CommandOrControl+Shift+2'

let toolbarWindow: BrowserWindow | null = null
const tracker = new CursorTracker()
let pendingSource: { id: string; systemAudio: boolean } | null = null
const sourceDisplays = new Map<string, string | undefined>()

function createToolbarWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 340
  const height = 64
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + workArea.height - height - 24,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    hasShadow: false,
    webPreferences: { preload: preloadPath, sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // Keep the control bar out of the recording (Windows 10 2004+ / macOS).
  win.setContentProtection(true)
  win.on('closed', () => {
    toolbarWindow = null
  })
  loadRoute(win, '/toolbar')
  return win
}

function setupDisplayMedia(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      const pending = pendingSource
      if (!pending) {
        callback({})
        return
      }
      desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources.find((s) => s.id === pending.id)
          if (!source) {
            callback({})
            return
          }
          callback(
            pending.systemAudio && process.platform === 'win32'
              ? { video: source, audio: 'loopback' }
              : { video: source }
          )
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture')
  })
}

async function finalizeRecording(payload: SaveRecordingPayload): Promise<string> {
  const { id, dir } = await projects.createProjectDir()
  const progress = (msg: string): void => sendToMain('processing', msg)

  progress('Saving recording…')
  await fs.writeFile(path.join(dir, 'screen.webm'), payload.screen)
  if (payload.webcam) await fs.writeFile(path.join(dir, 'webcam.webm'), payload.webcam)
  const cursor = tracker.finish(payload.startedAt, payload.duration)
  await projects.writeCursor(id, cursor)

  progress('Optimising video for editing…')
  await runFfmpeg(proxyArgs(path.join(dir, 'screen.webm'), path.join(dir, 'screen.mp4'), payload.hasAudio))
  if (payload.webcam) {
    progress('Optimising camera…')
    await runFfmpeg(proxyArgs(path.join(dir, 'webcam.webm'), path.join(dir, 'webcam.mp4'), false))
  }
  // The proxies are now the source of truth; drop the large intermediates.
  await fs.rm(path.join(dir, 'screen.webm'), { force: true })
  await fs.rm(path.join(dir, 'webcam.webm'), { force: true })

  const project = createProject({
    id,
    name: new Date().toLocaleString(),
    duration: payload.duration,
    width: payload.width,
    height: payload.height,
    hasWebcam: !!payload.webcam,
    hasAudio: payload.hasAudio,
    webcamOffset: payload.webcamStartedAt ? (payload.webcamStartedAt - payload.startedAt) / 1000 : 0,
    zooms: generateAutoZooms(cursor.clicks, payload.duration),
    cursorValid: cursor.valid,
    capture: { method: 'chromium', cursorInVideo: !payload.cursorHidden, region: null }
  })
  await projects.writeProject(project)
  return id
}

function endRecordingUi(): void {
  globalShortcut.unregister(STOP_SHORTCUT)
  toolbarWindow?.hide()
  const main = getMainWindow()
  if (main) {
    main.show()
    main.focus()
  }
}

export function registerRecordingIpc(): void {
  setupDisplayMedia()

  ipcMain.handle('sources:list', async (): Promise<CaptureSource[]> => {
    const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()))
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: false
    })
    sourceDisplays.clear()
    return sources
      .filter((s) => !own.has(s.id) && s.name !== 'Screen Studio for Windows')
      .map((s) => {
        const kind = s.id.startsWith('screen:') ? 'screen' : 'window'
        sourceDisplays.set(s.id, kind === 'screen' ? s.display_id || undefined : undefined)
        return { id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), kind, displayId: s.display_id || undefined }
      })
  })

  ipcMain.handle('recording:prepare', (_e, sourceId: string, systemAudio: boolean) => {
    pendingSource = { id: sourceId, systemAudio }
  })

  ipcMain.handle('recording:started', () => {
    const sourceId = pendingSource?.id
    let displayId = sourceId ? sourceDisplays.get(sourceId) : undefined
    // Single-display machines sometimes report an empty display_id.
    if (!displayId && sourceId?.startsWith('screen:') && screen.getAllDisplays().length === 1) {
      displayId = String(screen.getPrimaryDisplay().id)
    }
    tracker.start(displayId)
    globalShortcut.register(STOP_SHORTCUT, () => sendToMain('recorder:command', 'stop'))
  })

  ipcMain.handle('recording:status', (_e, status: RecordingStatus) => {
    if (status.state === 'countdown' || status.state === 'recording' || status.state === 'paused') {
      if (!toolbarWindow) toolbarWindow = createToolbarWindow()
      if (!toolbarWindow.isVisible()) toolbarWindow.showInactive()
      const main = getMainWindow()
      if (main?.isVisible()) main.hide()
    }
    if (status.state === 'paused') tracker.pause()
    if (status.state === 'recording') tracker.resume()
    if (status.state === 'processing' || status.state === 'idle') endRecordingUi()
    toolbarWindow?.webContents.send('recording:status', status)
  })

  ipcMain.handle('recording:command', (_e, command: RecorderCommand) => {
    sendToMain('recorder:command', command)
  })

  ipcMain.handle('recording:save', async (_e, payload: SaveRecordingPayload) => {
    try {
      return await finalizeRecording(payload)
    } finally {
      pendingSource = null
    }
  })

  ipcMain.handle('recording:cancel', () => {
    tracker.stop()
    pendingSource = null
    endRecordingUi()
  })
}

/** Called when the main window closes. */
export function closeRecordingWindows(): void {
  toolbarWindow?.close()
}

export function disposeRecording(): void {
  globalShortcut.unregisterAll()
  tracker.stop()
}
