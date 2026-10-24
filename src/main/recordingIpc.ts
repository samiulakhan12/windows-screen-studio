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
  type NativeImage,
  type Point,
  type Streams
} from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  CapturePlan,
  NativeStartResult,
  ProcessingProgress,
  RecorderCommand,
  RecorderStatusUpdate,
  RecordingRequest,
  RecordingStartInfo,
  RegionSelection,
  SaveRecordingPayload,
  ToolbarStatus,
  TrackKind,
  WindowCaptureSupport
} from '../shared/api/recording'
import { MIN_SIZE } from '../shared/recording/regionGeometry'
import { PROCESSING_DEFERRED } from '../shared/recording/errors'
import {
  HOTKEY_ACTIONS,
  HOTKEY_NAMES,
  hotkeyLabel,
  normalizeHotkey,
  validateHotkey,
  type HotkeyAction,
  type HotkeyCheck,
  type Hotkeys
} from '../shared/recording/hotkeys'
import { DEFAULT_RECORDING_SETTINGS, type AppSettings, type RecordingSettings, type RecordingSettingsPatch } from '../shared/recording/settings'
import type { CaptureSource, NormRect } from '../shared/types'
import { appSettings } from './appSettings'
import { CursorTracker } from './cursorTracker'
import { detectH264Encoders } from './hwEncoders'
import * as nativeModule from './nativeCapture'
import type { NativeEndedInfo } from './nativeCapture'
import * as projects from './projects'
import { DesktopIcons } from './recording/desktopIcons'
import { EmptyRecordingError, processRecording, RecordingError } from './recording/finalize'
import { IdleDetector } from './recording/idleDetector'
import { defaultStartTimeoutMs, nativeAvailable, startNativeVideo, type NativeCaptureApi } from './recording/nativeVideo'
import { pointInRect, regionToRect, sanitizeRegion } from './recording/placement'
import { isCancelled, killAllFfmpeg } from './recording/proxyRunner'
import { pickRegionOnDisplay } from './recording/regionWindow'
import { ActiveRecording } from './recording/session'
import { expectedStems, setExpectedStems, settleStems, STEMS_DROPPED } from './recording/stems'
import {
  closeToolbar,
  hideToolbar,
  isToolbarVisible,
  prepareToolbar,
  sendToolbarStatus,
  showToolbar,
  toolbarAreas
} from './recording/toolbarWindow'
import { buildCursorTrack, type RawTrack, type WindowMapping } from './recording/trackMath'
import { friendlyMessage, nativeEndedMessage, rendererGoneDialog } from './recording/userMessages'
import { planWindowCapture, watchForChromium, WINDOW_NO_EFFECTS, windowCaptureSupport, windowCursorMapping, type WindowRoute } from './recording/windowCapture'
import { getMainWindow, loadRoute } from './windows'

const TRACK_KINDS: readonly TrackKind[] = ['screen', 'webcam', 'audio', 'mic', 'system']
/** Source thumbnails on Home: small JPEGs (cheap to encode and to send over IPC). */
const THUMBNAIL = { width: 384, height: 216, quality: 75 }

const tracker = new CursorTracker()
let active: ActiveRecording | null = null
let activeDisplay: Display | null = null
let captureKeys = true
/** Recording options (app settings) of the recording in progress, read when it was prepared. */
let options: RecordingSettings = DEFAULT_RECORDING_SETTINGS
/** The source the next getDisplayMedia() call is granted. */
let grant: { id: string; name: string; systemAudio: boolean } | null = null
let stopShortcut = false
/** Accelerators registered for the recording in progress, by action. */
let registered: Partial<Hotkeys> = {}
/** Messages about hotkeys that could not be registered. */
let hotkeyProblems: string[] = []
/** Auto-pause: watches for input while recording; null when off. */
let idle: IdleDetector | null = null
/** The recorder was told to pause because of inactivity (cleared when it records again). */
let autoPaused = false
let marks = 0
let lastStatus: ToolbarStatus = { state: 'idle', elapsed: 0 }
const icons = new DesktopIcons({
  platform: process.platform,
  run: (action) => nativeModule.desktopIcons(action),
  runSync: (action) => nativeModule.desktopIconsSync(action),
  state: {
    get desktopIconsHidden() {
      return appSettings().desktopIconsHidden
    },
    setDesktopIconsHidden: (hidden) => appSettings().setDesktopIconsHidden(hidden)
  }
})
/** Recordings whose proxies are being built (they have no project.json yet). */
const processing = new Set<string>()
/** Recordings whose processing the user postponed ("Finish later"). */
const deferred = new Set<string>()
/** Stops the processing of each recording in `processing`. */
const processingAborts = new Map<string, AbortController>()
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

