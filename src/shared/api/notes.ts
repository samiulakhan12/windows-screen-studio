/**
 * Speaker notes (teleprompter) between the main process and three pages: Home (the main window:
 * edit, settings, rehearse), the notes window (`#/notes`, its own sandboxed window) and the
 * recording bar (show or hide the notes). See docs/design/teleprompter.md. FROZEN after the
 * contracts commit.
 *
 * Every channel is checked in the main process by its sender: Home's by the main window's
 * webContents (and the app's URL), the notes window's by that window's webContents, the bar's by
 * the bar's. A message from any other page is ignored (or rejected, for an invoke).
 */
import type { NotesHotkeyAction } from '../recording/hotkeys'
import type { NotesLookPatch, NotesSettings, NotesSettingsPatch } from '../notes/notes'

export type { NotesLookPatch, NotesSettings, NotesSettingsPatch } from '../notes/notes'

/** IPC channel names. */
export const NOTES_CHANNELS = {
  /** invoke, Home → NotesState. */
  get: 'notes:get',
  /** invoke, Home (NotesSettingsPatch) → NotesState. Rejects with a message to show when it cannot be saved. */
  update: 'notes:update',
  /** invoke, Home (open: boolean) → NotesState. Rejects with a message while a recording runs. */
  rehearse: 'notes:rehearse',
  /** main → Home: NotesState, sent only when it changed. */
  state: 'notes:state',
  /** invoke, notes window → NotesView | null. */
  getView: 'notes:getView',
  /** main → notes window: NotesView, whenever any of it changes. */
  view: 'notes:view',
  /** main → notes window: NotesCommand (a hotkey was pressed). */
  command: 'notes:command',
  /** send, notes window → main: NotesReport, only when one of its fields changed. */
  report: 'notes:report',
  /** send, notes window → main: NotesLookPatch (speed, text size, resize grip). */
  look: 'notes:look',
  /** send, notes window → main: its close button (hides it while recording, ends a rehearsal). */
  dismiss: 'notes:dismiss',
  /** invoke, recording bar → void: hides the notes or shows them again. */
  toggleShown: 'notes:toggleShown'
} as const

/** Rehearsal: opened from Home, focusable. Recording: never takes focus, out of the capture. */
export type NotesMode = 'rehearse' | 'record'

/** What a notes hotkey asks the notes window to do. */
export type NotesCommand = 'toggle' | 'back' | 'forward'

/** The recording's state as the notes window follows it. */
export type NotesRecordingState = 'countdown' | 'recording' | 'paused'

/** Whether this PC keeps the notes window out of recordings (Windows 10 2004+, macOS). */
export interface NotesSupport {
  hiddenFromCapture: boolean
}

/** The notes window, while one is open. */
export interface NotesWindowInfo {
  mode: NotesMode
  /** Not hidden from the recording bar. */
  shown: boolean
  /** The text is scrolling (as the window last reported). */
  playing: boolean
}

/** What Home shows. */
export interface NotesState {
  settings: NotesSettings
  support: NotesSupport
  window: NotesWindowInfo | null
}

/** Everything the notes window page needs to draw itself. */
export interface NotesView {
  mode: NotesMode
  /** The recording's state; null while rehearsing. 'countdown' puts the text at the top, held still. */
  recording: NotesRecordingState | null
  /** Counts the recordings this window followed: a new take starts at the top even if `recording` looks the same. */
  take: number
  /** False while hidden from the recording bar: the page stops scrolling and runs no timer. */
  shown: boolean
  settings: NotesSettings
  /** Labels of the notes hotkeys that work now ("Ctrl + Shift + F7"). */
  hotkeys: Partial<Record<NotesHotkeyAction, string>>
  /** Notes hotkeys that could not be registered, as messages to show. */
  problems: string[]
  /** The window cannot be moved during this recording (older Windows: it must stay off the recorded area). */
  locked: boolean
}

/** What the notes window tells the main process (auto-pause, the bar's notes button, Home). */
export interface NotesReport {
  playing: boolean
  /** The end of the text reached the reading line. */
  ended: boolean
  /** Index of the block on the reading line. */
  block: number
}

export interface NotesApi {
  /* ---- Home (main window) ---- */
  getNotes(): Promise<NotesState>
  /** Saves a change (validated in the main process) and returns the new state. */
  updateNotes(patch: NotesSettingsPatch): Promise<NotesState>
  /** Opens the rehearsal window (focusable, not recording) or closes it. */
  rehearseNotes(open: boolean): Promise<NotesState>
  onNotesState(cb: (state: NotesState) => void): () => void

  /* ---- the notes window ---- */
  /** The current view; null when this page is not the notes window. */
  getNotesView(): Promise<NotesView | null>
  onNotesView(cb: (view: NotesView) => void): () => void
  onNotesCommand(cb: (command: NotesCommand) => void): () => void
  reportNotes(report: NotesReport): void
  setNotesLook(patch: NotesLookPatch): void
  /** The window's close button: hides the notes while recording, ends a rehearsal. */
  dismissNotes(): void

  /* ---- the recording bar ---- */
  toggleNotesShown(): Promise<void>
}
