/**
 * IPC for the speaker notes (channels: NOTES_CHANNELS in src/shared/api/notes.ts). Home's
 * channels answer only the main window (its webContents, at the app's URL); the notes window's
 * only that window (isNotesSender); the recording bar's only the bar. Every value is checked
 * with the shared sanitisers before use. See docs/design/teleprompter.md, "IPC".
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { NOTES_CHANNELS, type NotesReport, type NotesState, type NotesView } from '../../shared/api/notes'
import { sanitizeLookPatch } from '../../shared/notes/notes'
import {
  anyHotkeyName,
  HOTKEY_ACTIONS,
  hotkeyLabel,
  isAnyHotkeyAction,
  NOTES_HOTKEY_ACTIONS,
  normalizeHotkey,
  validateHotkey,
  type AnyHotkeyAction,
  type HotkeyCheck,
  type Hotkeys,
  type NotesHotkeys
} from '../../shared/recording/hotkeys'
import { captureExclusionSupported } from '../recording/captureExclusion'
import { isToolbarSender } from '../recording/toolbarWindow'
import { isAppUrl } from '../security'
import { getMainWindow } from '../windows'
import { notesStore } from './notesStore'
import {
  closeRehearsal,
  dismissNotes,
  isNotesSender,
  notesSettingsChanged,
  notesSettingsNow,
  notesView,
  notesWindowInfo,
  onNotesChange,
  openRehearsal,
  setNotesLook,
  setNotesReport,
  toggleNotesShown
} from './notesWindow'

/** Whether a message comes from Home: the main window's own page. */
export function fromHome(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const main = getMainWindow()
  if (!main || main.isDestroyed() || main.webContents.isDestroyed()) return false
  return e.sender.id === main.webContents.id && isAppUrl(e.senderFrame?.url ?? '')
}

function requireHome(e: IpcMainInvokeEvent): void {
  if (!fromHome(e)) throw new Error('Not allowed')
}

export function notesState(): NotesState {
  return { settings: notesSettingsNow(), support: { hiddenFromCapture: captureExclusionSupported() }, window: notesWindowInfo() }
}

let sentState = ''

/** Sends Home the state when it changed since the last one it got. */
function broadcastState(state: NotesState = notesState()): void {
  const json = JSON.stringify(state)
  if (json === sentState) return
  sentState = json
  const wc = getMainWindow()?.webContents
  if (wc && !wc.isDestroyed() && !wc.isCrashed()) wc.send(NOTES_CHANNELS.state, state)
}

/** The state Home gets as an answer (remembered, so the same one is not sent again). */
function answer(): NotesState {
  const state = notesState()
  sentState = JSON.stringify(state)
  return state
}

function sanitizeReport(raw: unknown): NotesReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const block = typeof r.block === 'number' && Number.isFinite(r.block) ? Math.max(0, Math.floor(r.block)) : 0
  return { playing: r.playing === true, ended: r.ended === true, block }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** What checkAnyHotkey needs to know (injectable for tests). */
export interface HotkeyContext {
  recording: Hotkeys
  notes: NotesHotkeys
  /** A recording runs: the app holds its own hotkeys, so none is tested against other apps. */
  busy: boolean
  /** Registers and releases `accelerator` at once: false when another app owns it. Throws when it cannot be a hotkey. */
  tryRegister(accelerator: string): boolean
}

/**
 * Whether `accelerator` can be the hotkey for `action` (any of the six): valid, distinct from the
 * other five and, outside a recording, free (skipped for the action's current accelerator, which
 * the app may hold itself).
 */
export function checkAnyHotkey(action: unknown, accelerator: unknown, ctx: HotkeyContext): HotkeyCheck {
  if (!isAnyHotkeyAction(action)) return { ok: false, message: 'Unknown hotkey.' }
  const check = validateHotkey(accelerator)
  if (!check.ok) return check
  const all: Record<AnyHotkeyAction, string> = { ...ctx.recording, ...ctx.notes }
  for (const other of [...HOTKEY_ACTIONS, ...NOTES_HOTKEY_ACTIONS]) {
    if (other !== action && normalizeHotkey(all[other]) === check.accelerator) {
      return { ok: false, message: `${hotkeyLabel(check.accelerator)} is already the hotkey for ${anyHotkeyName(other)}.` }
    }
  }
  if (ctx.busy || normalizeHotkey(all[action]) === check.accelerator) return check
  const label = hotkeyLabel(check.accelerator)
  try {
    return ctx.tryRegister(check.accelerator) ? check : { ok: false, message: `${label} is already used by another app.` }
  } catch (err) {
    console.warn(`Could not test ${check.accelerator}:`, err)
    return { ok: false, message: `${label} cannot be used as a hotkey.` }
  }
}

export function registerNotesIpc(): void {
  onNotesChange(() => broadcastState())

  ipcMain.handle(NOTES_CHANNELS.get, (e): NotesState => {
    requireHome(e)
    return answer()
  })
  ipcMain.handle(NOTES_CHANNELS.update, (e, patch: unknown): NotesState => {
    requireHome(e)
    try {
      notesStore().update(patch)
    } catch (err) {
      console.warn('Could not save the speaker notes:', err)
      throw new Error(errorText(err))
    }
    notesSettingsChanged()
    return answer()
  })
  ipcMain.handle(NOTES_CHANNELS.rehearse, (e, open: unknown): NotesState => {
    requireHome(e)
    if (open === true) {
      if (!openRehearsal()) throw new Error('Finish the recording first.')
    } else {
      closeRehearsal()
    }
    return answer()
  })
  ipcMain.handle(NOTES_CHANNELS.getView, (e): NotesView | null => (isNotesSender(e.sender) ? notesView() : null))
  ipcMain.on(NOTES_CHANNELS.report, (e, raw: unknown) => {
    if (!isNotesSender(e.sender)) return
    const report = sanitizeReport(raw)
    if (report) setNotesReport(report)
  })
  ipcMain.on(NOTES_CHANNELS.look, (e, raw: unknown) => {
    if (isNotesSender(e.sender)) setNotesLook(sanitizeLookPatch(raw))
  })
  ipcMain.on(NOTES_CHANNELS.dismiss, (e) => {
    if (isNotesSender(e.sender)) dismissNotes()
  })
  ipcMain.handle(NOTES_CHANNELS.toggleShown, (e): void => {
    if (isToolbarSender(e.sender)) toggleNotesShown()
  })
}
