import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  session,
  shell,
  type Display,
  type Point,
  type Streams
} from 'electron'
import path from 'node:path'
import type {
  CapturePlan,
  NativeStartResult,
  ProcessingProgress,
  RecorderCommand,
  RecordingRequest,
  RecordingStartInfo,
  RegionSelection,
  SaveRecordingPayload,
  ToolbarStatus,
  TrackKind
} from '../shared/api/recording'
import type { CaptureSource, NormRect, RecordingStatus } from '../shared/types'
import { CursorTracker } from './cursorTracker'
import { detectH264Encoders } from './hwEncoders'
import * as nativeModule from './nativeCapture'
import * as projects from './projects'
import { EmptyRecordingError, processRecording, RecordingError } from './recording/finalize'
import { nativeAvailable, startNativeVideo, type NativeCaptureApi } from './recording/nativeVideo'
import { pointInRect, regionToRect, sanitizeRegion } from './recording/placement'
import { killAllFfmpeg } from './recording/proxyRunner'
import { pickRegionOnDisplay } from './recording/regionWindow'
import { ActiveRecording } from './recording/session'
import {
  closeToolbar,
  hideToolbar,
  isToolbarVisible,
  prepareToolbar,
  sendToolbarStatus,
  showToolbar,
  toolbarAreas
} from './recording/toolbarWindow'
import { buildCursorTrack } from './recording/trackMath'
import { getMainWindow, loadRoute } from './windows'

const STOP_SHORTCUT = 'CommandOrControl+Shift+2'
/** How the stop shortcut appears as a keystroke label (never recorded). */
const STOP_SHORTCUT_LABEL = 'Ctrl + Shift + 2'
const TRACK_KINDS: readonly TrackKind[] = ['screen', 'webcam', 'audio']

const tracker = new CursorTracker()
let active: ActiveRecording | null = null
let activeDisplay: Display | null = null
let captureKeys = true
/** The source the next getDisplayMedia() call is granted. */
let grant: { id: string; name: string; systemAudio: boolean } | null = null
let stopShortcut = false
let lastStatus: ToolbarStatus = { state: 'idle', elapsed: 0 }
/** Recordings whose proxies are being built (they have no project.json yet). */
const processing = new Set<string>()
const sourceInfo = new Map<string, { name: string; displayId?: string }>()
let allowClose = false

/** The native capture helper; unpackaged builds let e2e tests substitute a fake one. */
function nativeCapture(): NativeCaptureApi {
  const fake = app.isPackaged ? undefined : (globalThis as { __SSW_NATIVE_CAPTURE__?: NativeCaptureApi }).__SSW_NATIVE_CAPTURE__
  return fake ?? nativeModule
}

function mainContents(): Electron.WebContents | null {
  const wc = getMainWindow()?.webContents
  return wc && !wc.isDestroyed() && !wc.isCrashed() ? wc : null
}

function sendProgress(p: ProcessingProgress): void {
  mainContents()?.send('processing', p)
}

function requireSession(token: unknown): ActiveRecording {
  if (!active || active.token !== token) throw new Error('This recording is no longer active.')
  return active
}

function displayById(id: string | undefined): Display | null {
  const all = screen.getAllDisplays()
  const found = id ? all.find((d) => String(d.id) === id) : undefined
  // Single-display machines (and Xvfb) sometimes report an empty display_id.
  return found ?? (all.length === 1 ? all[0] : null)
}

/** Checks the source still exists right before capturing (a window may have closed). */
async function resolveSource(sourceId: string): Promise<{ name: string; display: Display | null; kind: 'screen' | 'window' }> {
  const kind = sourceId.startsWith('screen:') ? 'screen' : 'window'
  const find = async (): Promise<Electron.DesktopCapturerSource | undefined> =>
    (await desktopCapturer.getSources({ types: [kind], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })).find(
      (s) => s.id === sourceId
    )
  let source = await find()
  // Some capturers (Xvfb) intermittently list nothing on the first call.
  if (!source) source = await new Promise<Electron.DesktopCapturerSource | undefined>((r) => setTimeout(() => void find().then(r), 400))
  if (!source) {
    throw new RecordingError(
      kind === 'screen'
        ? 'The selected screen is no longer available. Pick another one.'
        : 'The window you picked is no longer available (it may have been closed). Pick another one.'
    )
  }
  return { name: source.name, kind, display: kind === 'screen' ? displayById(source.display_id || sourceInfo.get(sourceId)?.displayId) : null }
}

