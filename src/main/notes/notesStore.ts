/**
 * The speaker notes settings and script, stored as JSON in userData/notes.json
 * (`{ version: 1, ...NotesSettings }`). Read once (small file, synchronous); a missing,
 * unreadable or malformed file means defaults, field by field (sanitizeNotesSettings). Every
 * change is written through writeFileAtomicSync, like src/main/appSettings.ts, except while a
 * recording runs: hold() keeps changes in memory (the window's speed and size buttons, a drag)
 * so no synchronous file write can block the main process mid-recording, and release() writes
 * them once (end of the recording, or quitting). See docs/design/teleprompter.md, "Persistence".
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { applyNotesPatch, sanitizeNotesSettings, type NotesSettings } from '../../shared/notes/notes'
import { appSettings } from '../appSettings'
import { writeFileAtomicSync } from '../atomicWrite'

export const NOTES_FILE = 'notes.json'
export const NOTES_FILE_VERSION = 1

const same = (a: NotesSettings, b: NotesSettings): boolean => JSON.stringify(a) === JSON.stringify(b)

export class NotesStore {
  private value: NotesSettings | null = null
  private held = false
  /** Changes made while held, not written yet. */
  private dirty = false

  /**
   * `file`: the JSON file. `taken`: the recording hotkeys right now (a notes hotkey never equals
   * one of them; read on every sanitise, so a recording hotkey changed meanwhile wins).
   */
  constructor(
    readonly file: string,
    private readonly taken: () => readonly string[] = () => []
  ) {}

  private load(): NotesSettings {
    if (this.value) return this.value
    let raw: unknown = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring unreadable speaker notes:', err)
    }
    this.value = sanitizeNotesSettings(raw, this.taken())
    return this.value
  }

  /** A copy of the current settings. */
  get(): NotesSettings {
    // Sanitised again: a recording hotkey set meanwhile takes the place of a notes hotkey.
    return sanitizeNotesSettings(this.load(), this.taken())
  }

  /** Applies a patch (validated by applyNotesPatch), saves it (unless held) and returns the result. Throws when it cannot be saved. */
  update(patch: unknown): NotesSettings {
    const current = this.load()
    const next = applyNotesPatch(current, patch, this.taken())
    if (same(current, next)) return this.get()
    if (this.held) {
      this.dirty = true
    } else {
      this.write(next)
    }
    this.value = next
    return this.get()
  }

  /** From now on keep changes in memory only (a recording started). */
  hold(): void {
    this.held = true
  }

  /** Writes what changed while held, once; never throws (a failure is logged). */
  release(): void {
    this.held = false
    if (!this.dirty || !this.value) return
    this.dirty = false
    try {
      this.write(this.value)
    } catch (err) {
      console.warn('Could not save the speaker notes:', err)
    }
  }

  private write(settings: NotesSettings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileAtomicSync(this.file, JSON.stringify({ version: NOTES_FILE_VERSION, ...settings }, null, 2), { attempts: 4 })
  }
}

/** The recording hotkeys now, which the notes hotkeys must leave alone. */
function recordingHotkeys(): string[] {
  try {
    return Object.values(appSettings().recording.hotkeys).filter((a) => !!a)
  } catch (err) {
    console.warn('Could not read the recording hotkeys:', err)
    return []
  }
}

let store: NotesStore | null = null

/** The app's notes store (userData/notes.json). */
export function notesStore(): NotesStore {
  store ??= new NotesStore(path.join(app.getPath('userData'), NOTES_FILE), recordingHotkeys)
  return store
}
