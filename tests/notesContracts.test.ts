import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOTES_CHANNELS } from '../src/shared/api/notes'
import { migrateProject } from '../src/shared/engine/project'
import {
  applyNotesPatch,
  cleanNotesText,
  DEFAULT_NOTES,
  defaultNotes,
  hasNotesText,
  NOTES_FONT,
  NOTES_HEIGHT,
  NOTES_TEXT_MAX,
  NOTES_WIDTH,
  NOTES_WPM,
  readProjectScript,
  sanitizeLookPatch,
  sanitizeNotesSettings,
  sanitizePlacement
} from '../src/shared/notes/notes'
import {
  anyHotkeyName,
  DEFAULT_HOTKEYS,
  DEFAULT_NOTES_HOTKEYS,
  HOTKEY_ACTIONS,
  isAnyHotkeyAction,
  isNotesHotkeyAction,
  NOTES_HOTKEY_ACTIONS,
  sanitizeHotkeys,
  sanitizeNotesHotkeys,
  validateHotkey
} from '../src/shared/recording/hotkeys'

const RECORDING_KEYS = Object.values(DEFAULT_HOTKEYS)

describe('notes hotkeys sit beside the recording hotkeys without changing them', () => {
  it('the recording hotkeys are exactly as before', () => {
    expect(HOTKEY_ACTIONS).toEqual(['stop', 'pause', 'mark'])
    expect(sanitizeHotkeys(undefined)).toEqual(DEFAULT_HOTKEYS)
    expect(Object.keys(sanitizeHotkeys({ stop: 'Ctrl+Shift+F7' }))).toEqual(['stop', 'pause', 'mark'])
  })

  it('the notes defaults are valid and distinct from each other and from the recording defaults', () => {
    const all = [...RECORDING_KEYS, ...Object.values(DEFAULT_NOTES_HOTKEYS)]
    expect(new Set(all).size).toBe(all.length)
    for (const a of Object.values(DEFAULT_NOTES_HOTKEYS)) expect(validateHotkey(a)).toEqual({ ok: true, accelerator: a })
    expect(sanitizeNotesHotkeys(undefined, RECORDING_KEYS)).toEqual(DEFAULT_NOTES_HOTKEYS)
  })

  it('keeps "no hotkey", normalises valid ones and replaces invalid ones with the default', () => {
    expect(sanitizeNotesHotkeys({ notesToggle: '', notesBack: 'ctrl+alt+b', notesForward: 'A' })).toEqual({
      notesToggle: '',
      notesBack: 'Ctrl+Alt+B',
      notesForward: 'Ctrl+Shift+F8'
    })
  })

  it('a recording hotkey wins a clash: the notes action gets its default, or none when that is taken too', () => {
    expect(sanitizeNotesHotkeys({ notesToggle: 'Ctrl+Shift+2' }, RECORDING_KEYS).notesToggle).toBe('Ctrl+Shift+F7')
    expect(sanitizeNotesHotkeys({}, ['Ctrl+Shift+F7']).notesToggle).toBe('')
    expect(sanitizeNotesHotkeys({ notesBack: 'Ctrl+Shift+F8' }, []).notesForward).toBe('')
  })

  it('names and recognises every action', () => {
    expect(NOTES_HOTKEY_ACTIONS.every(isNotesHotkeyAction)).toBe(true)
    expect(isNotesHotkeyAction('stop')).toBe(false)
    expect([...HOTKEY_ACTIONS, ...NOTES_HOTKEY_ACTIONS].every(isAnyHotkeyAction)).toBe(true)
    expect(isAnyHotkeyAction('notesFaster')).toBe(false)
    expect(anyHotkeyName('notesBack')).toBe('Notes: back')
    expect(anyHotkeyName('pause')).toBe('Pause / resume')
  })
})

