/**
 * The speaker notes settings and script, stored as JSON in userData/notes.json
 * (`{ version: 1, ...NotesSettings }`). Read once (small file, synchronous); a missing,
 * unreadable or malformed file means defaults, field by field (sanitizeNotesSettings). Every
 * change is written through writeFileAtomicSync, like src/main/appSettings.ts, except while a
 * recording runs: hold() keeps changes in memory (the window's speed and size buttons, a drag)
 * so no synchronous file write can block the main process mid-recording, and release() writes
 * them once (end of the recording, or quitting). See docs/design/teleprompter.md, "Persistence".
 *
 * STUB (contracts commit): signatures frozen for workstream A, which writes the bodies.
 */
import type { NotesSettings } from '../../shared/notes/notes'

export const NOTES_FILE = 'notes.json'
export const NOTES_FILE_VERSION = 1

export class NotesStore {
  /**
   * `file`: the JSON file. `taken`: the recording hotkeys right now (a notes hotkey never equals
   * one of them; read on every sanitise, so a recording hotkey changed meanwhile wins).
   */
  constructor(
    readonly file: string,
    private readonly taken: () => readonly string[] = () => []
  ) {}

  /** A copy of the current settings. */
  get(): NotesSettings {
    void this.taken
    throw new Error('NotesStore.get: not implemented yet (workstream A)')
  }

  /** Applies a patch (validated by applyNotesPatch), saves it (unless held) and returns the result. Throws when it cannot be saved. */
  update(_patch: unknown): NotesSettings {
    throw new Error('NotesStore.update: not implemented yet (workstream A)')
  }

  /** From now on keep changes in memory only (a recording started). */
  hold(): void {
    throw new Error('NotesStore.hold: not implemented yet (workstream A)')
  }

  /** Writes what changed while held, once; never throws (a failure is logged). */
  release(): void {
    throw new Error('NotesStore.release: not implemented yet (workstream A)')
  }
}

/** The app's notes store (userData/notes.json). */
export function notesStore(): NotesStore {
  throw new Error('notesStore: not implemented yet (workstream A)')
}