/** Windows that are not being torn down (a closing window's webContents may already be gone). */
const liveWindows = (): BrowserWindow[] => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed())

function isOwnPoint(p: Point): boolean {
  if (toolbarAreas().some((r) => pointInRect(p, r))) return true
  return liveWindows().some((w) => w.isVisible() && !w.isMinimized() && pointInRect(p, w.getBounds()))
}

function startTracker(): void {
  tracker.start({
    display: activeDisplay ? { bounds: activeDisplay.bounds, scaleFactor: activeDisplay.scaleFactor } : null,
    captureKeys,
    isOwnPoint,
    ignoreKeys: [STOP_SHORTCUT_LABEL]
  })
}

function registerStopShortcut(): boolean {
  globalShortcut.unregister(STOP_SHORTCUT)
  try {
    const ok = globalShortcut.register(STOP_SHORTCUT, () => forwardCommand('stop'))
    if (!ok) console.warn(`${STOP_SHORTCUT} is in use by another application`)
    return ok
  } catch (err) {
    console.warn('Could not register the stop shortcut:', err)
    return false
  }
}

function endRecordingUi(): void {
  globalShortcut.unregister(STOP_SHORTCUT)
  lastStatus = { state: 'idle', elapsed: 0 }
  // Rendered empty while hidden, so the next countdown never flashes stale controls.
  sendToolbarStatus(lastStatus)
  hideToolbar()
  const main = getMainWindow()
  if (main && !main.isDestroyed()) {
    main.show()
    main.focus()
  }
}

/** Freezes the recording at the moment stop was requested. */
function beginStop(s: ActiveRecording): void {
  if (s.phase === 'stopping' || s.phase === 'processing') return
  s.stop()
  s.phase = 'stopping'
}

async function writeTrack(s: ActiveRecording, duration: number): Promise<void> {
  const shapes = await s.finishNative()
  // Collected only now: hook events can reach JavaScript a little late, and anything
  // after the stop is cut by the duration anyway.
  const raw = tracker.active ? tracker.collect() : { samples: [], clicks: [], keys: [], bounds: null, scale: 1 }
  const m = s.manifest
  if (m.startedAt === null) return
  // Slack: the final duration comes from the proxy and is applied by processRecording.
  const track = buildCursorTrack(raw, { startedAt: m.startedAt, pauses: s.pauses, duration, region: m.region, shapes, slack: 1 })
  await projects.writeCursor(m.id, track)
}

async function discard(s: ActiveRecording): Promise<void> {
  if (active === s) active = null
  grant = null
  tracker.stop()
  s.killNative()
  await s.closeWriters().catch(() => undefined)
  await projects.deleteProject(s.id).catch((err) => console.warn('Could not remove the discarded recording:', err))
}

/** Keeps what reached disk as an unfinished recording the user can recover from Home. */
async function interrupt(s: ActiveRecording): Promise<void> {
  beginStop(s)
  if (active === s) active = null
  grant = null
  await s.closeWriters().catch(() => undefined)
  const duration = s.activeSeconds()
  try {
    await writeTrack(s, duration)
  } catch (err) {
    console.error('Could not save the cursor track:', err)
  } finally {
    tracker.stop()
  }
  s.manifest.duration = duration
  s.manifest.status = 'interrupted'
  await projects.writeManifest(s.manifest).catch((err) => console.error('Could not save the recording state:', err))
}

/** Sends a toolbar/shortcut command to the recorder, or recovers if the recorder is gone. */
function forwardCommand(command: RecorderCommand): void {
  const wc = mainContents()
  if (wc) {
    wc.send('recorder:command', command)
    return
  }
  const s = active
  if (s && s.phase !== 'processing') void interrupt(s).finally(endRecordingUi)
}

function friendlyMessage(err: unknown): string {
  if (err instanceof RecordingError) return err.message
  const e = err as NodeJS.ErrnoException
  if (e?.code === 'ENOSPC') return 'Your disk is full.'
  return e?.message || String(err)
}

