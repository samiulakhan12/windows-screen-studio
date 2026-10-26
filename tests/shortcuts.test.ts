import { describe, expect, it } from 'vitest'
import { COMMAND_IDS } from '../src/shared/editor/commands'
import {
  addBinding,
  checkShortcut,
  chordFromEvent,
  commandForShortcut,
  DEFAULT_KEYMAP,
  eventKeyName,
  findConflicts,
  formatChord,
  isDefaultBinding,
  isSliderKey,
  keymapFromPrefs,
  keymapOverrides,
  matchShortcut,
  MAX_BINDINGS,
  normalizeShortcut,
  orPress,
  parseShortcut,
  partialLabel,
  removeBinding,
  reservedReason,
  resetCommand,
  resolveKeymap,
  sanitizeShortcuts,
  serializeShortcuts,
  shortcutIndex,
  shortcutKeys,
  shortcutLabel,
  takenDefaults,
  undoHint,
  withShortcut,
  zoomLevelKeysHint,
  type KeyInput,
  type Keymap
} from '../src/shared/editor/shortcuts'

/** A keydown as the browser reports it. */
const ev = (key: string, code = '', mods: Partial<Pick<KeyInput, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {}): KeyInput => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

const run = (keymap: Keymap, e: KeyInput) => {
  const chord = chordFromEvent(e)
  return chord ? matchShortcut(shortcutIndex(keymap), chord) : null
}

describe('parseShortcut / normalizeShortcut', () => {
  it('reads accelerators with aliases, in any case and modifier order', () => {
    expect(normalizeShortcut('shift+ctrl+z')).toBe('Ctrl+Shift+Z')
    expect(normalizeShortcut('CommandOrControl+K')).toBe('Ctrl+K')
    expect(normalizeShortcut('Meta+Alt+f5')).toBe('Ctrl+Alt+F5')
    expect(normalizeShortcut('arrowleft')).toBe('Left')
    expect(normalizeShortcut('Shift+ArrowRight')).toBe('Shift+Right')
    expect(normalizeShortcut('esc')).toBe('Escape')
    expect(normalizeShortcut('del')).toBe('Delete')
    expect(normalizeShortcut('space')).toBe('Space')
    expect(normalizeShortcut('Ctrl+/')).toBe('Ctrl+/')
    expect(normalizeShortcut('Ctrl+-')).toBe('Ctrl+-')
    expect(normalizeShortcut('7')).toBe('7')
  })

  it('spells the plus key "Plus" and drops Shift from symbol keys', () => {
    expect(normalizeShortcut('+')).toBe('Plus')
    expect(normalizeShortcut('Ctrl++')).toBe('Ctrl+Plus')
    expect(normalizeShortcut('Shift+Plus')).toBe('Plus')
    expect(normalizeShortcut('Shift+?')).toBe('?')
    expect(normalizeShortcut('Shift+1')).toBe('Shift+1')
    expect(parseShortcut('Ctrl+Shift+=')).toEqual({ ctrl: true, alt: false, shift: false, key: '=' })
  })

  it('rejects malformed accelerators', () => {
    for (const bad of ['', '  ', 'Ctrl+', 'Ctrl', 'Shift', 'A+B', 'Ctrl+Bogus', 'Z+Ctrl', 'é', 'Ctrl+Shift+', 42, null, undefined, {}, 'x'.repeat(50)]) {
      expect(normalizeShortcut(bad), String(bad)).toBeNull()
    }
  })

  it('formats chords canonically', () => {
    expect(formatChord({ ctrl: true, alt: true, shift: true, key: 'P' })).toBe('Ctrl+Alt+Shift+P')
    expect(formatChord({ ctrl: false, alt: false, shift: false, key: 'Space' })).toBe('Space')
  })
})