const kindOf = (sourceId: string): CaptureSource['kind'] => (sourceId.startsWith('screen:') ? 'screen' : 'window')

/** Checks the source still exists right before capturing (a window may have closed). */
async function resolveSource(sourceId: string): Promise<{ name: string; display: Display | null; kind: 'screen' | 'window' }> {
  const kind = kindOf(sourceId)
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

function startTracker(s: ActiveRecording): void {
  tracker.start({
    display: activeDisplay ? { bounds: activeDisplay.bounds, scaleFactor: activeDisplay.scaleFactor } : null,
    // A window whose position is known (native window capture, or a watcher) gets the
    // cursor and clicks in screen coordinates, mapped into the window when finalised.
    global: s.windowId !== null && (s.manifest.method === 'native' || s.watchesWindow),
    captureKeys,
    isOwnPoint,
    // The app's own hotkeys are never recorded as keystrokes.
    ignoreKeys: Object.values(registered).map((a) => hotkeyLabel(a)),
    ...(options.autoPause ? { onActivity: () => idle?.activity() } : {})
  })
}

/** Where a recorded window's cursor positions go in its video; null without its rectangle. */
async function windowTrackMapping(s: ActiveRecording, raw: RawTrack): Promise<WindowMapping | null> {
  const { mapping, scale } = windowCursorMapping(await s.windowRects(), { width: s.manifest.width, height: s.manifest.height }, screen)
  // The drawn cursor is as large as the real one on the window's monitor.
  if (scale) raw.scale = scale
  return mapping
}

/** Pause/resume hotkey: resumes a paused recording (also one paused by auto-pause), else pauses. */
function togglePause(): void {
  const s = active
  if (!s) return
  if (s.phase === 'paused') forwardCommand('resume')
  else if (s.phase === 'recording') forwardCommand('pause')
}

/** "Zoom here" hotkey: remembers the instant for auto zoom and lets the toolbar acknowledge it. */
function addMark(): void {
  if (active?.phase !== 'recording') return
  tracker.mark()
  marks++
  lastStatus = { ...lastStatus, marks }
  sendToolbarStatus(lastStatus)
}

const HOTKEY_HANDLERS: Record<HotkeyAction, () => void> = {
  stop: () => forwardCommand('stop'),
  pause: togglePause,
  mark: addMark
}

function unregisterHotkeys(): void {
  for (const accelerator of Object.values(registered)) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      // Not registered.
    }
  }
  registered = {}
}

/**
 * Registers the recording hotkeys for the recording being prepared. Returns a message for each
 * one another app already owns (the toolbar buttons still work).
 */
function registerHotkeys(keys: Hotkeys): string[] {
  unregisterHotkeys()
  const problems: string[] = []
  for (const action of HOTKEY_ACTIONS) {
    const accelerator = keys[action]
    if (!accelerator) continue
    const what = `${hotkeyLabel(accelerator)} (${HOTKEY_NAMES[action].toLowerCase()})`
    try {
      if (globalShortcut.register(accelerator, HOTKEY_HANDLERS[action])) registered[action] = accelerator
      else problems.push(`${what} is used by another app, so it does not work during this recording.`)
    } catch (err) {
      console.warn(`Could not register ${accelerator}:`, err)
      problems.push(`${what} cannot be used as a hotkey; pick another one on the home screen.`)
    }
  }
  return problems
}

/** Labels of the hotkeys that work during the recording, for the toolbar. */
function hotkeyLabels(): Partial<Record<HotkeyAction, string>> {
  const out: Partial<Record<HotkeyAction, string>> = {}
  for (const action of HOTKEY_ACTIONS) {
    const accelerator = registered[action]
    if (accelerator) out[action] = hotkeyLabel(accelerator)
  }
  return out
}

function toolbarStatus(update: Pick<ToolbarStatus, 'state' | 'elapsed' | 'starting'>): ToolbarStatus {
  return {
    state: update.state,
    elapsed: update.elapsed,
    stopShortcut,
    hotkeys: hotkeyLabels(),
    ...(hotkeyProblems.length ? { hotkeyProblems } : {}),
    ...(marks ? { marks } : {}),
    ...(update.starting ? { starting: true } : {}),
    ...(update.state === 'paused' && autoPaused ? { idle: true } : {})
  }
}

