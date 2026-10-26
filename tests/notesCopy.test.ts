import { describe, expect, it } from 'vitest'
import { countLine, notesButtonTitles, notesStatus, notesSummary, speedShort, speedWords, withHotkey, wordsLabel } from '../src/shared/notes/notesCopy'

describe('notes copy', () => {
  it('summarises the notes', () => {
    expect(notesSummary(312, 130)).toBe('312 words · about 2 min 24 s at 130 words a minute')
    expect(countLine(312, 130)).toBe('312 words · about 2 min 24 s')
    expect(wordsLabel(1)).toBe('1 word')
    expect(wordsLabel(1204)).toBe('1,204 words')
    expect(speedWords(130)).toBe('130 words a minute')
    expect(speedShort(130)).toBe('130 wpm')
  })

  it('names every state of the window', () => {
    const r = { mode: 'record' as const, playing: false, ended: false }
    expect(notesStatus({ ...r, recording: 'countdown' })).toBe('Starts with the recording')
    expect(notesStatus({ ...r, recording: 'recording', playing: true })).toBe('Scrolling')
    expect(notesStatus({ ...r, recording: 'recording' })).toBe('Paused')
    expect(notesStatus({ ...r, recording: 'paused' })).toBe('Recording paused')
    expect(notesStatus({ ...r, recording: 'recording', ended: true })).toBe('End of notes')
    expect(notesStatus({ mode: 'rehearse', recording: null, playing: false, ended: false })).toBe('Rehearsing: not recording')
    expect(notesStatus({ mode: 'rehearse', recording: null, playing: true, ended: false })).toBe('Scrolling')
  })

  it('titles the buttons with their hotkeys', () => {
    const keys = { notesBack: 'Ctrl + Shift + F6', notesToggle: 'Ctrl + Shift + F7', notesForward: 'Ctrl + Shift + F8' }
    const t = notesButtonTitles(keys, 'record', false)
    expect(t.back).toBe('Back (Ctrl + Shift + F6)')
    expect(t.toggle).toBe('Start scrolling (Ctrl + Shift + F7)')
    expect(t.forward).toBe('Forward (Ctrl + Shift + F8)')
    expect(t.close).toBe('Hide notes (they are never recorded)')
    expect(notesButtonTitles(keys, 'rehearse', true).toggle).toBe('Pause scrolling (Ctrl + Shift + F7)')
    expect(notesButtonTitles(keys, 'rehearse', true).close).toBe('Close')
    const none = notesButtonTitles({}, 'record', false)
    expect([none.back, none.toggle, none.forward]).toEqual(['Back', 'Start scrolling', 'Forward'])
    expect([none.slower, none.faster, none.smaller, none.larger]).toEqual(['Slower', 'Faster', 'Smaller text', 'Larger text'])
    expect(withHotkey('Back', undefined)).toBe('Back')
  })
})