describe('labels', () => {
  it('shows keycaps with arrows and short names', () => {
    expect(shortcutKeys('Ctrl+Shift+Z')).toEqual(['Ctrl', 'Shift', 'Z'])
    expect(shortcutKeys('Shift+Left')).toEqual(['Shift', '←'])
    expect(shortcutKeys('Plus')).toEqual(['+'])
    expect(shortcutKeys('Escape')).toEqual(['Esc'])
    expect(shortcutLabel('Ctrl+Shift+P')).toBe('Ctrl + Shift + P')
    expect(shortcutLabel('PageDown')).toBe('Page Down')
    expect(shortcutKeys('nonsense+')).toEqual(['nonsense+'])
  })

  it('adds the first shortcut to a title', () => {
    expect(withShortcut('Split the clip at the playhead', ['S'])).toBe('Split the clip at the playhead (S)')
    expect(withShortcut('Redo', ['Ctrl+Shift+Z', 'Ctrl+Y'])).toBe('Redo (Ctrl + Shift + Z)')
    expect(withShortcut('Export', [])).toBe('Export')
    expect(withShortcut('Export', undefined)).toBe('Export')
  })
})

describe('key events', () => {
  it('names keys by the character they type', () => {
    expect(eventKeyName(ev('s', 'KeyS'))).toBe('S')
    expect(eventKeyName(ev('S', 'KeyS'))).toBe('S')
    // AZERTY: the key in the Z position of a US keyboard types "w".
    expect(eventKeyName(ev('w', 'KeyZ'))).toBe('W')
    expect(eventKeyName(ev(' ', 'Space'))).toBe('Space')
    expect(eventKeyName(ev('ArrowLeft', 'ArrowLeft'))).toBe('Left')
    expect(eventKeyName(ev('+', 'Equal'))).toBe('Plus')
    expect(eventKeyName(ev('+', 'NumpadAdd'))).toBe('Plus')
    expect(eventKeyName(ev('_', 'Minus'))).toBe('_')
    expect(eventKeyName(ev('1', 'Numpad1'))).toBe('1')
    expect(eventKeyName(ev('F5', 'F5'))).toBe('F5')
  })

  it('falls back to the physical key for other alphabets and dead keys, never for other characters', () => {
    expect(eventKeyName(ev('я', 'KeyZ'))).toBe('Z')
    expect(eventKeyName(ev('Dead', 'BracketLeft'))).toBe('[')
    expect(eventKeyName(ev('Unidentified', 'Digit3'))).toBe('3')
    // AZERTY "é" sits on the 2 key: not a shortcut (it never was).
    expect(eventKeyName(ev('é', 'Digit2'))).toBeNull()
    expect(eventKeyName(ev('Shift', 'ShiftLeft'))).toBeNull()
    expect(eventKeyName(ev('Control', 'ControlLeft'))).toBeNull()
    expect(eventKeyName(ev('AudioVolumeUp', 'AudioVolumeUp'))).toBeNull()
  })

  it('builds chords: Ctrl and the Windows key are one, Shift belongs to symbols', () => {
    expect(chordFromEvent(ev('z', 'KeyZ', { metaKey: true }))).toEqual({ ctrl: true, alt: false, shift: false, key: 'Z' })
    expect(chordFromEvent(ev('+', 'Equal', { shiftKey: true }))).toEqual({ ctrl: false, alt: false, shift: false, key: 'Plus' })
    expect(chordFromEvent(ev('Z', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toEqual({ ctrl: true, alt: false, shift: true, key: 'Z' })
    expect(chordFromEvent(ev('Alt', 'AltLeft', { altKey: true }))).toBeNull()
  })

  it('describes modifiers held while recording a shortcut', () => {
    expect(partialLabel(ev('Control', 'ControlLeft', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl + Shift + …')
    expect(partialLabel(ev('a', 'KeyA'))).toBe('')
  })

  it('knows the keys a focused slider uses', () => {
    expect(isSliderKey(parseShortcut('Left')!)).toBe(true)
    expect(isSliderKey(parseShortcut('Shift+Right')!)).toBe(true)
    expect(isSliderKey(parseShortcut('Home')!)).toBe(true)
    expect(isSliderKey(parseShortcut('Ctrl+Left')!)).toBe(false)
    expect(isSliderKey(parseShortcut('S')!)).toBe(false)
  })
})

describe('default keymap: every key the editor always had', () => {
  const K = DEFAULT_KEYMAP
  const cases: [KeyInput, string | null][] = [
    [ev(' ', 'Space'), 'play'],
    [ev(' ', 'Space', { shiftKey: true }), 'play'],
    [ev('s', 'KeyS'), 'split'],
    [ev('S', 'KeyS', { shiftKey: true }), 'split'],
    [ev('S', 'KeyS'), 'split'], // Caps Lock
    [ev('z', 'KeyZ'), 'addZoom'],
    [ev('t', 'KeyT'), 'addText'],
    [ev('Delete', 'Delete'), 'deleteSelection'],
    [ev('Backspace', 'Backspace'), 'deleteSelection'],
    [ev('ArrowLeft', 'ArrowLeft'), 'stepBack'],
    [ev('ArrowRight', 'ArrowRight'), 'stepForward'],
    [ev('ArrowLeft', 'ArrowLeft', { shiftKey: true }), 'jumpBack'],
    [ev('ArrowRight', 'ArrowRight', { shiftKey: true }), 'jumpForward'],
    [ev('Home', 'Home'), 'goToStart'],
    [ev('End', 'End'), 'goToEnd'],
    [ev('+', 'Equal', { shiftKey: true }), 'timelineZoomIn'],
    [ev('=', 'Equal'), 'timelineZoomIn'],
    [ev('+', 'NumpadAdd'), 'timelineZoomIn'],
    [ev('-', 'Minus'), 'timelineZoomOut'],
    [ev('_', 'Minus', { shiftKey: true }), 'timelineZoomOut'],
    [ev('z', 'KeyZ', { ctrlKey: true }), 'undo'],
    [ev('Z', 'KeyZ', { ctrlKey: true, shiftKey: true }), 'redo'],
    [ev('y', 'KeyY', { ctrlKey: true }), 'redo'],
    [ev('Y', 'KeyY', { ctrlKey: true, shiftKey: true }), 'redo'],
    [ev('я', 'KeyZ', { ctrlKey: true }), 'undo'],
    [ev('0', 'Digit0'), 'zoomLevel0'],
    [ev('1', 'Digit1'), 'zoomLevel1'],
    [ev('4', 'Numpad4'), 'zoomLevel4'],
    [ev('!', 'Digit1', { shiftKey: true }), null],
    [ev('k', 'KeyK', { ctrlKey: true }), 'commandPalette'],
    [ev('P', 'KeyP', { ctrlKey: true, shiftKey: true }), 'commandPalette'],
    // Alt, and Ctrl with keys that have no Ctrl shortcut, do nothing (as before).
    [ev('s', 'KeyS', { altKey: true }), null],
    [ev('z', 'KeyZ', { altKey: true, ctrlKey: true }), null],
    [ev('s', 'KeyS', { ctrlKey: true }), null],
    [ev(' ', 'Space', { ctrlKey: true }), null],
    [ev('x', 'KeyX'), null],
    [ev('Escape', 'Escape'), null]
  ]
  for (const [e, want] of cases) {
    it(`${[e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', JSON.stringify(e.key)].filter(Boolean).join('+')} → ${want}`, () => {
      expect(run(K, e)).toBe(want)
    })
  }

  it('gives the smarter auto zoom commands no default key (I stays free)', () => {
    for (const id of ['toggleClickAtPlayhead', 'findStrayClicks', 'useAllClicks', 'toggleStraighten', 'straightenRange', 'recordedPathRange'] as const) {
      expect(DEFAULT_KEYMAP[id], id).toEqual([])
    }
    expect(run(K, ev('i', 'KeyI'))).toBeNull()
    // They can still be bound, like any other command.
    expect(run(addBinding(K, 'toggleClickAtPlayhead', 'I'), ev('i', 'KeyI'))).toBe('toggleClickAtPlayhead')
  })

  it('has no conflicts and only valid, non-reserved shortcuts', () => {
    expect(findConflicts(DEFAULT_KEYMAP).size).toBe(0)
    for (const id of COMMAND_IDS) {
      for (const a of DEFAULT_KEYMAP[id]) {
        expect(normalizeShortcut(a), a).toBe(a)
        expect(checkShortcut(a, id), `${id}: ${a}`).toEqual({ ok: true, accelerator: a })
      }
    }
  })
})

describe('checkShortcut and reserved keys', () => {
  it('keeps Esc, Enter, Tab and window keys for themselves', () => {
    for (const a of ['Escape', 'Enter', 'Tab', 'Shift+Tab', 'Alt+F4', 'Ctrl+W', 'Ctrl+R', 'F11', 'Ctrl+Plus', 'Ctrl+-', 'Ctrl+0']) {
      expect(reservedReason(a), a).toBeTruthy()
      const check = checkShortcut(a, 'split')
      expect(check.ok, a).toBe(false)
    }
    expect(reservedReason('S')).toBeNull()
    expect(reservedReason('garbage+')).toBeNull()
  })

  it('never takes Esc, with any modifier: the editor reads Shift+Esc as Esc, Windows has the rest', () => {
    // As recorded in the shortcuts editor.
    expect(formatChord(chordFromEvent(ev('Escape', 'Escape', { shiftKey: true }))!)).toBe('Shift+Escape')
    for (const a of ['Escape', 'Shift+Escape', 'Ctrl+Escape', 'Ctrl+Shift+Escape', 'Alt+Escape', 'Ctrl+Alt+Shift+Escape']) {
      expect(reservedReason(a), a).toBeTruthy()
      expect(checkShortcut(a, 'split').ok, a).toBe(false)
      expect(checkShortcut(a, 'commandPalette').ok, a).toBe(false)
    }
    expect(reservedReason('Shift+Escape')).toMatch(/^Esc always cancels/)
    expect(reservedReason('Ctrl+Shift+Escape')).toMatch(/Task Manager/)
    // Nor is one read back from the preferences.
    expect(sanitizeShortcuts({ version: 1, bindings: { split: ['Shift+Escape', 'Alt+Esc', 'X'] } })).toEqual({ split: ['X'] })
  })

  it('accepts plain keys for editor commands but not for shortcuts that work while typing', () => {
    expect(checkShortcut('x', 'split')).toEqual({ ok: true, accelerator: 'X' })
    expect(checkShortcut('Shift+X', 'split')).toEqual({ ok: true, accelerator: 'Shift+X' })
    const typed = checkShortcut('X', 'commandPalette')
    expect(typed.ok).toBe(false)
    expect(checkShortcut('Shift+X', 'commandPalette').ok).toBe(false)
    expect(checkShortcut('Alt+X', 'commandPalette')).toEqual({ ok: true, accelerator: 'Alt+X' })
    expect(checkShortcut('F2', 'commandPalette')).toEqual({ ok: true, accelerator: 'F2' })
    expect(checkShortcut('Ctrl+', 'split').ok).toBe(false)
  })
})

describe('editing the keymap', () => {
  it('adding a shortcut takes it from the command that had it', () => {
    const k = addBinding(DEFAULT_KEYMAP, 'split', 'z')
    expect(k.split).toEqual(['S', 'Z'])
    expect(k.addZoom).toEqual([])
    expect(findConflicts(k).size).toBe(0)
    expect(commandForShortcut(k, 'Z')).toBe('split')
    expect(commandForShortcut(k, 'q')).toBeNull()
    expect(commandForShortcut(k, 'bad+')).toBeNull()
    expect(DEFAULT_KEYMAP.addZoom).toEqual(['Z'])
    // Adding what is already there, or nonsense, changes nothing.
    expect(addBinding(k, 'split', 'Z')).toBe(k)
    expect(addBinding(k, 'split', 'Ctrl+')).toBe(k)
  })

  it('keeps at most MAX_BINDINGS per command', () => {
    let k = DEFAULT_KEYMAP
    for (const key of ['A', 'B', 'C', 'D', 'E']) k = addBinding(k, 'split', key)
    expect(k.split).toHaveLength(MAX_BINDINGS)
    expect(k.split.at(-1)).toBe('E')
  })

  it('removes and resets shortcuts', () => {
    let k = removeBinding(DEFAULT_KEYMAP, 'deleteSelection', 'Backspace')
    expect(k.deleteSelection).toEqual(['Delete'])
    expect(removeBinding(k, 'deleteSelection', 'Backspace')).toBe(k)
    expect(isDefaultBinding(k, 'deleteSelection')).toBe(false)
    k = resetCommand(k, 'deleteSelection')
    expect(k.deleteSelection).toEqual(['Delete', 'Backspace'])
    expect(isDefaultBinding(k, 'deleteSelection')).toBe(true)
    // A default now used by another command stays with that command unless taken back.
    k = addBinding(DEFAULT_KEYMAP, 'addText', 'S')
    expect(takenDefaults(k, 'split')).toEqual([{ accelerator: 'S', owner: 'addText' }])
    expect(resetCommand(k, 'split').split).toEqual([])
    expect(resetCommand(k, 'split').addText).toEqual(['T', 'S'])
    const back = resetCommand(k, 'split', true)
    expect(back.split).toEqual(['S'])
    expect(back.addText).toEqual(['T'])
    expect(isDefaultBinding(back, 'split')).toBe(true)
    expect(takenDefaults(back, 'split')).toEqual([])
    expect(findConflicts(back).size).toBe(0)
  })

  it('takes several defaults back from different commands, keeping their other shortcuts', () => {
    let k = addBinding(DEFAULT_KEYMAP, 'split', 'Delete')
    k = addBinding(k, 'addText', 'Backspace')
    k = removeBinding(k, 'deleteSelection', 'Delete')
    expect(k.deleteSelection).toEqual([])
    expect(takenDefaults(k, 'deleteSelection')).toEqual([
      { accelerator: 'Delete', owner: 'split' },
      { accelerator: 'Backspace', owner: 'addText' }
    ])
    const back = resetCommand(k, 'deleteSelection', true)
    expect(back.deleteSelection).toEqual(['Delete', 'Backspace'])
    expect(back.split).toEqual(['S'])
    expect(back.addText).toEqual(['T'])
    // Nothing taken: both ways are the same.
    expect(resetCommand(back, 'split', true)).toEqual(resetCommand(back, 'split'))
  })
})

describe('hints that name the current keys', () => {
  it('offers the first shortcut, or nothing when there is none', () => {
    expect(orPress('Double-click to add text', DEFAULT_KEYMAP.addText)).toBe('Double-click to add text, or press T')
    expect(orPress('Double-click to add text', [])).toBe('Double-click to add text')
    expect(undoHint(DEFAULT_KEYMAP)).toBe(' · Ctrl + Z to undo')
    expect(undoHint(addBinding(removeBinding(DEFAULT_KEYMAP, 'undo', 'Ctrl+Z'), 'undo', 'Alt+U'))).toBe(' · Alt + U to undo')
    expect(undoHint(removeBinding(DEFAULT_KEYMAP, 'undo', 'Ctrl+Z'))).toBe('')
  })

  it('describes the zoom level keys as they are bound', () => {
    expect(zoomLevelKeysHint(DEFAULT_KEYMAP)).toBe('1–4 set its zoom level, 0 pulls back')
    // Rebound, partly removed, or all gone.
    let k = addBinding(removeBinding(DEFAULT_KEYMAP, 'zoomLevel4', '4'), 'zoomLevel4', 'F4')
    expect(zoomLevelKeysHint(k)).toBe('1, 2, 3 and F4 set its zoom level, 0 pulls back')
    k = removeBinding(removeBinding(removeBinding(k, 'zoomLevel1', '1'), 'zoomLevel2', '2'), 'zoomLevel3', '3')
    expect(zoomLevelKeysHint(k)).toBe('F4 sets its zoom level, 0 pulls back')
    k = removeBinding(k, 'zoomLevel0', '0')
    expect(zoomLevelKeysHint(k)).toBe('F4 sets its zoom level')
    k = removeBinding(k, 'zoomLevel4', 'F4')
    expect(zoomLevelKeysHint(k)).toBeNull()
    expect(zoomLevelKeysHint(addBinding(k, 'zoomLevel0', 'Shift+0'))).toBe('Shift + 0 pulls back')
    // Two digits are listed, not a range; digits out of order are not a range either.
    expect(zoomLevelKeysHint(resolveKeymap({ zoomLevel3: [], zoomLevel4: [] }))).toBe('1 and 2 set its zoom level, 0 pulls back')
    expect(zoomLevelKeysHint(resolveKeymap({ zoomLevel1: ['4'], zoomLevel4: ['1'] }))).toBe('4, 2, 3 and 1 set its zoom level, 0 pulls back')
  })
})

describe('stored shortcuts', () => {
  it('stores only the changes and reads them back', () => {
    let k = addBinding(DEFAULT_KEYMAP, 'split', 'X')
    k = removeBinding(k, 'deleteSelection', 'Backspace')
    const stored = serializeShortcuts(k)
    expect(stored).toEqual({ version: 1, bindings: { split: ['S', 'X'], deleteSelection: ['Delete'] } })
    expect(keymapOverrides(DEFAULT_KEYMAP)).toEqual({})
    // Through JSON, as the preference file does.
    expect(keymapFromPrefs(JSON.parse(JSON.stringify(stored)))).toEqual(k)
  })

  it('a moved default stays moved after reading back', () => {
    const k = addBinding(DEFAULT_KEYMAP, 'split', 'Z')
    const back = keymapFromPrefs(JSON.parse(JSON.stringify(serializeShortcuts(k))))
    expect(back.split).toEqual(['S', 'Z'])
    expect(back.addZoom).toEqual([])
    expect(run(back, ev('z', 'KeyZ'))).toBe('split')
  })

  it('drops anything invalid and falls back to the defaults', () => {
    for (const raw of [null, undefined, 42, 'x', [], { version: 2, bindings: {} }, { version: 1 }, { version: 1, bindings: [] }]) {
      expect(sanitizeShortcuts(raw), JSON.stringify(raw)).toEqual({})
      expect(keymapFromPrefs(raw)).toEqual(DEFAULT_KEYMAP)
    }
    const raw = {
      version: 1,
      bindings: {
        split: ['x', 'X', 'Escape', 'Ctrl+', 7, 'Tab', 'shift+y'],
        bogus: ['Q'],
        undo: 'Ctrl+U',
        commandPalette: ['K', 'Ctrl+J'],
        addText: Array.from({ length: 20 }, (_, i) => `F${i + 1}`)
      }
    }
    const s = sanitizeShortcuts(raw)
    expect(s).toEqual({ split: ['X', 'Shift+Y'], commandPalette: ['Ctrl+J'], addText: ['F1', 'F2', 'F3', 'F4'] })
    expect(Object.keys(s)).not.toContain('bogus')
  })

  it('never binds one shortcut twice: the user’s choice wins over a default', () => {
    // As if the file were edited by hand: T on split, while addText keeps its default T.
    const k = resolveKeymap({ split: ['T'] })
    expect(k.split).toEqual(['T'])
    expect(k.addText).toEqual([])
    // Two changed commands with the same key: the first in the registry keeps it.
    const both = resolveKeymap({ split: ['Q'], addText: ['Q'] })
    expect(both.split).toEqual(['Q'])
    expect(both.addText).toEqual([])
    expect(findConflicts(both).size).toBe(0)
  })
})