/** Auto-pause for the recording that just started, when it is switched on. */
function startIdleDetection(): void {
  stopIdleDetection()
  if (!options.autoPause) return
  if (!tracker.hookRunning) {
    // Without the input hook typing cannot be seen: auto-pause would stop a recording mid-sentence.
    mainContents()?.send('recorder:warning', 'Auto-pause was off for this recording: mouse and keyboard input could not be watched on this PC.')
    return
  }
  idle = new IdleDetector(options.idleSeconds * 1000, {
    onIdle: () => {
      if (active?.phase !== 'recording') return
      autoPaused = true
      forwardCommand('pause')
    },
    onActive: () => {
      // Sent even if the pause has not been confirmed yet: the recorder handles commands in order.
      if (autoPaused) forwardCommand('resume')
    }
  })
  idle.start()
}

function stopIdleDetection(): void {
  idle?.stop()
  idle = null
  autoPaused = false
}

function endRecordingUi(): void {
  unregisterHotkeys()
  stopIdleDetection()
  hotkeyProblems = []
  marks = 0
  // The desktop icons come back as soon as the recording ends (stop, cancel or crash).
  void icons.restore()
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
  const raw: RawTrack = tracker.active ? tracker.collect() : { samples: [], clicks: [], keys: [], bounds: null, scale: 1 }
  const m = s.manifest
  if (m.startedAt === null) return
  const window = s.windowId !== null ? await windowTrackMapping(s, raw) : null
  // Slack: the final duration comes from the proxy and is applied by processRecording.
  const track = buildCursorTrack(raw, { startedAt: m.startedAt, pauses: s.pauses, duration, region: m.region, shapes, slack: 1, window })
  await projects.writeCursor(m.id, track)
}

async function discard(s: ActiveRecording): Promise<void> {
  if (active === s) active = null
  grant = null
  tracker.stop()
  s.killNative()
  s.killWatch()
  // A helper still starting would otherwise keep writing into the folder removed below.
  await s.cancelNativeStart()
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

/**
 * The native helper ended by itself (recorded monitor unplugged or switched off, GPU
 * reset, crash). Stop the whole recording there, keep everything captured until then,
 * and tell the user why, instead of recording audio and camera over a frozen screen.
 */
function onNativeEnded(s: ActiveRecording, info: NativeEndedInfo): void {
  console.warn(`Native capture ended on its own (${info.reason})`, info.error ?? '')
  if (active !== s) return
  if (s.phase === 'countdown') {
    // The recorder has not reported its start yet: started() stops it right after.
    s.nativeEnded = info
    return
  }
  if (s.phase === 'recording' || s.phase === 'paused') stopAfterNativeEnd(s, info)
}

function stopAfterNativeEnd(s: ActiveRecording, info: NativeEndedInfo): void {
  beginStop(s)
  mainContents()?.send('recorder:warning', nativeEndedMessage(info, s.windowId !== null ? 'window' : 'screen'))
  forwardCommand('stop')
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
  // Areas apply to screens only (the Area tab picks screens).
  let region: NormRect | null = null
  if (request.region && source.kind === 'screen') {
    if (!source.display) throw new RecordingError('Could not find the display for the selected area.')
    region = sanitizeRegion(request.region, source.display.bounds)
    if (!region) throw new RecordingError(`The selected area is too small (at least ${MIN_SIZE} × ${MIN_SIZE}). Select a larger area.`)
  }
  const api = nativeCapture()
  // Windows: native window capture, else Chromium with a watcher, else Chromium alone.
  const windowRoute: WindowRoute | null = source.kind === 'window' ? await planWindowCapture(api, request.sourceId) : null
  const native = windowRoute ? windowRoute.method === 'native' : !!source.display && (await nativeAvailable(api))
  const watch = windowRoute?.method === 'chromium' && windowRoute.watch ? windowRoute : null
  const notice = windowRoute?.method === 'chromium' && !windowRoute.watch ? WINDOW_NO_EFFECTS : undefined
  // Warm the encoder probe while recording so processing can start at once.
  void detectH264Encoders()

  const settings = readRecordingSettings()
  const { id, dir } = await projects.createProjectDir().catch((err: unknown) => {
    watch?.watch.kill()
    throw new RecordingError(friendlyMessage(err, projects.projectsRoot()))
  })
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
    fps: settings.fps,
    webcamFps: 30,
    webcamOffset: 0,
    audioOffset: 0,
    duration: null
  }
  try {
    await projects.writeManifest(manifest)
  } catch (err) {
    watch?.watch.kill()
    await projects.deleteProject(id).catch(() => undefined)
    throw new RecordingError(friendlyMessage(err, projects.projectsRoot()))
  }
  const s = new ActiveRecording(manifest, dir, source.kind === 'window' ? request.sourceId : null)
  if (watch) s.attachWatch(watch.watch, watch.first)
  active = s
  activeDisplay = source.display
  captureKeys = request.captureKeys
  options = settings
  grant = { id: request.sourceId, name: source.name, systemAudio: request.systemAudio }
  prepareToolbar(source.display, region && source.display ? regionToRect(region, source.display.bounds) : null)
  marks = 0
  hotkeyProblems = registerHotkeys(settings.hotkeys)
  stopShortcut = !settings.hotkeys.stop || !!registered.stop
  lastStatus = toolbarStatus({ state: 'idle', elapsed: 0 })
  // Hidden during the countdown, so they are gone when capture starts.
  if (settings.hideDesktopIcons) void icons.hide()
  return {
    token: s.token,
    method: manifest.method,
    stopShortcut,
    fps: settings.fps,
    ...(hotkeyProblems.length ? { hotkeyProblems } : {}),
    ...(notice ? { notice } : {})
  }
}

