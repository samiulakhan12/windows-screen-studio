/**
 * The speaker notes window (`#/notes`): its own sandboxed route window, like the recording bar.
 * Two modes, and the window is destroyed and created again when the mode changes:
 * - 'rehearse' (opened from Home): focusable, shown with show(), Esc closes it;
 * - 'record' (created in prepare(), shown at the countdown): focusable: false, only ever shown
 *   with showInactive(), never show(), focus(), moveTop() or a dialog parented to it.
 * Both: frameless, opaque (--surface-0), resizable: false and thickFrame: false (an in-page grip
 * resizes it; no Aero Snap at the top edge), alwaysOnTop at 'screen-saver', skipTaskbar,
 * hasShadow: false, backgroundThrottling: false, and setContentProtection(true) right after
 * construction, before the route loads and long before the first show. A crashed page reloads
 * its route. While it is open its hotkeys (NOTES_HOTKEY_ACTIONS) are registered globally.
 * See docs/design/teleprompter.md, "Window" and "Lifecycle".
 */
import { BrowserWindow, globalShortcut, screen, type Display, type Point, type WebContents } from 'electron'
import type { NotesCommand, NotesMode, NotesRecordingState, NotesReport, NotesView, NotesWindowInfo } from '../../shared/api/notes'
import { applyNotesPatch, hasNotesText, NOTES_HEIGHT, NOTES_WIDTH, type NotesLookPatch, type NotesSettings, type NotesSettingsPatch } from '../../shared/notes/notes'
import { notesAllowed, notesBounds, placementOf, rectsOverlap, type CaptureKind, type NotesDisplay } from '../../shared/notes/placement'
import { hotkeyLabel, NOTES_HOTKEY_ACTIONS, NOTES_HOTKEY_NAMES, type NotesHotkeyAction } from '../../shared/recording/hotkeys'
import { AreaHistory } from '../../shared/recording/ownAreas'
import type { Rect } from '../../shared/recording/windowGeometry'
import { writeScriptFile } from '../projects'
import { captureExclusionSupported } from '../recording/captureExclusion'
import { getMainWindow, loadRoute, preloadPath } from '../windows'
import { notesStore } from './notesStore'

/** What prepare() knows about the recording when it decides on the notes. */
export interface RecordingNotesPlan {
  kind: CaptureKind
  /** The recorded display (null for a window recording). */
  display: Display | null
  /** What is captured in screen DIP: the display's bounds, the area's rectangle; null for a window. */
  captured: Rect | null
}

/** Why the notes stay hidden on a PC that cannot keep them out of the capture (CapturePlan.notesNotice). */
export const NOTES_NOTICE = {
  screen:
    'Your notes stay hidden in this recording: on this version of Windows they would show in the video as a black box. Move them off the recorded screen or area while rehearsing, or update to Windows 10 version 2004 or later.',
  window:
    'Your notes stay hidden in window recordings on this version of Windows: they would show in the video as a black box. Update to Windows 10 version 2004 or later to use them.'
} as const

/** The page's background (--surface-0): opaque, so nothing flashes before it paints. */
const BACKGROUND = '#0e0e11'
/** Changes from the window (a grip drag sends one per frame) are saved this long after the last one. */
const SAVE_DELAY_MS = 300
/** How far the window may sit from where it was put before it is put there again (mixed DPI). */
const BOUNDS_TOLERANCE = 1

const COMMANDS: Record<NotesHotkeyAction, NotesCommand> = { notesToggle: 'toggle', notesBack: 'back', notesForward: 'forward' }

interface NotesWin {
  win: BrowserWindow
  mode: NotesMode
  /** ready-to-show fired. */
  ready: boolean
  /** Shown as soon as it is ready (asked for before the page loaded). */
  showWhenReady: boolean
  /** Not hidden from the recording bar (always true while rehearsing). */
  shown: boolean
  /** Shown at least once (the bounds are read back after the first show). */
  everShown: boolean
  /** Older Windows: cannot be moved or resized during this recording. */
  locked: boolean
  /** Where the window was put (DIP). */
  rect: Rect
  /** What the recording captures (older Windows: the notes must stay off it). */
  captured: Rect | null
  /** The last view sent, to send only changes. */
  sentView: string
}