function setupDisplayMedia(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const g = grant
      try {
        if (!g || !request.videoRequested) {
          callback(null)
          return
        }
        // The source was validated moments ago in recording:prepare; no re-enumeration needed.
        const streams: Streams = { video: { id: g.id, name: g.name } }
        if (g.systemAudio && request.audioRequested && process.platform === 'win32') streams.audio = 'loopback'
        callback(streams)
      } catch (err) {
        // The callback is one-shot: never call it a second time.
        console.error('Display media request failed:', err)
      }
    },
    { useSystemPicker: false }
  )

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture')
  })
}

async function prepare(request: RecordingRequest): Promise<CapturePlan> {
  if (active) throw new RecordingError('A recording is already in progress.')
  if (processing.size > 0) throw new RecordingError('Please wait until the previous recording has finished processing.')
  const source = await resolveSource(request.sourceId)
  const region = source.kind === 'screen' ? sanitizeRegion(request.region) : null
  if (request.region && !region) throw new RecordingError('The selected area is too small. Select a larger area.')
  if (region && !source.display) throw new RecordingError('Could not find the display for the selected area.')
  const native = source.kind === 'screen' && !!source.display && (await nativeAvailable(nativeCapture()))
  // Warm the encoder probe while recording so processing can start at once.
  void detectH264Encoders()

  const { id, dir } = await projects.createProjectDir()
  const manifest: projects.RecordingManifest = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    status: 'recording',
    error: null,
    method: native ? 'native' : 'chromium',
    sourceKind: source.kind,
    region,
    startedAt: null,
    width: 0,
    height: 0,
    hasAudio: false,
    hasWebcam: false,
    webcamFps: 30,
    webcamOffset: 0,
    audioOffset: 0,
    duration: null
  }
  try {
    await projects.writeManifest(manifest)
  } catch (err) {
    await projects.deleteProject(id).catch(() => undefined)
    throw err
  }
  const s = new ActiveRecording(manifest, dir)
  active = s
  activeDisplay = source.display
  captureKeys = request.captureKeys
  grant = { id: request.sourceId, name: source.name, systemAudio: request.systemAudio }
  prepareToolbar(source.display, region && source.display ? regionToRect(region, source.display.bounds) : null)
  stopShortcut = registerStopShortcut()
  lastStatus = { state: 'idle', elapsed: 0, stopShortcut }
  return { token: s.token, method: manifest.method, stopShortcut }
}

async function startNative(token: string): Promise<NativeStartResult> {
  const s = requireSession(token)
  if (s.manifest.method !== 'native' || !activeDisplay) return { ok: false, message: 'Native capture is not used for this recording.' }
  startTracker()
  const result = await startNativeVideo(nativeCapture(), {
    displayId: String(activeDisplay.id),
    output: path.join(s.dir, projects.RAW.native),
    fps: 60
  })
  if (active !== s) {
    // Cancelled while the helper was starting.
    if (result.ok) result.session.kill()
    return { ok: false, message: 'The recording was cancelled.' }
  }
  if (!result.ok) {
    console.warn('Native capture failed, falling back to Chromium capture:', result.message)
    tracker.stop()
    s.manifest.method = 'chromium'
    await projects.writeManifest(s.manifest)
    return { ok: false, message: result.message }
  }
  s.attachNative(result.session, result.info)
  return { ok: true, startedAt: result.info.startedAt, width: result.info.width, height: result.info.height }
}

async function started(token: string, info: RecordingStartInfo): Promise<void> {
  const s = requireSession(token)
  const m = s.manifest
  if (info.method === 'native' && s.usesNative) {
    // Size and start time come from the helper (attachNative).
  } else {
    m.method = 'chromium'
    m.startedAt = info.startedAt
    m.width = info.width
    m.height = info.height
  }
  m.hasAudio = info.hasAudio
  m.hasWebcam = info.hasWebcam
  m.webcamFps = info.webcamFps
  s.phase = 'recording'
  // Native capture started tracking with the helper; Chromium capture starts now.
  if (!s.usesNative) startTracker()
  await projects.writeManifest(m)
}