/** The recording options to use now; a broken settings file never stops a recording. */
function readRecordingSettings(): RecordingSettings {
  try {
    return appSettings().recording
  } catch (err) {
    console.warn('Could not read the app settings:', err)
    return structuredClone(DEFAULT_RECORDING_SETTINGS)
  }
}

/** Removes what a helper that failed to start left behind (its partial video and encoder checks). */
async function removeNativeLeftovers(dir: string): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (name !== projects.RAW.native && !name.startsWith(`${projects.RAW.native}.`)) continue
    // The killed helper may hold the file for a moment longer on Windows: rm retries EBUSY/EPERM.
    await fs.rm(path.join(dir, name), { force: true, maxRetries: 5, retryDelay: 200 }).catch((err) => console.warn('Could not remove', name, err))
  }
}

async function startNative(token: string): Promise<NativeStartResult> {
  const s = requireSession(token)
  if (s.manifest.method !== 'native' || (!activeDisplay && s.windowId === null)) return { ok: false, message: 'Native capture is not used for this recording.' }
  startTracker(s)
  const abort = new AbortController()
  const output = path.join(s.dir, projects.RAW.native)
  const starting = startNativeVideo(
    nativeCapture(),
    s.windowId !== null ? { windowId: s.windowId, output, fps: s.manifest.fps ?? 60 } : { displayId: String(activeDisplay!.id), output, fps: s.manifest.fps ?? 60 },
    // The helper's own start budget (monitor lookup, encoder setup, first frame) plus a margin.
    defaultStartTimeoutMs(),
    abort.signal
  )
  s.trackNativeStart(abort, starting)
  const result = await starting
  if (active !== s) {
    // Cancelled while the helper was starting.
    if (result.ok) result.session.kill()
    return { ok: false, message: 'The recording was cancelled.' }
  }
  if (!result.ok) {
    console.warn('Native capture failed, falling back to Chromium capture:', result.message)
    tracker.stop()
    s.manifest.method = 'chromium'
    void removeNativeLeftovers(s.dir)
    // A window keeps its cursor effects when a watcher can follow it while Chromium records it.
    const notice = s.windowId !== null ? await watchWindowAfterFallback(s, s.windowId) : undefined
    if (active !== s) return { ok: false, message: 'The recording was cancelled.' }
    // The in-memory manifest is what counts; started() writes it again.
    await projects.writeManifest(s.manifest).catch((err) => console.error('Could not save the recording state:', err))
    return { ok: false, message: result.message, ...(notice ? { notice } : {}) }
  }
  s.attachNative(result.session, result.info)
  // Optional in the contract: fakes may not report it.
  result.session.onEnded?.((info) => onNativeEnded(s, info))
  return { ok: true, startedAt: result.info.startedAt, width: result.info.width, height: result.info.height }
}