let current: NotesWin | null = null
/** Between prepareRecordingNotes() and endRecordingNotes(). */
let recordingOn = false
let recordingState: NotesRecordingState | null = null
let take = 0
let report: NotesReport = { playing: false, ended: false, block: 0 }
/** Notes hotkeys registered now, by action. */
let registered: Partial<Record<NotesHotkeyAction, string>> = {}
let problems: string[] = []
/** Where the notes window was, and when (clicks and wheel there are not content). */
const areas = new AreaHistory()
/** Changes from the window not saved yet (saved SAVE_DELAY_MS after the last). */
let pendingLook: NotesSettingsPatch | null = null
let saveTimer: NodeJS.Timeout | null = null
const listeners = new Set<() => void>()
let screenWatched = false

const alive = (n: NotesWin | null): n is NotesWin => !!n && !n.win.isDestroyed()

/** Tells the recording bar and Home that something about the notes changed. */
export function onNotesChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const l of listeners) {
    try {
      l()
    } catch (err) {
      console.warn('A speaker notes listener failed:', err)
    }
  }
}

/** The settings now, with the window's unsaved changes. */
export function notesSettingsNow(): NotesSettings {
  const saved = notesStore().get()
  return pendingLook ? applyNotesPatch(saved, pendingLook) : saved
}

function flushLook(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  const patch = pendingLook
  pendingLook = null
  if (!patch) return
  try {
    notesStore().update(patch)
  } catch (err) {
    console.warn('Could not save the speaker notes window:', err)
  }
}

function saveLook(patch: NotesSettingsPatch): void {
  pendingLook = { ...pendingLook, ...patch }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushLook, SAVE_DELAY_MS)
}

function notesDisplays(): NotesDisplay[] {
  const primary = screen.getPrimaryDisplay()
  const all = screen.getAllDisplays()
  return (all.length ? all : [primary]).map((d) => ({ id: String(d.id), bounds: d.bounds, workArea: d.workArea, primary: d.id === primary.id }))
}

function areaNow(rect: Rect | null): void {
  areas.set(rect, Date.now())
}

/* ---------------- hotkeys ---------------- */

function unregisterNotesHotkeys(): void {
  for (const accelerator of Object.values(registered)) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      // Not registered.
    }
  }
  registered = {}
  problems = []
}

/** Registers the notes hotkeys of `settings` (the ones already held stay); problems are kept for the view and the bar. */
function registerNotesHotkeys(settings: NotesSettings): void {
  unregisterNotesHotkeys()
  for (const action of NOTES_HOTKEY_ACTIONS) {
    const accelerator = settings.hotkeys[action]
    if (!accelerator) continue
    const what = `${hotkeyLabel(accelerator)} (${NOTES_HOTKEY_NAMES[action]})`
    try {
      if (globalShortcut.register(accelerator, () => notesHotkey(action))) registered[action] = accelerator
      else problems.push(`${what} is used by another app, so it does not work while your notes are open.`)
    } catch (err) {
      console.warn(`Could not register ${accelerator}:`, err)
      problems.push(`${what} cannot be used as a hotkey; pick another one in Speaker notes.`)
    }
  }
}

/** Labels of the notes hotkeys that work now (for the view, the bar and the tracker's ignored keys). */
export function notesHotkeyLabels(): Partial<Record<NotesHotkeyAction, string>> {
  const out: Partial<Record<NotesHotkeyAction, string>> = {}
  for (const action of NOTES_HOTKEY_ACTIONS) {
    const accelerator = registered[action]
    if (accelerator) out[action] = hotkeyLabel(accelerator)
  }
  return out
}

/** Notes hotkeys that could not be registered, as messages. */
export function notesHotkeyProblems(): string[] {
  return [...problems]
}

/* ---------------- the view ---------------- */

function buildView(n: NotesWin): NotesView {
  return {
    mode: n.mode,
    recording: n.mode === 'record' ? recordingState : null,
    take,
    shown: n.shown,
    settings: notesSettingsNow(),
    hotkeys: notesHotkeyLabels(),
    problems: [...problems],
    locked: n.locked
  }
}

/** The view for the notes window's page; null when there is no window. */
export function notesView(): NotesView | null {
  return alive(current) ? buildView(current) : null
}

function sendView(): void {
  const n = current
  if (!alive(n)) return
  const wc = n.win.webContents
  if (wc.isDestroyed() || wc.isCrashed()) return
  const view = buildView(n)
  const json = JSON.stringify(view)
  if (json === n.sentView) return
  n.sentView = json
  wc.send('notes:view', view)
}

/* ---------------- the window ---------------- */

function watchDisplays(): void {
  if (screenWatched) return
  screenWatched = true
  const again = (): void => placeAgain()
  screen.on('display-removed', again)
  screen.on('display-metrics-changed', again)
}

