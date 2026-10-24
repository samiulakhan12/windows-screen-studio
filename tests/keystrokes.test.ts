import { describe, expect, it } from 'vitest'
import { KeystrokeFilter, shortcutLabel, type KeyInput } from '../src/main/recording/keystrokes'

const K = { A: 30, S: 31, C: 46, E: 18, Two: 3, Space: 57, Enter: 28, Esc: 1, Tab: 15, Backspace: 14, Delete: 3667, Left: 57419, F5: 63, F12: 88, PageDown: 3665, Ctrl: 29, Shift: 42, AltGr: 3640, Meta: 3675 }
const key = (keycode: number, mods: Partial<Omit<KeyInput, 'keycode'>> = {}): KeyInput => ({
  keycode,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('shortcutLabel', () => {
  it('labels combinations with Ctrl, Alt or Win in a fixed order', () => {
    expect(shortcutLabel(key(K.S, { ctrlKey: true, shiftKey: true }))).toBe('Ctrl + Shift + S')
    expect(shortcutLabel(key(K.C, { ctrlKey: true }))).toBe('Ctrl + C')
    expect(shortcutLabel(key(K.Tab, { altKey: true }))).toBe('Alt + Tab')
    expect(shortcutLabel(key(K.E, { metaKey: true }))).toBe('Win + E')
    expect(shortcutLabel(key(K.Two, { ctrlKey: true, altKey: true, shiftKey: true }))).toBe('Ctrl + Alt + Shift + 2')
  })

  it('never records plain typing, including Shift + letter', () => {
    expect(shortcutLabel(key(K.A))).toBeNull()
    expect(shortcutLabel(key(K.A, { shiftKey: true }))).toBeNull()
    expect(shortcutLabel(key(K.Two, { shiftKey: true }))).toBeNull()
    expect(shortcutLabel(key(K.Space))).toBeNull()
    expect(shortcutLabel(key(K.Space, { shiftKey: true }))).toBeNull()
  })

  it('records special keys on their own', () => {
    expect(shortcutLabel(key(K.Enter))).toBe('Enter')
    expect(shortcutLabel(key(K.Esc))).toBe('Esc')
    expect(shortcutLabel(key(K.Tab))).toBe('Tab')
    expect(shortcutLabel(key(K.Backspace))).toBe('Backspace')
    expect(shortcutLabel(key(K.Delete))).toBe('Delete')
    expect(shortcutLabel(key(K.Left))).toBe('←')
    expect(shortcutLabel(key(K.F5))).toBe('F5')
    expect(shortcutLabel(key(K.F12))).toBe('F12')
    expect(shortcutLabel(key(K.PageDown))).toBe('Page Down')
    expect(shortcutLabel(key(K.Tab, { shiftKey: true }))).toBe('Shift + Tab')
  })

  it('records Space only with a command modifier', () => {
    expect(shortcutLabel(key(K.Space, { ctrlKey: true }))).toBe('Ctrl + Space')
  })

  it('ignores modifier keys pressed on their own and unknown keys', () => {
    expect(shortcutLabel(key(K.Ctrl, { ctrlKey: true }))).toBeNull()
    expect(shortcutLabel(key(K.Shift, { shiftKey: true }))).toBeNull()
    expect(shortcutLabel(key(K.Meta, { metaKey: true }))).toBeNull()
    expect(shortcutLabel(key(99999, { ctrlKey: true }))).toBeNull()
  })

  it('treats AltGr characters as typing', () => {
    // AltGr+Q types "@" on a German layout; Windows reports it as Ctrl+Alt.
    expect(shortcutLabel(key(16, { ctrlKey: true, altKey: true }), true)).toBeNull()
    expect(shortcutLabel(key(K.Enter, { ctrlKey: true, altKey: true }), true)).toBe('Enter')
  })
})

describe('KeystrokeFilter', () => {
  it('emits one label per physical press despite auto-repeat', () => {
    const f = new KeystrokeFilter()
    const ctrlS = key(K.S, { ctrlKey: true })
    expect(f.keydown(key(K.Ctrl, { ctrlKey: true }))).toBeNull()
    expect(f.keydown(ctrlS)).toBe('Ctrl + S')
    expect(f.keydown(ctrlS)).toBeNull()
    f.keyup(ctrlS)
    expect(f.keydown(ctrlS)).toBe('Ctrl + S')
  })

  it('detects AltGr as Windows reports it: Right Alt with a fake left Ctrl at the same instant', () => {
    const f = new KeystrokeFilter()
    f.keydown(key(K.Ctrl, { ctrlKey: true }), 1000)
    f.keydown(key(K.AltGr, { ctrlKey: true, altKey: true }), 1000)
    expect(f.keydown(key(16, { ctrlKey: true, altKey: true }), 1100)).toBeNull()
    expect(f.keydown(key(K.Enter, { ctrlKey: true, altKey: true }), 1200)).toBe('Enter')
    f.keyup(key(K.AltGr))
    f.keyup(key(K.Ctrl))
    f.keyup(key(16))
    expect(f.keydown(key(K.Ctrl, { ctrlKey: true }), 2000)).toBeNull()
    expect(f.keydown(key(16, { ctrlKey: true, altKey: true }), 2100)).toBe('Ctrl + Alt + Q')
  })

  it('treats Right Alt as Alt on layouts without AltGr (windows-8)', () => {
    const f = new KeystrokeFilter()
    f.keydown(key(K.AltGr, { altKey: true }), 1000)
    expect(f.keydown(key(62, { altKey: true }), 1050)).toBe('Alt + F4')
    f.keyup(key(62))
    expect(f.keydown(key(K.Tab, { altKey: true }), 1200)).toBe('Alt + Tab')
    f.keyup(key(K.Tab))
    expect(f.keydown(key(32, { altKey: true }), 1300)).toBe('Alt + D')
  })

  it('keeps a deliberate Ctrl + Right Alt shortcut on US layouts', () => {
    const f = new KeystrokeFilter()
    f.keydown(key(K.Ctrl, { ctrlKey: true }), 1000)
    f.keydown(key(K.AltGr, { ctrlKey: true, altKey: true }), 1400)
    expect(f.keydown(key(K.Delete, { ctrlKey: true, altKey: true }), 1500)).toBe('Ctrl + Alt + Delete')
  })

  it('shows a key again when its keyup was missed (windows-7)', () => {
    const f = new KeystrokeFilter()
    // Win+L: the L keyup happens on the secure desktop and never reaches the hook.
    expect(f.keydown(key(38, { metaKey: true }), 1000)).toBe('Win + L')
    expect(f.keydown(key(38, { metaKey: true }), 1030)).toBeNull() // auto-repeat
    expect(f.keydown(key(38, { metaKey: true }), 5000)).toBe('Win + L') // a new press, much later
  })

  it('releases a key whose keyup was missed when another key is pressed', () => {
    const f = new KeystrokeFilter()
    expect(f.keydown(key(K.Delete), 1000)).toBe('Delete')
    expect(f.keydown(key(K.Enter), 1100)).toBe('Enter')
    expect(f.keydown(key(K.Delete), 1200)).toBe('Delete')
  })

  it('drops a held modifier once the event flags say it is up', () => {
    const f = new KeystrokeFilter()
    f.keydown(key(K.Ctrl, { ctrlKey: true }), 1000)
    f.keydown(key(K.AltGr, { ctrlKey: true, altKey: true }), 1000)
    // Both keyups were missed (Ctrl+Alt+Del): later events have neither flag.
    expect(f.keydown(key(K.Enter), 4000)).toBe('Enter')
    // A new Right Alt alone is Alt again, not a stale AltGr.
    f.keydown(key(K.AltGr, { altKey: true }), 4100)
    expect(f.keydown(key(K.Tab, { altKey: true }), 4200)).toBe('Alt + Tab')
  })

  it('reset() forgets held keys (pause)', () => {
    const f = new KeystrokeFilter()
    expect(f.keydown(key(K.S, { ctrlKey: true }), 1000)).toBe('Ctrl + S')
    f.reset()
    expect(f.keydown(key(K.S, { ctrlKey: true }), 1010)).toBe('Ctrl + S')
  })

  it('drops ignored labels (the app stop shortcut)', () => {
    const f = new KeystrokeFilter(new Set(['Ctrl + Shift + 2']))
    expect(f.keydown(key(K.Two, { ctrlKey: true, shiftKey: true }))).toBeNull()
  })
})