/** Starts following a window whose native capture failed; returns a notice when that fails too. */
async function watchWindowAfterFallback(s: ActiveRecording, windowId: string): Promise<string | undefined> {
  const abort = new AbortController()
  const watching = watchForChromium(nativeCapture(), windowId, undefined, abort.signal)
  // Cancelling the recording meanwhile stops the watcher before the folder is removed.
  s.trackNativeStart(abort, watching)
  const route = await watching
  if (!route.watch) return WINDOW_NO_EFFECTS
  if (active === s) s.attachWatch(route.watch, route.first)
  else route.watch.kill()
  return undefined
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
  // So a recording interrupted by a crash keeps its separately recorded sound in sync.
  if (typeof info.audioOffset === 'number' && Math.abs(info.audioOffset) < 60) m.audioOffset = info.audioOffset
  setExpectedStems(m, info.hasAudio ? info.stems : [])
  s.phase = 'recording'
  // Native capture started tracking with the helper; Chromium capture starts now.
  if (!s.usesNative) startTracker(s)
  startIdleDetection()
  // A failed write must not end a recording that is already running: the manifest in
  // memory is authoritative and is written again on stop.
  await projects.writeManifest(m).catch((err) => console.error('Could not save the recording state:', err))
  if (s.nativeEnded && active === s) stopAfterNativeEnd(s, s.nativeEnded)
}

function setStatus(token: string, status: RecorderStatusUpdate): void {
  const s = active
  if (!s || s.token !== token) return
  if (status.state === 'recording') {
    autoPaused = false
    // Watching again after a manual pause.
    if (idle && !idle.watching) idle.start()
  }
  lastStatus = toolbarStatus(status)
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
      // A pause by hand stays until resumed by hand; an automatic one ends with the next input.
      if (!autoPaused) idle?.stop()
      break
    case 'processing':
    case 'idle':
      if (status.state === 'processing') beginStop(s)
      endRecordingUi()
      return
  }
  sendToolbarStatus(lastStatus)
}

/**
 * Builds the project from a stopped recording's raw files. On any failure the raw
 * files stay as an unfinished recording (retryable from Home); only a recording with
 * nothing in it is removed. "Finish later" aborts it, keeping the raw files.
 */
async function runProcessing(m: projects.RecordingManifest, explainWhere: boolean): Promise<string> {
  processing.add(m.id)
  const abort = new AbortController()
  processingAborts.set(m.id, abort)
  try {
    m.status = 'processing'
    m.error = null
    await projects.writeManifest(m).catch((err) => console.error('Could not save the recording state:', err))
    return (await processRecording(m, sendProgress, abort.signal)).id
  } catch (err) {
    if (deferred.has(m.id) || isCancelled(err)) {
      m.status = 'interrupted'
      await projects.writeManifest(m).catch(() => undefined)
      throw new Error(PROCESSING_DEFERRED)
    }
    const message = friendlyMessage(err, projects.projectDir(m.id))
    console.error('Processing the recording failed:', err)
    if (err instanceof EmptyRecordingError) {
      await projects.deleteProject(m.id).catch(() => undefined)
      throw new Error(message)
    }
    m.status = 'failed'
    m.error = message
    await projects.writeManifest(m).catch(() => undefined)
    const where = explainWhere ? ` Your recording was kept in “${projects.projectDir(m.id)}”; you can retry it from Unfinished recordings.` : ''
    throw new Error(`${message}${where}`)
  } finally {
    processing.delete(m.id)
    deferred.delete(m.id)
    processingAborts.delete(m.id)
    // Lets a Home that lost track of this run (it was reloaded) clear its progress.
    sendProgress({ message: '', progress: null, done: true })
  }
}

/**
 * A stem stopped early while recording: none is kept. Written to the manifest at once, so a
 * recording recovered after a crash does not keep the others (or the shortened one) either.
 */
async function dropStems(token: string): Promise<void> {
  const s = active
  if (!s || s.token !== token || expectedStems(s.manifest).length === 0) return
  console.warn(STEMS_DROPPED)
  setExpectedStems(s.manifest, [])
  await projects.writeManifest(s.manifest).catch((err) => console.error('Could not save the recording state:', err))
}