/** Puts the window where it belongs after the displays changed. */
function placeAgain(): void {
  const n = current
  if (!alive(n)) return
  const { rect } = notesBounds(notesDisplays(), notesSettingsNow())
  n.rect = rect
  n.win.setBounds(rect)
  // Older Windows: never moved onto what is recorded.
  if (n.locked && n.captured && rectsOverlap(rect, n.captured) && n.shown) {
    n.shown = false
    n.win.hide()
    notify()
  }
  if (n.win.isVisible()) areaNow(rect)
  sendView()
}

function create(mode: NotesMode, rect: Rect, locked: boolean, captured: Rect | null): NotesWin {
  watchDisplays()
  const win = new BrowserWindow({
    ...rect,
    frame: false,
    transparent: false,
    backgroundColor: BACKGROUND,
    // No WS_THICKFRAME: no Aero Snap at the top edge; the page has a grip.
    resizable: false,
    thickFrame: false,
    movable: !locked,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    // While recording it must never take focus from the app being recorded.
    focusable: mode === 'rehearse',
    title: 'Speaker notes',
    webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
  })
  // Before the route loads, so the page is never captured (and hidden from screen sharing).
  win.setContentProtection(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  const n: NotesWin = { win, mode, ready: false, showWhenReady: false, shown: true, everShown: false, locked, rect, captured, sentView: '' }
  win.once('ready-to-show', () => {
    n.ready = true
    if (n.showWhenReady && current === n) reveal(n)
  })
  win.on('moved', () => {
    if (current !== n || win.isDestroyed()) return
    const b = win.getBounds()
    // Some platforms report our own setBounds() as a move: only a real drag is remembered.
    if (b.x === n.rect.x && b.y === n.rect.y && b.width === n.rect.width && b.height === n.rect.height) return
    n.rect = b
    if (win.isVisible()) areaNow(b)
    saveLook({ placement: placementOf(notesDisplays(), b) })
    sendView()
    notify()
  })
  win.on('closed', () => {
    if (current === n) dispose(n)
  })
  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) loadRoute(win, '/notes')
  })
  // A (re)loaded page gets the view again.
  win.webContents.on('did-finish-load', () => {
    n.sentView = ''
    if (current === n) sendView()
  })
  loadRoute(win, '/notes')
  return n
}

/** Shows `n` now: show() while rehearsing, never anything that activates it while recording. */
function reveal(n: NotesWin): void {
  if (!alive(n)) return
  n.showWhenReady = false
  if (!n.win.isVisible()) {
    if (n.mode === 'rehearse') n.win.show()
    else n.win.showInactive()
  }
  if (!n.everShown) {
    n.everShown = true
    // Electron has misapplied sizes across monitors with different scaling: put it right again.
    const b = n.win.getBounds()
    const off = Math.max(Math.abs(b.x - n.rect.x), Math.abs(b.y - n.rect.y), Math.abs(b.width - n.rect.width), Math.abs(b.height - n.rect.height))
    if (off > BOUNDS_TOLERANCE) n.win.setBounds(n.rect)
  }
  areaNow(n.win.getBounds())
}

/** Shows when ready (or at once when it is). */
function revealWhenReady(n: NotesWin): void {
  if (n.ready) reveal(n)
  else n.showWhenReady = true
}

function hide(n: NotesWin): void {
  n.showWhenReady = false
  if (alive(n) && n.win.isVisible()) n.win.hide()
  areaNow(null)
}

/** Forgets the window and destroys it (its hotkeys are released). */
function dispose(n: NotesWin): void {
  if (current === n) {
    current = null
    unregisterNotesHotkeys()
    report = { playing: false, ended: false, block: 0 }
    flushLook()
  }
  areaNow(null)
  if (!n.win.isDestroyed()) n.win.destroy()
  notify()
}

/* ---------------- rehearsal ---------------- */

/** Opens the rehearsal window (closing nothing else); false while a recording runs. */
export function openRehearsal(): boolean {
  if (recordingOn) return false
  if (alive(current) && current.mode === 'rehearse') {
    revealWhenReady(current)
    return true
  }
  // A recording window kept for a restart that never came: a different mode means a new window.
  if (current) dispose(current)
  const settings = notesSettingsNow()
  const { rect } = notesBounds(notesDisplays(), settings)
  const n = create('rehearse', rect, false, null)
  current = n
  report = { playing: false, ended: false, block: 0 }
  registerNotesHotkeys(settings)
  revealWhenReady(n)
  sendView()
  notify()
  return true
}

