/**
 * IPC for the speaker notes (channels: NOTES_CHANNELS in src/shared/api/notes.ts). Home's
 * channels answer only the main window (its webContents, at the app's URL); the notes window's
 * only that window (isNotesSender); the recording bar's only the bar. Every value is checked
 * with the shared sanitisers before use. See docs/design/teleprompter.md, "IPC".
 *
 * STUB (contracts commit): registers nothing yet; workstream A writes it.
 */
export function registerNotesIpc(): void {}
