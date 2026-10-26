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
 *
 * STUB (contracts commit): signatures for workstream A, which writes the bodies (and may add
 * exports). Every function is a no-op until then, so nothing changes for the recorder.
 */
import type { Display, Point, WebContents } from 'electron'
import type { NotesRecordingState, NotesWindowInfo } from '../../shared/api/notes'
import type { CaptureKind } from '../../shared/notes/placement'
import type { NotesHotkeyAction } from '../../shared/recording/hotkeys'
import type { Rect } from '../../shared/recording/windowGeometry'

/** What prepare() knows about the recording when it decides on the notes. */
export interface RecordingNotesPlan {
  kind: CaptureKind
  /** The recorded display (null for a window recording). */
  display: Display | null
  /** What is captured in screen DIP: the display's bounds, the area's rectangle; null for a window. */
  captured: Rect | null
}

/** Opens the rehearsal window (closing nothing else); false while a recording runs. */
export function openRehearsal(): boolean {
  return false
}

/** Closes the rehearsal window, releases its hotkeys and gives Home the focus back. */
export function closeRehearsal(): void {}

/**
 * For the recording being prepared: when there are notes to show and this PC may show them
 * (notesAllowed), creates the hidden 'record' window (protected at once), registers the notes
 * hotkeys, holds the store and writes the text to the recording folder when keepWithRecording.
 * `notice`: why the notes stay hidden (older Windows), for CapturePlan.notesNotice.
 */
export function prepareRecordingNotes(_plan: RecordingNotesPlan, _recordingDir: string): { shown: boolean; notice?: string } {
  return { shown: false }
}

/** Shows the prepared window without activating it (idempotent; waits for ready-to-show). */
export function showNotes(): void {}

/** The recording's state changed (the page follows it: countdown, recording, paused). */
export function setNotesRecording(_state: NotesRecordingState): void {}

/** The recording ended: closes the window, or hides it and keeps it for the next take (`restarting`). */
export function endRecordingNotes(_restarting: boolean): void {}

/** The recording bar's notes button: hides the window or shows it again. */
export function toggleNotesShown(): void {}

/** A notes hotkey was pressed (shows hidden notes; otherwise forwarded to the page). */
export function notesHotkey(_action: NotesHotkeyAction): void {}

/** Whether `p` (screen DIP) was over the notes window at `at` (epoch ms): such clicks are not content. */
export function notesAreaContains(_p: Point, _at: number): boolean {
  return false
}

/** The notes are scrolling (auto-pause waits meanwhile). */
export function notesPlaying(): boolean {
  return false
}

/** For ToolbarStatus.notes: null when the recording has no notes window. */
export function notesStatus(): { shown: boolean; playing: boolean } | null {
  return null
}

/** For NotesState.window. */
export function notesWindowInfo(): NotesWindowInfo | null {
  return null
}

export function isNotesSender(_wc: WebContents): boolean {
  return false
}

/** Hides a rehearsal window while an area is picked; returns a function that shows it again. */
export function hideNotesWhilePicking(): () => void {
  return () => undefined
}

/** Closes any notes window (the main window closed). */
export function closeNotes(): void {}