/**
 * Closes the rehearsal window, releases its hotkeys and gives Home the focus back when
 * `focusMain` (it was closed from the window itself).
 */
export function closeRehearsal(focusMain = false): void {
  const n = current
  if (!n || n.mode !== 'rehearse') return
  dispose(n)
  if (!focusMain) return
  const main = getMainWindow()
  if (main && !main.isDestroyed()) {
    if (!main.isVisible()) main.show()
    main.focus()
  }
}

/* ---------------- recording ---------------- */

/**
 * For the recording being prepared: when there are notes to show and this PC may show them
 * (notesAllowed), creates the hidden 'record' window (protected at once), registers the notes
 * hotkeys, holds the store and writes the text to the recording folder when keepWithRecording.
 * `notice`: why the notes stay hidden (older Windows), for CapturePlan.notesNotice.
 */
export function prepareRecordingNotes(plan: RecordingNotesPlan, recordingDir: string): { shown: boolean; notice?: string } {
  recordingOn = true
  recordingState = null
  areas.clear()
  closeRehearsal()
  flushLook()
  const settings = notesStore().get()
  const kept = current
  if (!settings.showWhileRecording || !hasNotesText(settings.text)) {
    if (kept) dispose(kept)
    return { shown: false }
  }
  const { rect } = notesBounds(notesDisplays(), settings)
  const excluded = captureExclusionSupported()
  if (!notesAllowed({ excluded, kind: plan.kind, notes: rect, captured: plan.captured })) {
    if (kept) dispose(kept)
    return { shown: false, notice: plan.kind === 'window' ? NOTES_NOTICE.window : NOTES_NOTICE.screen }
  }
  // Allowed only because the notes are off the recorded area: they must stay there.
  const locked = !excluded
  let n: NotesWin
  if (alive(kept) && kept.mode === 'record' && kept.locked === locked) {
    n = kept
    n.locked = locked
    n.captured = plan.captured
    n.shown = true
    n.rect = rect
    n.win.setBounds(rect)
  } else {
    if (kept) dispose(kept)
    n = create('record', rect, locked, plan.captured)
    current = n
  }
  take++
  report = { playing: false, ended: false, block: 0 }
  registerNotesHotkeys(settings)
  notesStore().hold()
  if (settings.keepWithRecording) {
    void writeScriptFile(recordingDir, settings.text).catch((err) => console.warn('Could not keep the speaker notes with the recording:', err))
  }
  sendView()
  notify()
  return { shown: true }
}

/** Shows the prepared window without activating it (idempotent; waits for ready-to-show). */
export function showNotes(): void {
  const n = current
  if (!alive(n) || n.mode !== 'record' || !n.shown) return
  revealWhenReady(n)
}

/** The recording's state changed (the page follows it: countdown, recording, paused). */
export function setNotesRecording(state: NotesRecordingState): void {
  const n = current
  if (!alive(n) || n.mode !== 'record' || !recordingOn) return
  if (recordingState === state) return
  recordingState = state
  sendView()
}

/** The recording ended: closes the window, or hides it and keeps it for the next take (`restarting`). */
export function endRecordingNotes(restarting: boolean): void {
  const wasOn = recordingOn
  recordingOn = false
  recordingState = null
  const n = current
  if (n && n.mode === 'record') {
    if (restarting && alive(n)) {
      unregisterNotesHotkeys()
      hide(n)
      report = { playing: false, ended: false, block: 0 }
      flushLook()
      n.shown = true
      sendView()
      notify()
    } else {
      dispose(n)
    }
  }
  flushLook()
  if (wasOn) notesStore().release()
}

/** The recording bar's notes button: hides the window or shows it again. */
export function toggleNotesShown(): void {
  const n = current
  if (!alive(n) || n.mode !== 'record') return
  setShown(n, !n.shown)
}

function setShown(n: NotesWin, shown: boolean): void {
  n.shown = shown
  if (shown) {
    // Only once the recording shows it (the countdown); before that it stays hidden.
    if (recordingState) revealWhenReady(n)
  } else {
    hide(n)
  }
  sendView()
  notify()
}

/** The window's close button: hides it while recording, ends a rehearsal. */
export function dismissNotes(): void {
  const n = current
  if (!alive(n)) return
  if (n.mode === 'rehearse') closeRehearsal(true)
  else if (n.shown) setShown(n, false)
}