async function save(token: string, payload: SaveRecordingPayload): Promise<string> {
  const s = requireSession(token)
  beginStop(s)
  s.phase = 'processing'
  grant = null
  const m = s.manifest
  try {
    try {
      await s.closeWriters()
    } catch (err) {
      throw new RecordingError(friendlyMessage(err, s.dir))
    }
    if (m.method === 'chromium' && Number.isFinite(payload.startedAt) && payload.startedAt > 0) m.startedAt = payload.startedAt
    const measured = m.method === 'native' ? s.activeSeconds() : payload.duration
    m.duration = measured > 0 ? measured : s.activeSeconds()
    m.webcamOffset = Number.isFinite(payload.webcamOffset) ? payload.webcamOffset : 0
    m.audioOffset = Number.isFinite(payload.audioOffset) ? payload.audioOffset : 0
    // Stems are kept only as a complete set: after one failed, the editor uses the mixed sound.
    await settleStems(m, s.dir, payload.stems)
    try {
      await writeTrack(s, m.duration)
    } catch (err) {
      // The video matters more than the cursor data: carry on without it.
      console.error('Could not save the cursor track:', err)
    }
    return await runProcessing(m, true)
  } finally {
    // The input hook only ever runs while recording.
    tracker.stop()
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
  return runProcessing(m, false)
}

async function pickRegion(sourceId: string): Promise<RegionSelection | null> {
  const source = await resolveSource(sourceId)
  if (source.kind !== 'screen' || !source.display) throw new RecordingError('Areas can only be selected on a screen.')
  const display = source.display
  const pick = await pickRegionOnDisplay(display)
  if (!pick.region) {
    if (pick.rejected) throw new RecordingError(`The selected area is too small (at least ${MIN_SIZE} × ${MIN_SIZE}). Select a larger area.`)
    return null
  }
  const { region } = pick
  const { width, height } = display.bounds
  return {
    region,
    width: Math.round(region.w * width * display.scaleFactor),
    height: Math.round(region.h * height * display.scaleFactor)
  }
}

/** What window recordings get on this PC; the main window serves as the window to try a watcher on. */
function windowSupport(): Promise<WindowCaptureSupport> {
  const main = getMainWindow()
  const probe = main && !main.isDestroyed() ? main.getMediaSourceId() : null
  return windowCaptureSupport(nativeCapture(), probe)
}

function thumbnailUrl(image: NativeImage): string {
  if (image.isEmpty()) return ''
  return `data:image/jpeg;base64,${image.toJPEG(THUMBNAIL.quality).toString('base64')}`
}

/** The source kinds a renderer asked for (both when unspecified or malformed). */
function requestedKinds(value: unknown): CaptureSource['kind'][] {
  const kinds = Array.isArray(value) ? value.filter((k): k is CaptureSource['kind'] => k === 'screen' || k === 'window') : []
  return kinds.length > 0 ? [...new Set(kinds)] : ['screen', 'window']
}

export function registerRecordingIpc(): void {
  setupDisplayMedia()

  ipcMain.handle('sources:list', async (_e, kinds?: unknown): Promise<CaptureSource[]> => {
    const types = requestedKinds(kinds)
    const own = new Set(liveWindows().map((w) => w.getMediaSourceId()))
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: THUMBNAIL.width, height: THUMBNAIL.height },
      fetchWindowIcons: false
    })
    for (const id of [...sourceInfo.keys()]) if (types.includes(kindOf(id))) sourceInfo.delete(id)
    return sources
      .filter((s) => !own.has(s.id) && s.name !== 'Screen Studio for Windows')
      .map((s) => {
        const kind = kindOf(s.id)
        const displayId = kind === 'screen' ? s.display_id || undefined : undefined
        sourceInfo.set(s.id, { name: s.name, displayId })
        return { id: s.id, name: s.name, thumbnail: thumbnailUrl(s.thumbnail), kind, displayId }
      })
  })

  ipcMain.handle('recording:windowSupport', () => windowSupport())
  ipcMain.handle('recording:prepare', (_e, request: RecordingRequest) => prepare(request))
  ipcMain.handle('recording:chunk', async (_e, token: string, kind: TrackKind, data: Uint8Array) => {
    const s = requireSession(token)
    if (!TRACK_KINDS.includes(kind)) throw new Error(`Unknown track ${kind}`)
    try {
      await s.write(kind, data)
    } catch (err) {
      throw new Error(friendlyMessage(err, s.dir))
    }
  })
  ipcMain.handle('recording:startNative', (_e, token: string) => startNative(token))
  ipcMain.handle('recording:started', (_e, token: string, info: RecordingStartInfo) => started(token, info))
  ipcMain.handle('recording:dropStems', (_e, token: string) => dropStems(token))
  ipcMain.handle('recording:status', (_e, token: string, status: RecorderStatusUpdate) => setStatus(token, status))
  ipcMain.handle('recording:command', (_e, command: RecorderCommand) => forwardCommand(command))
  ipcMain.handle('recording:getStatus', (): ToolbarStatus => lastStatus)
  ipcMain.handle('recording:save', (_e, token: string, payload: SaveRecordingPayload) => save(token, payload))
  ipcMain.handle('recording:cancel', (_e, token: string) => cancel(token))
  ipcMain.handle('recording:pickRegion', (_e, sourceId: string) => pickRegion(sourceId))
  ipcMain.handle('recordings:unfinished', () => projects.listUnfinished(new Set([...processing, ...(active ? [active.id] : [])])))
  ipcMain.handle('recordings:recover', (_e, id: string) => recover(id))
  ipcMain.handle('recordings:finishLater', () => {
    // Stops the conversion for good (never a fallback to another encoder); the raw
    // files stay and the recording is listed as unfinished.
    for (const id of processing) {
      deferred.add(id)
      processingAborts.get(id)?.abort()
    }
  })
  ipcMain.handle('recording:privacySettings', async (_e, kind: 'microphone' | 'camera') => {
    if (process.platform === 'win32') await shell.openExternal(`ms-settings:privacy-${kind === 'camera' ? 'webcam' : 'microphone'}`)
  })
  ipcMain.handle('settings:get', (): AppSettings => appSettings().get())
  ipcMain.handle('settings:updateRecording', (_e, patch: RecordingSettingsPatch): AppSettings => appSettings().updateRecording(patch))
  ipcMain.handle('settings:checkHotkey', (_e, action: HotkeyAction, accelerator: string) => checkHotkey(action, accelerator))

  // Desktop icons that a crashed session left hidden come back now.
  void icons.restore()
}

