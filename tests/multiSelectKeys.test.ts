import { describe, expect, it } from 'vitest'
import { COMMAND_IDS, commandInfo, PALETTE_COMMANDS, searchCommands, type CommandId } from '../src/shared/editor/commands'
import {
  addBinding,
  checkShortcut,
  chordFromEvent,
  commandKeys,
  DEFAULT_KEYMAP,
  findConflicts,
  matchShortcut,
  shortcutIndex,
  standardEditCommand,
  withShortcut,
  type KeyInput
} from '../src/shared/editor/shortcuts'

/* The commands and keys of E-06 (docs/design/multi-select.md §6, §10.1 K1-K6). */

const ev = (key: string, code: string, mods: Partial<Pick<KeyInput, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {}): KeyInput => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

const NEW: CommandId[] = ['selectAll', 'copyItems', 'cutItems', 'pasteItems', 'duplicateItems', 'copyLook', 'pasteLook']

describe('K1: the seven commands', () => {
  it('are in the palette, in Edit, right after toggleFreezeSound, and plain commands', () => {
    const ids = PALETTE_COMMANDS.map((c) => c.id)
    for (const id of NEW) {
      expect(ids, id).toContain(id)
      expect(commandInfo(id).category, id).toBe('Edit')
      const c = commandInfo(id)
      expect([c.inText, c.repeat, c.toggle, c.hidden].some(Boolean), id).toBe(false)
      expect(c.keywords, id).toMatch(/multi several group many/)
    }
    const at = COMMAND_IDS.indexOf('toggleFreezeSound')
    expect(COMMAND_IDS.slice(at + 1, at + 8)).toEqual(NEW)
    // The order assertions of earlier waves still hold.
    expect(COMMAND_IDS[COMMAND_IDS.indexOf('smartSpeed') + 1]).toBe('polish')
  })
})

describe('K2: DEFAULT_KEYMAP', () => {
  it('binds Ctrl+D, Ctrl+Shift+C and Ctrl+Shift+V without conflicts', () => {
    expect(DEFAULT_KEYMAP.duplicateItems).toEqual(['Ctrl+D'])
    expect(DEFAULT_KEYMAP.copyLook).toEqual(['Ctrl+Shift+C'])
    expect(DEFAULT_KEYMAP.pasteLook).toEqual(['Ctrl+Shift+V'])
    expect(findConflicts(DEFAULT_KEYMAP).size).toBe(0)
    for (const id of ['duplicateItems', 'copyLook', 'pasteLook'] as const) for (const a of DEFAULT_KEYMAP[id]) expect(checkShortcut(a, id)).toEqual({ ok: true, accelerator: a })
    for (const id of ['selectAll', 'copyItems', 'cutItems', 'pasteItems'] as const) expect(DEFAULT_KEYMAP[id]).toEqual([])
  })

  it('matches them exactly, and plain C is still the crop tool', () => {
    const index = shortcutIndex(DEFAULT_KEYMAP)
    const run = (e: KeyInput): CommandId | null => matchShortcut(index, chordFromEvent(e)!)
    expect(run(ev('d', 'KeyD', { ctrlKey: true }))).toBe('duplicateItems')
    expect(run(ev('C', 'KeyC', { ctrlKey: true, shiftKey: true }))).toBe('copyLook')
    expect(run(ev('V', 'KeyV', { ctrlKey: true, shiftKey: true }))).toBe('pasteLook')
    expect(run(ev('c', 'KeyC'))).toBe('cropRecording')
  })
})

describe('K3: standardEditCommand', () => {
  const std = (e: KeyInput): CommandId | null => standardEditCommand(chordFromEvent(e)!)
  it('maps Ctrl+A/C/X/V exactly', () => {
    expect(std(ev('a', 'KeyA', { ctrlKey: true }))).toBe('selectAll')
    expect(std(ev('c', 'KeyC', { ctrlKey: true }))).toBe('copyItems')
    expect(std(ev('x', 'KeyX', { ctrlKey: true }))).toBe('cutItems')
    expect(std(ev('v', 'KeyV', { ctrlKey: true }))).toBe('pasteItems')
    // Meta counts as Ctrl.
    expect(std(ev('v', 'KeyV', { metaKey: true }))).toBe('pasteItems')
  })
  it('never matches another chord', () => {
    expect(std(ev('C', 'KeyC', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(std(ev('c', 'KeyC', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(std(ev('c', 'KeyC'))).toBeNull()
    expect(std(ev('A', 'KeyA', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })
})

describe('K4: the keymap still runs nothing on Ctrl+C', () => {
  it('matchShortcut(Ctrl+C) is null', () => {
    expect(matchShortcut(shortcutIndex(DEFAULT_KEYMAP), chordFromEvent(ev('c', 'KeyC', { ctrlKey: true }))!)).toBeNull()
    expect(matchShortcut(shortcutIndex(DEFAULT_KEYMAP), chordFromEvent(ev('a', 'KeyA', { ctrlKey: true }))!)).toBeNull()
    expect(matchShortcut(shortcutIndex(DEFAULT_KEYMAP), chordFromEvent(ev('v', 'KeyV', { ctrlKey: true }))!)).toBeNull()
  })
})

describe('K5: commandKeys', () => {
  it('lists the keymap bindings, then the standard key', () => {
    expect(commandKeys(DEFAULT_KEYMAP, 'copyItems')).toEqual(['Ctrl+C'])
    const withF9 = addBinding(DEFAULT_KEYMAP, 'copyItems', 'F9')
    expect(commandKeys(withF9, 'copyItems')).toEqual(['F9', 'Ctrl+C'])
    expect(withShortcut('Copy', commandKeys(withF9, 'copyItems'))).toBe('Copy (F9)')
    expect(withShortcut('Copy', commandKeys(DEFAULT_KEYMAP, 'copyItems'))).toBe('Copy (Ctrl + C)')
    expect(commandKeys(DEFAULT_KEYMAP, 'duplicateItems')).toEqual(['Ctrl+D'])
    expect(commandKeys(DEFAULT_KEYMAP, 'play')).toEqual(['Space'])
  })
  it('drops the standard key once another command has it in the keymap', () => {
    const taken = addBinding(DEFAULT_KEYMAP, 'split', 'Ctrl+C')
    expect(commandKeys(taken, 'copyItems')).toEqual([])
    expect(commandKeys(taken, 'split')).toEqual(['S', 'Ctrl+C'])
  })
})

describe('K6: palette search', () => {
  const titles = (q: string): string[] => searchCommands(PALETTE_COMMANDS, q).map((r) => r.command.title)
  it('finds the new commands', () => {
    expect(titles('paste')[0]).toBe('Paste items at playhead')
    const look = titles('look')
    expect(look).toContain('Copy look of the selected item')
    expect(look).toContain('Paste look onto selected items')
    expect(searchCommands(PALETTE_COMMANDS, 'format painter')[0].command.id).toBe('copyLook')
    expect(titles('select all')[0]).toBe('Select all items on the track (again: every item)')
  })
})