/** A notes hotkey was pressed (shows hidden notes; otherwise forwarded to the page). */
export function notesHotkey(action: NotesHotkeyAction): void {
  const n = current
  if (!alive(n)) return
  if (n.mode === 'record' && !n.shown) {
    setShown(n, true)
    return
  }
  const wc = n.win.webContents
  if (!wc.isDestroyed() && !wc.isCrashed()) wc.send('notes:command', COMMANDS[action])
}

/** What the page reported (sanitised by the caller). */
export function setNotesReport(next: NotesReport): void {
  if (!alive(current)) return
  const changed = next.playing !== report.playing || next.ended !== report.ended
  report = next
  if (changed) notify()
}

/**
 * A change from the window (speed, text size, the grip): saved (held while recording). A new
 * size keeps the top-left corner, within the limits and the work area; a locked window keeps its size.
 */
export function setNotesLook(patch: NotesLookPatch): void {
  const n = current
  if (!alive(n)) return
  const out: NotesSettingsPatch = {}
  if (patch.wpm !== undefined) out.wpm = patch.wpm
  if (patch.fontSize !== undefined) out.fontSize = patch.fontSize
  if ((patch.width !== undefined || patch.height !== undefined) && !n.locked) {
    const b = n.win.getBounds()
    const wa = screen.getDisplayMatching(b).workArea
    const clamp = (v: number | undefined, now: number, limits: { min: number; max: number }, room: number): number =>
      Math.floor(Math.min(room, Math.max(limits.min, Math.min(limits.max, v ?? now))))
    const width = clamp(patch.width, b.width, NOTES_WIDTH, wa.width)
    const height = clamp(patch.height, b.height, NOTES_HEIGHT, wa.height)
    const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - width))
    const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - height))
    const rect = { x, y, width, height }
    n.rect = rect
    n.win.setBounds(rect)
    if (n.win.isVisible()) areaNow(rect)
    out.width = width
    out.height = height
    out.placement = placementOf(notesDisplays(), rect)
  }
  if (Object.keys(out).length === 0) return
  saveLook(out)
  sendView()
  notify()
}

/**
 * The notes settings changed from Home (or a recording hotkey did): the open window gets the new
 * view, its hotkeys and its place.
 */
export function notesSettingsChanged(): void {
  const n = current
  if (!alive(n)) return
  const settings = notesSettingsNow()
  const wanted = NOTES_HOTKEY_ACTIONS.map((a) => settings.hotkeys[a]).join('|')
  const held = NOTES_HOTKEY_ACTIONS.map((a) => registered[a] ?? '').join('|')
  if (wanted !== held || problems.length) registerNotesHotkeys(settings)
  if (!n.locked) {
    const { rect } = notesBounds(notesDisplays(), settings)
    if (rect.x !== n.rect.x || rect.y !== n.rect.y || rect.width !== n.rect.width || rect.height !== n.rect.height) {
      n.rect = rect
      n.win.setBounds(rect)
      if (n.win.isVisible()) areaNow(rect)
    }
  }
  sendView()
  notify()
}

/** Whether `p` (screen DIP) was over the notes window at `at` (epoch ms): such clicks are not content. */
export function notesAreaContains(p: Point, at: number): boolean {
  return areas.contains(p, at)
}

/** The notes are scrolling (auto-pause waits meanwhile). */
export function notesPlaying(): boolean {
  const n = current
  return alive(n) && n.mode === 'record' && n.shown && report.playing && !report.ended
}

/** For ToolbarStatus.notes: null when the recording has no notes window. */
export function notesStatus(): { shown: boolean; playing: boolean } | null {
  const n = current
  if (!alive(n) || n.mode !== 'record' || !recordingOn) return null
  return { shown: n.shown, playing: n.shown && report.playing && !report.ended }
}

/** For NotesState.window. */
export function notesWindowInfo(): NotesWindowInfo | null {
  const n = current
  if (!alive(n)) return null
  return { mode: n.mode, shown: n.shown && (n.mode === 'rehearse' || recordingOn), playing: report.playing && !report.ended }
}

export function isNotesSender(wc: WebContents): boolean {
  const n = current
  if (!alive(n)) return false
  const own = n.win.webContents
  return !own.isDestroyed() && own.id === wc.id
}

/** Hides a rehearsal window while an area is picked; returns a function that shows it again. */
export function hideNotesWhilePicking(): () => void {
  const n = current
  if (!alive(n) || n.mode !== 'rehearse' || !n.win.isVisible()) return () => undefined
  hide(n)
  return () => {
    if (current === n && alive(n)) reveal(n)
  }
}

/** Closes any notes window (the main window closed). */
export function closeNotes(): void {
  if (current) dispose(current)
}
