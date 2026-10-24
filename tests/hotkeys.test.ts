import { describe, expect, it } from 'vitest'
import {
  comboFromKeyEvent,
  DEFAULT_HOTKEYS,
  hotkeyConflicts,
  hotkeyLabel,
  normalizeHotkey,
  parseHotkey,
  sanitizeHotkeys,
  validateHotkey
} from '../src/shared/recording/hotkeys'
import { shortcutLabel } from '../src/main/recording/keystrokes'

const ev = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('parseHotkey / normalizeHotkey', () => {
  it('reads Electron accelerators with aliases, in any case and order of modifiers', () => {
    expect(normalizeHotkey('CommandOrControl+Shift+2')).toBe('Ctrl+Shift+2')
    expect(normalizeHotkey('shift+ctrl+p')).toBe('Ctrl+Shift+P')
    expect(normalizeHotkey('Super+Alt+f9')).toBe('Alt+Super+F9')
    expect(normalizeHotkey('Ctrl+Return')).toBe('Ctrl+Enter')
    expect(normalizeHotkey('Alt+Esc')).toBe('Alt+Escape')
    expect(normalizeHotkey('Ctrl+num5')).toBe('Ctrl+num5')
    expect(normalizeHotkey('Ctrl+Up')).toBe('Ctrl+Up')
    expect(normalizeHotkey('Ctrl+/')).toBe('Ctrl+/')
  })

  it('rejects malformed accelerators', () => {
    for (const bad of ['', '   ', 'Ctrl+', '+A', 'Ctrl++', 'Ctrl+Shift', 'A+B', 'Ctrl+Bogus', 'Shift+A+Ctrl', 42, null, undefined, 'x'.repeat(80)]) {
      expect(normalizeHotkey(bad), String(bad)).toBeNull()
    }
    expect(parseHotkey('Ctrl+Shift')).toEqual({ modifiers: ['Ctrl', 'Shift'], key: null })
    expect(parseHotkey('Shift+A+Ctrl')).toBeNull()
  })
})

describe('hotkeyLabel', () => {
  it('matches what the keystroke overlay records, so the app never records its own hotkeys', () => {
    // Keycodes are libuiohook's (see keystrokes.ts).
    const cases: [string, Parameters<typeof shortcutLabel>[0]][] = [
      ['Ctrl+Shift+2', { keycode: 3, ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }],
      ['Ctrl+Shift+P', { keycode: 25, ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }],
      ['Ctrl+Shift+Z', { keycode: 44, ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }],
      ['Alt+Super+F9', { keycode: 67, ctrlKey: false, altKey: true, shiftKey: false, metaKey: true }],
      ['Ctrl+Alt+PageDown', { keycode: 3665, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }],
      ['Ctrl+Up', { keycode: 57416, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }],
      ['Ctrl+Space', { keycode: 57, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }],
      ['Ctrl+num7', { keycode: 71, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }]
    ]
    for (const [accel, key] of cases) expect(hotkeyLabel(accel), accel).toBe(shortcutLabel(key))
  })

  it('returns malformed or empty values as they are', () => {
    expect(hotkeyLabel('')).toBe('')
    expect(hotkeyLabel('Ctrl+Bogus')).toBe('Ctrl+Bogus')
  })
})

describe('validateHotkey', () => {
  it('accepts the defaults and other command combos', () => {
    for (const a of Object.values(DEFAULT_HOTKEYS)) expect(validateHotkey(a)).toEqual({ ok: true, accelerator: a })
    expect(validateHotkey('alt+shift+r')).toEqual({ ok: true, accelerator: 'Alt+Shift+R' })
    expect(validateHotkey('F9')).toEqual({ ok: true, accelerator: 'F9' })
    expect(validateHotkey('Shift+F10')).toEqual({ ok: true, accelerator: 'Shift+F10' })
  })

  it('refuses keys that would fire while typing', () => {
    for (const a of ['A', 'Shift+A', '2', 'Space', 'Shift+Enter', 'Escape']) {
      const r = validateHotkey(a)
      expect(r.ok, a).toBe(false)
      if (!r.ok) expect(r.message).toMatch(/add Ctrl, Alt or Win/)
    }
  })

  it('refuses shortcuts reserved by Windows and those every app uses', () => {
    expect(validateHotkey('Alt+F4')).toEqual({ ok: false, message: 'Alt + F4 is reserved by Windows.' })
    expect(validateHotkey('Win+L')).toEqual({ ok: false, message: 'Win + L is reserved by Windows.' })
    expect(validateHotkey('Ctrl+Alt+Delete')).toMatchObject({ ok: false })
    const copy = validateHotkey('CmdOrCtrl+C')
    expect(copy.ok).toBe(false)
    if (!copy.ok) expect(copy.message).toBe('Ctrl + C is Copy in most apps; it would stop working there while you record.')
  })

  it('needs a key and a well-formed accelerator', () => {
    expect(validateHotkey('Ctrl+Shift')).toMatchObject({ ok: false, message: expect.stringMatching(/Add a key/) })
    expect(validateHotkey('Ctrl+?!')).toMatchObject({ ok: false })
  })
})

