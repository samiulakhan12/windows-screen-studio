import { describe, expect, it } from 'vitest'
import {
  COMMAND_CATEGORIES,
  COMMAND_IDS,
  COMMANDS,
  commandInfo,
  fuzzyMatch,
  isCommandId,
  PALETTE_COMMANDS,
  pushRecent,
  sanitizeRecent,
  searchCommands,
  type CommandId
} from '../src/shared/editor/commands'

const titles = (query: string, recent: CommandId[] = []): string[] => searchCommands(PALETTE_COMMANDS, query, recent).map((r) => r.command.title)

describe('command registry', () => {
  it('has unique ids, known categories and a title for every command', () => {
    expect(new Set(COMMAND_IDS).size).toBe(COMMAND_IDS.length)
    for (const c of COMMANDS) {
      expect(COMMAND_CATEGORIES).toContain(c.category)
      expect(c.title.trim().length, c.id).toBeGreaterThan(2)
    }
    expect(isCommandId('split')).toBe(true)
    expect(isCommandId('nope')).toBe(false)
    expect(isCommandId(42)).toBe(false)
    expect(commandInfo('undo').title).toBe('Undo')
  })

  it('covers what the palette must offer, and hides only the palette itself', () => {
    const ids = PALETTE_COMMANDS.map((c) => c.id)
    for (const id of [
      'play', 'goToStart', 'goToEnd', 'stepBack', 'stepForward', 'split', 'deleteSelection', 'undo', 'redo', 'cutRange', 'restoreAll',
      'addZoom', 'addText', 'addArrow', 'addLine', 'addRect', 'addEllipse', 'addHighlight', 'addBlur', 'addPixelate', 'addSpotlight',
      'toggleCursor', 'toggleClickEffects', 'toggleMotionBlur', 'toggleKeystrokes', 'toggleWebcam', 'showStyle', 'showAudio',
      'export', 'smartSpeed', 'shortcuts', 'timelineZoomIn', 'timelineZoomOut', 'timelineFit'
    ] as CommandId[]) expect(ids, id).toContain(id)
    expect(ids).not.toContain('commandPalette')
    expect(commandInfo('commandPalette').inText).toBe(true)
  })
})

describe('fuzzyMatch', () => {
  it('matches subsequences, ignoring case, and returns the matched positions', () => {
    expect(fuzzyMatch('spl', 'Split clip at playhead')?.indices).toEqual([0, 1, 2])
    expect(fuzzyMatch('SCAP', 'Split clip at playhead')?.indices).toEqual([0, 6, 11, 14])
    expect(fuzzyMatch('', 'Anything')).toEqual({ score: 0, indices: [] })
    expect(fuzzyMatch('xyz', 'Split clip')).toBeNull()
    expect(fuzzyMatch('splitclipatplayheadandmore', 'Split clip')).toBeNull()
    expect(fuzzyMatch('ps', 'Split')).toBeNull()
  })

  it('prefers word starts and consecutive letters', () => {
    const start = fuzzyMatch('cl', 'Split clip')!
    expect(start.indices).toEqual([6, 7])
    expect(fuzzyMatch('sp', 'Split')!.score).toBeGreaterThan(fuzzyMatch('sp', 'Mesh paint')!.score)
    expect(fuzzyMatch('zoom', 'Zoom level')!.score).toBeGreaterThan(fuzzyMatch('zoom', 'Add zoom at playhead')!.score)
    // Word starts beat letters in the middle of words.
    expect(fuzzyMatch('mb', 'Motion blur')!.score).toBeGreaterThan(fuzzyMatch('mb', 'Combo')!.score)
  })
})

describe('searchCommands', () => {
  it('ranks the best title match first', () => {
    expect(titles('split')[0]).toBe('Split clip at playhead')
    expect(titles('undo')[0]).toBe('Undo')
    expect(titles('add arr')[0]).toBe('Add arrow')
    expect(titles('export')[0]).toBe('Export…')
    expect(titles('motion')[0]).toBe('Motion blur')
    expect(titles('  Smart  SPEED ')[0]).toBe('Smart speed: find idle parts')
  })

  it('finds commands by keywords and category, below title matches', () => {
    expect(titles('privacy')).toEqual(expect.arrayContaining(['Add blur', 'Add pixelate']))
    expect(titles('webcam')[0]).toBe('Camera bubble')
    expect(titles('hotkeys')).toContain('Keyboard shortcuts…')
    // Scattered letters in keywords do not count.
    expect(titles('zqx')).toEqual([])
  })

  it('needs every word to match', () => {
    expect(titles('add zebra')).toEqual([])
    expect(titles('zoom timeline')[0]).toMatch(/timeline/)
  })

  it('lists recent commands first for an empty query, then the rest in order', () => {
    const all = searchCommands(PALETTE_COMMANDS, '', ['export', 'split'])
    expect(all.map((r) => r.command.id).slice(0, 3)).toEqual(['export', 'split', 'play'])
    expect(all.slice(0, 2).every((r) => r.recent)).toBe(true)
    expect(all[2].recent).toBe(false)
    expect(all).toHaveLength(PALETTE_COMMANDS.length)
    // Ids that are not in the list are ignored.
    expect(searchCommands(PALETTE_COMMANDS, '', ['commandPalette'])[0].command.id).toBe('play')
  })

  it('lifts recent commands among similar matches', () => {
    const plain = titles('add')
    const lifted = titles('add', ['addPixelate'])
    expect(plain[0]).not.toBe('Add pixelate')
    expect(lifted[0]).toBe('Add pixelate')
  })
})

describe('recent commands', () => {
  it('moves a command to the front and keeps the list short', () => {
    expect(pushRecent(['split', 'undo'], 'undo')).toEqual(['undo', 'split'])
    let r: CommandId[] = []
    for (const id of COMMAND_IDS.slice(0, 10)) r = pushRecent(r, id, 4)
    expect(r).toEqual(COMMAND_IDS.slice(6, 10).reverse())
  })

  it('reads back only known, distinct ids', () => {
    expect(sanitizeRecent(['split', 'split', 'bogus', 3, null, 'undo'])).toEqual(['split', 'undo'])
    expect(sanitizeRecent('split')).toEqual([])
    expect(sanitizeRecent(null)).toEqual([])
    expect(sanitizeRecent(COMMAND_IDS, 3)).toHaveLength(3)
  })
})