/**
 * Whether `accelerator` can be the hotkey for `action`: valid, distinct from the other recording
 * hotkeys and, outside a recording, free (registered and released at once to find out).
 */
function checkHotkey(action: HotkeyAction, accelerator: string): HotkeyCheck {
  if (!HOTKEY_ACTIONS.includes(action)) return { ok: false, message: 'Unknown hotkey.' }
  const check = validateHotkey(accelerator)
  if (!check.ok) return check
  const current = appSettings().recording.hotkeys
  for (const other of HOTKEY_ACTIONS) {
    if (other !== action && normalizeHotkey(current[other]) === check.accelerator) {
      return { ok: false, message: `${hotkeyLabel(check.accelerator)} is already the hotkey for ${HOTKEY_NAMES[other]}.` }
    }
  }
  // During a recording the app holds its own hotkeys; the next recording reports a clash.
  if (active || normalizeHotkey(current[action]) === check.accelerator) return check
  const label = hotkeyLabel(check.accelerator)
  try {
    if (!globalShortcut.register(check.accelerator, () => undefined)) return { ok: false, message: `${label} is already used by another app.` }
    globalShortcut.unregister(check.accelerator)
    return check
  } catch (err) {
    console.warn(`Could not test ${check.accelerator}:`, err)
    return { ok: false, message: `${label} cannot be used as a hotkey.` }
  }
}

/** Recovery and quit protection for the window that runs the recorder. */
export function attachRecorderWindow(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_e, details) => {
    void (async () => {
      const s = active
      const recording = !!s && s.phase !== 'processing'
      const kept = recording && s.manifest.startedAt !== null
      if (s && recording) {
        if (kept) await interrupt(s)
        else await discard(s)
      }
      grant = null
      endRecordingUi()
      if (win.isDestroyed()) return
      loadRoute(win, '/')
      if (details.reason === 'clean-exit') return
      // Only a crash during a recording is the recorder's; otherwise say what really happened.
      const { message, detail } = rendererGoneDialog({ recording, kept, processing: !recording && processing.size > 0 })
      await dialog.showMessageBox(win, { type: 'warning', title: 'Screen Studio for Windows', message, detail })
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
  stopIdleDetection()
  icons.restoreSync()
  tracker.stop()
  active?.killNative()
  active?.killWatch()
  killAllFfmpeg()
}