describe('hotkeyConflicts', () => {
  it('flags an action whose hotkey an earlier action already has', () => {
    expect(hotkeyConflicts(DEFAULT_HOTKEYS)).toEqual({})
    expect(hotkeyConflicts({ stop: 'Ctrl+Shift+2', pause: 'CommandOrControl+shift+2', mark: 'Ctrl+Shift+2' })).toEqual({
      pause: 'Already used for Stop.',
      mark: 'Already used for Stop.'
    })
    expect(hotkeyConflicts({ stop: '', pause: '', mark: 'Ctrl+M' })).toEqual({})
  })
})

describe('sanitizeHotkeys', () => {
  it('keeps valid distinct hotkeys and "no hotkey"', () => {
    expect(sanitizeHotkeys({ stop: 'ctrl+alt+s', pause: '', mark: 'F8' })).toEqual({ stop: 'Ctrl+Alt+S', pause: '', mark: 'F8' })
  })

  it('falls back to defaults for invalid values, duplicates and garbage', () => {
    expect(sanitizeHotkeys(undefined)).toEqual(DEFAULT_HOTKEYS)
    expect(sanitizeHotkeys({ stop: 'Ctrl+C', pause: 7, mark: 'A' })).toEqual(DEFAULT_HOTKEYS)
    expect(sanitizeHotkeys({ stop: 'Ctrl+Shift+Z', pause: 'Ctrl+Shift+Z' })).toEqual({ stop: 'Ctrl+Shift+Z', pause: 'Ctrl+Shift+P', mark: '' })
  })
})

describe('comboFromKeyEvent', () => {
  it('shows the modifiers held so far, then the full combo (layout independent codes)', () => {
    expect(comboFromKeyEvent(ev('ControlLeft', { ctrlKey: true }))).toEqual({ accelerator: null, label: 'Ctrl + …' })
    expect(comboFromKeyEvent(ev('ShiftRight', { ctrlKey: true, shiftKey: true }))).toEqual({ accelerator: null, label: 'Ctrl + Shift + …' })
    expect(comboFromKeyEvent(ev('KeyZ', { ctrlKey: true, shiftKey: true }))).toEqual({ accelerator: 'Ctrl+Shift+Z', label: 'Ctrl + Shift + Z' })
    expect(comboFromKeyEvent(ev('Digit2', { ctrlKey: true, shiftKey: true }))).toEqual({ accelerator: 'Ctrl+Shift+2', label: 'Ctrl + Shift + 2' })
    expect(comboFromKeyEvent(ev('ArrowLeft', { metaKey: true, altKey: true }))).toEqual({ accelerator: 'Alt+Super+Left', label: 'Alt + Win + ←' })
    expect(comboFromKeyEvent(ev('F5'))).toEqual({ accelerator: 'F5', label: 'F5' })
    expect(comboFromKeyEvent(ev('IntlBackslash', { ctrlKey: true }))).toEqual({ accelerator: null, label: 'Ctrl + …' })
    expect(comboFromKeyEvent(ev('Unidentified'))).toEqual({ accelerator: null, label: '' })
  })

  it('produces accelerators that validate and label consistently', () => {
    const c = comboFromKeyEvent(ev('PageUp', { ctrlKey: true, altKey: true }))
    expect(c.accelerator).toBe('Ctrl+Alt+PageUp')
    expect(validateHotkey(c.accelerator)).toEqual({ ok: true, accelerator: 'Ctrl+Alt+PageUp' })
    expect(hotkeyLabel(c.accelerator!)).toBe(c.label)
  })
})
