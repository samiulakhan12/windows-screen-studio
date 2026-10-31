/**
 * Saved caption looks (prefs `captionPresets`, docs/design/captions-studio.md §5.7): shared by
 * every project and every component of the window; saving or deleting one is not a project change
 * (a project that uses a deleted look keeps its copy). One list per window, read once, written
 * through the main process (which reads it again with readSavedLooks); writes go one at a time.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { cleanPrefText, MAX_SAVED_LOOKS, readSavedLooks, SAVED_LOOK_NAME_MAX } from '../../../shared/captions/captionPrefs'
import type { SavedLook } from '../../../shared/captions/studioPresets'
import type { CaptionStudio } from '../../../shared/types'

/** Shown when a 51st look is saved (§2.4). */
export const SAVED_LOOKS_FULL = `You have ${MAX_SAVED_LOOKS} saved styles. Delete one first.`

let looks: readonly SavedLook[] = []
let state: 'unread' | 'reading' | 'read' = 'unread'
const listeners = new Set<() => void>()
/** The last write: the next one starts after it. */
let writing: Promise<void> = Promise.resolve()

function publish(next: readonly SavedLook[]): void {
  looks = next
  for (const l of listeners) l()
}

function read(): void {
  if (state !== 'unread') return
  state = 'reading'
  window.api
    .getPref('captionPresets')
    .then((raw) => {
      state = 'read'
      publish(readSavedLooks(raw))
    })
    .catch((err: unknown) => {
      state = 'read'
      console.warn('The saved caption styles could not be read:', err)
    })
}

/** Writes `next` (after any write under way); the list shown is `next` from now on, or the one before when the write fails. */
function write(next: readonly SavedLook[]): Promise<void> {
  const before = looks
  publish(next)
  const run = writing.then(() => window.api.setPref('captionPresets', next))
  writing = run.catch(() => undefined)
  return run.catch((err: unknown) => {
    if (looks === next) publish(before)
    throw err
  })
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const snapshot = (): readonly SavedLook[] => looks

/** A new id for a saved look: 8 letters and digits, not in use. */
function newLookId(taken: readonly SavedLook[]): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10).padEnd(8, '0')
    if (!taken.some((s) => s.id === id)) return id
  }
}

/** The first unused "My style n" name, for the Save field's default (§2.4). */
export function nextLookName(saved: readonly SavedLook[]): string {
  for (let n = 1; ; n++) {
    const name = `My style ${n}`
    if (!saved.some((s) => s.name === name)) return name
  }
}

/** Saves `look` as `name`; rejects with SAVED_LOOKS_FULL at the limit. Resolves with the saved entry. */
export async function saveLook(name: string, look: CaptionStudio): Promise<SavedLook> {
  if (looks.length >= MAX_SAVED_LOOKS) throw new Error(SAVED_LOOKS_FULL)
  const id = newLookId(looks)
  const entry: SavedLook = { id, name: cleanPrefText(name, SAVED_LOOK_NAME_MAX) || nextLookName(looks), look: { ...look, from: `mine:${id}` } }
  await write([...looks, entry])
  return entry
}

/** Deletes saved look `id` (nothing when it is gone). */
export async function removeLook(id: string): Promise<void> {
  if (!looks.some((s) => s.id === id)) return
  await write(looks.filter((s) => s.id !== id))
}

/** Puts a deleted look back where it was (the Delete notice's Undo), with its id, so projects that use it read as unedited again. */
export async function restoreLook(entry: SavedLook, at: number): Promise<void> {
  if (looks.some((s) => s.id === entry.id) || looks.length >= MAX_SAVED_LOOKS) return
  const next = [...looks]
  next.splice(Math.max(0, Math.min(at, next.length)), 0, entry)
  await write(next)
}

/** The saved looks, read first when this window has not read them yet. */
export async function loadSavedLooks(): Promise<readonly SavedLook[]> {
  if (state !== 'read') {
    try {
      const raw = await window.api.getPref('captionPresets')
      // Another read may have finished while this one waited.
      if ((state as string) !== 'read') {
        state = 'read'
        publish(readSavedLooks(raw))
      }
    } catch (err) {
      console.warn('The saved caption styles could not be read:', err)
    }
  }
  return looks
}

export function useSavedLooks(): { looks: readonly SavedLook[]; save(name: string, look: CaptionStudio): Promise<void>; remove(id: string): Promise<void> } {
  const list = useSyncExternalStore(subscribe, snapshot)
  useEffect(read, [])
  return {
    looks: list,
    save: async (name, look) => void (await saveLook(name, look)),
    remove: removeLook
  }
}

/** Forgets the list read (tests). */
export function resetSavedLooksForTest(): void {
  looks = []
  state = 'unread'
  writing = Promise.resolve()
  listeners.clear()
}