function setStatus(token: string, status: RecordingStatus): void {
  const s = active
  if (!s || s.token !== token) return
  lastStatus = { state: status.state, elapsed: status.elapsed, stopShortcut }
  switch (status.state) {
    case 'countdown':
    case 'recording': {
      if (status.state === 'recording' && s.phase === 'paused') {
        s.resume()
        tracker.setPaused(false)
        s.phase = 'recording'
      }
      sendToolbarStatus(lastStatus)
      showToolbar()
      const main = getMainWindow()
      if (main?.isVisible()) main.hide()
      return
    }
    case 'paused':
      if (s.phase === 'recording') {
        s.pause()
        tracker.setPaused(true)
        s.phase = 'paused'
      }
      break
    case 'processing':
    case 'idle':
      if (status.state === 'processing') beginStop(s)
      endRecordingUi()
      return
  }
  sendToolbarStatus(lastStatus)
}

async function save(token: string, payload: SaveRecordingPayload): Promise<string> {
  const s = requireSession(token)
  beginStop(s)
  s.phase = 'processing'
  processing.add(s.id)
  grant = null
  const m = s.manifest
  try {
    await s.closeWriters()
    if (m.method === 'chromium' && Number.isFinite(payload.startedAt) && payload.startedAt > 0) m.startedAt = payload.startedAt
    const measured = m.method === 'native' ? s.activeSeconds() : payload.duration
    m.duration = measured > 0 ? measured : s.activeSeconds()
    m.webcamOffset = Number.isFinite(payload.webcamOffset) ? payload.webcamOffset : 0
    m.audioOffset = Number.isFinite(payload.audioOffset) ? payload.audioOffset : 0
    m.status = 'processing'
    await writeTrack(s, m.duration)
    await projects.writeManifest(m)
    const project = await processRecording(m, sendProgress)
    return project.id
  } catch (err) {
    const message = friendlyMessage(err)
    console.error('Saving the recording failed:', err)
    if (err instanceof EmptyRecordingError) {
      // Nothing to keep: do not leave an empty folder behind.
      await projects.deleteProject(s.id).catch(() => undefined)
      throw new Error(message)
    }
    m.status = 'failed'
    m.error = message
    await projects.writeManifest(m).catch(() => undefined)
    throw new Error(`${message} Your recording was kept in “${s.dir}”; you can retry it from Unfinished recordings.`)
  } finally {
    // The input hook only ever runs while recording.
    tracker.stop()
    processing.delete(s.id)
    if (active === s) active = null
  }
}

async function cancel(token: string): Promise<void> {
  const s = active
  if (!s || s.token !== token || s.phase === 'processing') return
  await discard(s)
  endRecordingUi()
}

async function recover(id: string): Promise<string> {
  if (active) throw new Error('Finish the current recording first.')
  if (processing.has(id)) throw new Error('This recording is already being processed.')
  const m = (await projects.readManifest(id)) ?? (await projects.legacyManifest(id))
  processing.add(id)
  try {
    m.status = 'processing'
    m.error = null
    await projects.writeManifest(m)
    const project = await processRecording(m, sendProgress)
    return project.id
  } catch (err) {
    const message = friendlyMessage(err)
    console.error('Recovering the recording failed:', err)
    if (err instanceof EmptyRecordingError) {
      await projects.deleteProject(id).catch(() => undefined)
      throw new Error(`${message} The empty recording was removed.`)
    }
    m.status = 'failed'
    m.error = message
    await projects.writeManifest(m).catch(() => undefined)
    throw new Error(message)
  } finally {
    processing.delete(id)
  }
}

async function pickRegion(sourceId: string): Promise<RegionSelection | null> {
  const source = await resolveSource(sourceId)
  if (source.kind !== 'screen' || !source.display) throw new RecordingError('Areas can only be selected on a screen.')
  const display = source.display
  const region: NormRect | null = await pickRegionOnDisplay(display)
  if (!region) return null
  const { width, height } = display.bounds
  return {
    region,
    width: Math.round(region.w * width * display.scaleFactor),
    height: Math.round(region.h * height * display.scaleFactor)
  }
}

