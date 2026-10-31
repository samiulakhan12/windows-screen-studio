import { describe, expect, it } from 'vitest'
import { listKey } from '../src/shared/review/keys'
import type { KeyInput } from '../src/shared/editor/shortcuts'

const press = (key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
const action = (e: KeyInput): string | null => listKey(e)?.action ?? null

describe('review list keys', () => {
  it('moves, keeps and removes with the documented keys', () => {
    expect(action(press('ArrowDown', 'ArrowDown'))).toBe('next')
    expect(action(press('n', 'KeyN'))).toBe('next')
    expect(action(press('ArrowUp', 'ArrowUp'))).toBe('previous')
    expect(action(press('p', 'KeyP'))).toBe('previous')
    expect(action(press('Home', 'Home'))).toBe('first')
    expect(action(press('End', 'End'))).toBe('last')
    expect(action(press('k', 'KeyK'))).toBe('keep')
    expect(action(press('Delete', 'Delete'))).toBe('remove')
    expect(action(press('Backspace', 'Backspace'))).toBe('remove')
    // Caps Lock: the capital letter without Shift.
    expect(action(press('N', 'KeyN'))).toBe('next')
    expect(action(press('K', 'KeyK'))).toBe('keep')
  })

  it('only the arrows, Home and End act again while held', () => {
    expect(listKey(press('ArrowDown', 'ArrowDown'))?.again).toBe(true)
    expect(listKey(press('ArrowUp', 'ArrowUp'))?.again).toBe(true)
    expect(listKey(press('Home', 'Home'))?.again).toBe(true)
    expect(listKey(press('n', 'KeyN'))?.again).toBe(false)
    expect(listKey(press('p', 'KeyP'))?.again).toBe(false)
    expect(listKey(press('k', 'KeyK'))?.again).toBe(false)
    expect(listKey(press('Delete', 'Delete'))?.again).toBe(false)
  })

  it('the keys where N, P and K sit work on a layout of another alphabet, so they never reach the editor as Snapping or Pause', () => {
    // Russian, Greek and Bangla (Bijoy) layouts.
    expect(action(press('т', 'KeyN'))).toBe('next')
    expect(action(press('з', 'KeyP'))).toBe('previous')
    expect(action(press('л', 'KeyK'))).toBe('keep')
    expect(action(press('ν', 'KeyN'))).toBe('next')
    expect(action(press('κ', 'KeyK'))).toBe('keep')
    expect(action(press('ল', 'KeyN'))).toBe('next')
    expect(action(press('ক', 'KeyK'))).toBe('keep')
    // A Latin letter is read as typed (Dvorak's K sits where T is on QWERTY).
    expect(action(press('k', 'KeyT'))).toBe('keep')
    expect(action(press('t', 'KeyK'))).toBeNull()
  })

  it('other keys and chords go on to the editor', () => {
    expect(action(press('z', 'KeyZ', { ctrlKey: true }))).toBeNull()
    expect(action(press('n', 'KeyN', { altKey: true }))).toBeNull()
    expect(action(press('k', 'KeyK', { metaKey: true }))).toBeNull()
    expect(action(press(' ', 'Space'))).toBeNull()
    expect(action(press('Enter', 'Enter'))).toBeNull()
    expect(action(press('Escape', 'Escape'))).toBeNull()
    expect(action(press('s', 'KeyS'))).toBeNull()
    expect(action(press('Shift', 'ShiftLeft', { shiftKey: true }))).toBeNull()
  })

  it('Shift with a letter goes on to the editor (Shift+P is Polish), Shift with an arrow still moves', () => {
    expect(action(press('P', 'KeyP', { shiftKey: true }))).toBeNull()
    expect(action(press('N', 'KeyN', { shiftKey: true }))).toBeNull()
    expect(action(press('K', 'KeyK', { shiftKey: true }))).toBeNull()
    // Caps Lock and Shift together type the small letter.
    expect(action(press('p', 'KeyP', { shiftKey: true }))).toBeNull()
    expect(action(press('З', 'KeyP', { shiftKey: true }))).toBeNull()
    expect(action(press('ArrowDown', 'ArrowDown', { shiftKey: true }))).toBe('next')
    expect(action(press('Delete', 'Delete', { shiftKey: true }))).toBe('remove')
  })
})