describe('the notes settings are valid whatever the file holds', () => {
  it('defaults for anything that is not an object', () => {
    for (const raw of [undefined, null, 7, 'x', []]) expect(sanitizeNotesSettings(raw)).toEqual(DEFAULT_NOTES)
    expect(defaultNotes()).toEqual(DEFAULT_NOTES)
    expect(defaultNotes().hotkeys).not.toBe(DEFAULT_NOTES.hotkeys)
  })

  it('clamps and steps the numbers', () => {
    const s = sanitizeNotesSettings({ wpm: 500, fontSize: 8, width: 99999, height: 3 })
    expect([s.wpm, s.fontSize, s.width, s.height]).toEqual([NOTES_WPM.max, NOTES_FONT.min, NOTES_WIDTH.max, NOTES_HEIGHT.min])
    expect(sanitizeNotesSettings({ wpm: 143, fontSize: 33.2 })).toMatchObject({ wpm: 140, fontSize: 34 })
    expect(sanitizeNotesSettings({ wpm: 'fast', width: Number.NaN })).toMatchObject({ wpm: NOTES_WPM.default, width: NOTES_WIDTH.default })
    expect(sanitizeNotesSettings({ autoStart: 'yes', showWhileRecording: false })).toMatchObject({ autoStart: true, showWhileRecording: false })
  })

  it('cleans the text: line ends, control characters, length', () => {
    expect(cleanNotesText('a\u0000b\r\nc\rd\te\u007f')).toBe('ab\nc\nd\te')
    expect(cleanNotesText(42)).toBe('')
    expect(cleanNotesText('x'.repeat(NOTES_TEXT_MAX + 10))).toHaveLength(NOTES_TEXT_MAX)
    // Never half an emoji at the cut.
    const cut = cleanNotesText('x'.repeat(NOTES_TEXT_MAX - 1) + '😀')
    expect(cut).toHaveLength(NOTES_TEXT_MAX - 1)
    expect(hasNotesText(' \n\t ')).toBe(false)
    expect(hasNotesText('[smile] hi')).toBe(true)
  })

  it('keeps a valid placement, else the default place', () => {
    expect(sanitizePlacement({ displayId: '2', x: 0.5, y: 0 })).toEqual({ displayId: '2', x: 0.5, y: 0 })
    expect(sanitizePlacement({ displayId: '2', x: 2, y: 0 })).toBeNull()
    expect(sanitizePlacement({ displayId: 3, x: 0, y: 0 })).toBeNull()
    expect(sanitizePlacement({ displayId: '', x: 0, y: 0 })).toBeNull()
    expect(sanitizeNotesSettings({ placement: { displayId: '1', x: 0.25, y: 0.75, extra: true } }).placement).toEqual({ displayId: '1', x: 0.25, y: 0.75 })
  })

  it('applies a patch: other fields kept, hotkeys one at a time, placement null resets', () => {
    const cur = sanitizeNotesSettings({ text: 'Hello', wpm: 150, placement: { displayId: '1', x: 0, y: 0 } })
    const next = applyNotesPatch(cur, { fontSize: 40, hotkeys: { notesBack: '' }, placement: null })
    expect(next).toMatchObject({ text: 'Hello', wpm: 150, fontSize: 40, placement: null })
    expect(next.hotkeys).toEqual({ ...DEFAULT_NOTES_HOTKEYS, notesBack: '' })
    expect(applyNotesPatch(cur, 'nonsense')).toEqual(cur)
    // The recording hotkeys win, also in a patch.
    expect(applyNotesPatch(cur, { hotkeys: { notesToggle: 'Ctrl+Shift+2' } }, RECORDING_KEYS).hotkeys.notesToggle).toBe('Ctrl+Shift+F7')
  })

  it('the notes window may change only its speed, text size and size', () => {
    expect(sanitizeLookPatch({ wpm: 150, fontSize: 30, width: 600, height: 300, text: 'x', placement: null, autoStart: false })).toEqual({
      wpm: 150,
      fontSize: 30,
      width: 600,
      height: 300
    })
    expect(sanitizeLookPatch({ wpm: Number.POSITIVE_INFINITY, fontSize: '30' })).toEqual({})
    expect(sanitizeLookPatch(null)).toEqual({})
  })
})

describe('the script kept with a recording', () => {
  const base = { id: 'p1', name: 'P', createdAt: '2026-10-26T00:00:00.000Z', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: false }

  it('older projects have none', () => {
    expect('script' in migrateProject(base)).toBe(false)
  })

  it('a valid one is kept, cleaned; a malformed or empty one is dropped', () => {
    expect(migrateProject({ ...base, script: { text: 'Hi\r\nthere' } }).script).toEqual({ text: 'Hi\nthere' })
    expect('script' in migrateProject({ ...base, script: 'plain string' })).toBe(false)
    expect('script' in migrateProject({ ...base, script: { text: 42 } })).toBe(false)
    expect('script' in migrateProject({ ...base, script: { text: '   ' } })).toBe(false)
    expect(readProjectScript({ text: 'x'.repeat(NOTES_TEXT_MAX + 5) })?.text).toHaveLength(NOTES_TEXT_MAX)
  })
})

describe('IPC channel names', () => {
  it('are distinct and namespaced', () => {
    const names = Object.values(NOTES_CHANNELS)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n).toMatch(/^notes:[a-zA-Z]+$/)
  })

  it('the preload uses exactly these names', () => {
    const preload = fs.readFileSync(path.join(__dirname, '../src/preload/notes.ts'), 'utf8')
    const used = [...preload.matchAll(/'(notes:[a-zA-Z]+)'/g)].map((m) => m[1]).sort()
    expect(used).toEqual(Object.values(NOTES_CHANNELS).sort())
  })
})