export function registerRecordingIpc(): void {
  setupDisplayMedia()

  ipcMain.handle('sources:list', async (): Promise<CaptureSource[]> => {
    const own = new Set(liveWindows().map((w) => w.getMediaSourceId()))
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: false
    })
    sourceInfo.clear()
    return sources
      .filter((s) => !own.has(s.id) && s.name !== 'Screen Studio for Windows')
      .map((s) => {
        const kind = s.id.startsWith('screen:') ? 'screen' : 'window'
        const displayId = kind === 'screen' ? s.display_id || undefined : undefined
        sourceInfo.set(s.id, { name: s.name, displayId })
        return { id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), kind, displayId }
      })
  })

  ipcMain.handle('recording:prepare', (_e, request: RecordingRequest) => prepare(request))
  ipcMain.handle('recording:chunk', async (_e, token: string, kind: TrackKind, data: Uint8Array) => {
    const s = requireSession(token)
    if (!TRACK_KINDS.includes(kind)) throw new Error(`Unknown track ${kind}`)
    try {
      await s.write(kind, data)
    } catch (err) {
      throw new Error(friendlyMessage(err))
    }
  })
  ipcMain.handle('recording:startNative', (_e, token: string) => startNative(token))
  ipcMain.handle('recording:started', (_e, token: string, info: RecordingStartInfo) => started(token, info))
  ipcMain.handle('recording:status', (_e, token: string, status: RecordingStatus) => setStatus(token, status))
  ipcMain.handle('recording:command', (_e, command: RecorderCommand) => forwardCommand(command))
  ipcMain.handle('recording:getStatus', (): ToolbarStatus => lastStatus)
  ipcMain.handle('recording:save', (_e, token: string, payload: SaveRecordingPayload) => save(token, payload))
  ipcMain.handle('recording:cancel', (_e, token: string) => cancel(token))
  ipcMain.handle('recording:pickRegion', (_e, sourceId: string) => pickRegion(sourceId))
  ipcMain.handle('recordings:unfinished', () => projects.listUnfinished(new Set([...processing, ...(active ? [active.id] : [])])))
  ipcMain.handle('recordings:recover', (_e, id: string) => recover(id))
  ipcMain.handle('recording:privacySettings', async (_e, kind: 'microphone' | 'camera') => {
    if (process.platform === 'win32') await shell.openExternal(`ms-settings:privacy-${kind === 'camera' ? 'webcam' : 'microphone'}`)
  })
}

/** Recovery and quit protection for the window that runs the recorder. */
export function attachRecorderWindow(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_e, details) => {
    void (async () => {
      const s = active
      if (s && s.phase !== 'processing') {
        if (s.manifest.startedAt === null) await discard(s)
        else await interrupt(s)
      }
      grant = null
      endRecordingUi()
      if (win.isDestroyed()) return
      loadRoute(win, '/')
      if (details.reason === 'clean-exit') return
      await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Screen Studio for Windows',
        message: 'The recorder stopped unexpectedly.',
        detail: s
          ? 'What was recorded until then has been kept. Recover it from “Unfinished recordings” on the home screen.'
          : 'Please try again.'
      })
    })()
  })

  win.on('close', (e) => {
    if (allowClose || (!active && processing.size === 0)) return
    e.preventDefault()
    const recording = !!active && active.phase !== 'processing'
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: 'Screen Studio for Windows',
        buttons: ['Keep working', 'Quit anyway'],
        defaultId: 0,
        cancelId: 0,
        message: recording ? 'A recording is in progress.' : 'A recording is still being processed.',
        detail: 'If you quit now it is kept as an unfinished recording, which you can finish from the home screen next time.'
      })
      .then(({ response }) => {
        if (response !== 1 || win.isDestroyed()) return
        allowClose = true
        win.close()
      })
  })
}

/** Brings the app forward when a second instance is launched. */
export function focusApp(): void {
  if (active && active.phase !== 'processing' && isToolbarVisible()) {
    showToolbar()
    return
  }
  const main = getMainWindow()
  if (!main || main.isDestroyed()) return
  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
}

/** Called when the main window closes. */
export function closeRecordingWindows(): void {
  closeToolbar()
}

export function disposeRecording(): void {
  globalShortcut.unregisterAll()
  tracker.stop()
  active?.killNative()
  killAllFfmpeg()
}
