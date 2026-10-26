import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import { NOTES_FILE, NotesStore } from '../src/main/notes/notesStore'
import { defaultNotes } from '../src/shared/notes/notes'
import { DEFAULT_NOTES_HOTKEYS } from '../src/shared/recording/hotkeys'

const dirs: string[] = []
function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-notes-'))
  dirs.push(dir)
  return path.join(dir, NOTES_FILE)
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('NotesStore', () => {
  it('a missing file means the defaults', () => {
    expect(new NotesStore(tempFile()).get()).toEqual(defaultNotes())
  })

  it('a malformed file means the defaults, with a warning', () => {
    const file = tempFile()
    fs.writeFileSync(file, '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(new NotesStore(file).get()).toEqual(defaultNotes())
    expect(warn).toHaveBeenCalled()
  })

  it('malformed fields fall back one by one', () => {
    const file = tempFile()
    fs.writeFileSync(file, JSON.stringify({ version: 1, text: 'Hello', wpm: 'fast', fontSize: 41 }))
    expect(new NotesStore(file).get()).toMatchObject({ text: 'Hello', wpm: 130, fontSize: 42 })
  })

  it('update saves at once and round-trips through a new store', () => {
    const file = tempFile()
    const store = new NotesStore(file)
    const next = store.update({ text: 'Line one\r\nLine two', wpm: 150, placement: { displayId: '1', x: 0.25, y: 0 } })
    expect(next).toMatchObject({ text: 'Line one\nLine two', wpm: 150 })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 1, text: 'Line one\nLine two' })
    expect(new NotesStore(file).get()).toEqual(next)
  })

  it('a notes hotkey never equals a recording hotkey (read on every sanitise)', () => {
    const file = tempFile()
    let taken = ['Ctrl+Shift+2']
    const store = new NotesStore(file, () => taken)
    expect(store.update({ hotkeys: { notesBack: 'Ctrl+Shift+2' } }).hotkeys.notesBack).toBe(DEFAULT_NOTES_HOTKEYS.notesBack)
    // A recording hotkey set meanwhile wins over the saved notes hotkey.
    taken = [DEFAULT_NOTES_HOTKEYS.notesToggle]
    expect(store.get().hotkeys.notesToggle).toBe('')
  })

  it('a change that saves nothing new writes nothing', () => {
    const file = tempFile()
    const store = new NotesStore(file)
    store.update({ wpm: 150 })
    const rename = vi.spyOn(fs, 'renameSync')
    store.update({ wpm: 150 })
    expect(rename).not.toHaveBeenCalled()
  })

  it('held: changes stay in memory until release() writes them once', () => {
    const file = tempFile()
    const store = new NotesStore(file)
    store.hold()
    const rename = vi.spyOn(fs, 'renameSync')
    expect(store.update({ wpm: 170 }).wpm).toBe(170)
    expect(store.update({ fontSize: 40 }).fontSize).toBe(40)
    expect(store.get()).toMatchObject({ wpm: 170, fontSize: 40 })
    expect(fs.existsSync(file)).toBe(false)
    expect(rename).not.toHaveBeenCalled()
    store.release()
    expect(rename).toHaveBeenCalledTimes(1)
    expect(new NotesStore(file).get()).toMatchObject({ wpm: 170, fontSize: 40 })
    // Released: the next change is written at once again.
    store.update({ wpm: 180 })
    expect(rename).toHaveBeenCalledTimes(2)
  })

  it('release() without changes writes nothing', () => {
    const file = tempFile()
    const store = new NotesStore(file)
    store.hold()
    const rename = vi.spyOn(fs, 'renameSync')
    store.release()
    expect(rename).not.toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a failed write: update throws, release only logs it', () => {
    const dir = path.dirname(tempFile())
    // A file where the folder should be: every write fails.
    fs.writeFileSync(path.join(dir, 'blocker'), '')
    const file = path.join(dir, 'blocker', NOTES_FILE)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new NotesStore(file)
    expect(() => store.update({ wpm: 150 })).toThrow()
    // Unchanged after the failed write.
    expect(store.get().wpm).toBe(130)
    store.hold()
    store.update({ wpm: 160 })
    warn.mockClear()
    expect(() => store.release()).not.toThrow()
    expect(warn).toHaveBeenCalledWith('Could not save the speaker notes:', expect.anything())
  })
})
