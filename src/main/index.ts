import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  session,
  shell
} from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LoadedProject, RecorderCommand, SaveRecordingPayload } from '../shared/api'
import { createProject } from '../shared/engine/project'
import { generateAutoZooms } from '../shared/engine/zoom'
import type { CaptureSource, ExportJob, Project, RecordingStatus } from '../shared/types'
import { CursorTracker } from './cursorTracker'
import { FrameEncoder, runFfmpeg } from './ffmpeg'
import { exportArgs, proxyArgs } from './ffmpegArgs'
import { handleMediaProtocol, mediaUrl, registerMediaScheme } from './mediaProtocol'
import * as projects from './projects'

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']
const STOP_SHORTCUT = 'CommandOrControl+Shift+2'

let mainWindow: BrowserWindow | null = null
let toolbarWindow: BrowserWindow | null = null
const tracker = new CursorTracker()
let pendingSource: { id: string; systemAudio: boolean } | null = null
const sourceDisplays = new Map<string, string | undefined>()
let encoder: FrameEncoder | null = null
let approvedExportPath: string | null = null

registerMediaScheme()

function loadRoute(win: BrowserWindow, route: string): void {
  if (isDev) void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${route}`)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: route })
}

const preload = path.join(__dirname, '../preload/index.js')

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0b10',
    title: 'Screen Studio for Windows',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0b10', symbolColor: '#e5e7eb', height: 40 },
    webPreferences: {
      preload,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Recording keeps running while this window is hidden.
      backgroundThrottling: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    toolbarWindow?.close()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRoute(mainWindow, '/')
}

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
    webPreferences: { preload, sandbox: false, contextIsolation: true, nodeIntegration: false }
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

function sendToMain(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args)
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
    cursorHidden: payload.cursorHidden
  })
  await projects.writeProject(project)
  return id
}

function endRecordingUi(): void {
  globalShortcut.unregister(STOP_SHORTCUT)
  toolbarWindow?.hide()
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
}

function registerIpc(): void {
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
      if (mainWindow?.isVisible()) mainWindow.hide()
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

  ipcMain.handle('projects:list', () => projects.listProjects())

  ipcMain.handle('projects:load', async (_e, id: string): Promise<LoadedProject> => {
    const project = await projects.readProject(id)
    const dir = projects.projectDir(id)
    const cursor = await projects.readCursor(id)
    const hasWebcam = project.hasWebcam && (await projects.exists(path.join(dir, 'webcam.mp4')))
    const bg = project.style.background
    return {
      project,
      cursor,
      dir,
      screenUrl: mediaUrl(id, 'screen.mp4'),
      webcamUrl: hasWebcam ? mediaUrl(id, 'webcam.mp4') : null,
      backgroundUrl: bg.type === 'image' ? mediaUrl(id, bg.path) : null
    }
  })

  ipcMain.handle('projects:save', (_e, project: Project) => projects.writeProject(project))
  ipcMain.handle('projects:delete', (_e, id: string) => projects.deleteProject(id))
  ipcMain.handle('projects:reveal', (_e, id: string) => shell.openPath(projects.projectDir(id)))

  ipcMain.handle('projects:pickBackground', async (_e, id: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const src = result.filePaths[0]
    const ext = path.extname(src).toLowerCase().replace('.jpeg', '.jpg')
    const name = `background${ext}`
    const dir = projects.projectDir(id)
    for (const old of ['background.png', 'background.jpg', 'background.webp']) {
      await fs.rm(path.join(dir, old), { force: true })
    }
    await fs.copyFile(src, path.join(dir, name))
    return { url: mediaUrl(id, name), path: name }
  })

  ipcMain.handle('export:choosePath', async (_e, defaultName: string, format: 'mp4' | 'gif') => {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export recording',
      defaultPath: path.join(app.getPath('videos'), `${defaultName}.${format}`),
      filters: format === 'gif' ? [{ name: 'GIF', extensions: ['gif'] }] : [{ name: 'MP4 video', extensions: ['mp4'] }]
    })
    approvedExportPath = result.canceled || !result.filePath ? null : result.filePath
    return approvedExportPath
  })

  ipcMain.handle('export:start', (_e, projectId: string, job: ExportJob) => {
    if (!approvedExportPath || job.outputPath !== approvedExportPath) {
      throw new Error('Export path was not chosen through the save dialog')
    }
    encoder?.kill()
    const audioInput = job.audio ? path.join(projects.projectDir(projectId), 'screen.mp4') : null
    encoder = new FrameEncoder(exportArgs(job, audioInput))
  })

  ipcMain.handle('export:frame', (_e, frame: Uint8Array) => {
    if (!encoder) throw new Error('No export in progress')
    return encoder.write(frame)
  })

  ipcMain.handle('export:finish', async () => {
    const current = encoder
    encoder = null
    approvedExportPath = null
    if (current) await current.finish()
  })

  ipcMain.handle('export:cancel', () => {
    encoder?.kill()
    encoder = null
  })

  ipcMain.handle('shell:showItem', (_e, file: string) => shell.showItemInFolder(file))
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.samiulakhan12.screenstudio')
  handleMediaProtocol()
  setupDisplayMedia()
  registerIpc()
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tracker.stop()
  encoder?.kill()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
