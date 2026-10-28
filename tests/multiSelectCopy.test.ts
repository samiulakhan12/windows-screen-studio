import { describe, expect, it } from 'vitest'
import { GROUP_KINDS, itemKey, type ItemKey } from '../src/shared/editor/multiSelect'
import { copyLookFirst, movedNotice, nothingCopiedNotice, REFUSAL_TEXT, removedNotice, selectAllNotice, stopNotice } from '../src/shared/editor/multiSelectCopy'

/* What the editor says about groups (docs/design/multi-select.md §5.6), and the selection's single-item keys (§4.1, M1). */

interface SelectionModule {
  selectionKey(sel: unknown): string
  selectionOfKey(k: ItemKey): { kind: string; id: string } | null
  groupKeyOf(sel: unknown): ItemKey | null
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SELECTION = '../src/renderer/src/editor/selection'
const selection = (await import(/* @vite-ignore */ SELECTION)) as SelectionModule

describe('M1: single selections and keys', () => {
  it('selectionKey(selectionOfKey(k)) is k for every kind, and groupKeyOf reads it back', () => {
    for (const kind of GROUP_KINDS) {
      const k = itemKey(kind, 'x1')
      const sel = selection.selectionOfKey(k)
      expect(sel).toEqual({ kind, id: 'x1' })
      expect(selection.selectionKey(sel)).toBe(k)
      expect(selection.groupKeyOf(sel)).toBe(k)
    }
  })
  it('selections that cannot join a group have no key', () => {
    for (const sel of [{ kind: 'clip', id: 'c0' }, { kind: 'caption', id: 'c1' }, { kind: 'layout', id: 'l1' }, { kind: 'range', start: 1, end: 2 }, { kind: 'gap', start: 1, end: 2 }, { kind: 'click', ms: 100 }, null])
      expect(selection.groupKeyOf(sel)).toBeNull()
  })
})

describe('notices', () => {
  it('refusals name the reason and the way to edit many', () => {
    expect(REFUSAL_TEXT).toEqual({
      clip: 'Clips and cuts are selected one at a time',
      click: 'Recorded clicks are ignored one at a time, or with Find stray clicks',
      caption: 'Captions are edited one at a time, or all at once in the Captions tab',
      layout: "Camera layouts are changed one at a time; the director's tools redo many at once"
    })
  })
  it('a held-back group drag says why', () => {
    expect(stopNotice('zoom')).toBe('The selection stops here: a zoom is in the way')
    expect(stopNotice('start')).toBe('The selection stops here: the start of the recording')
    expect(stopNotice('end')).toBe('The selection stops here: the end of the recording')
    expect(stopNotice('freeze-clip')).toBe('The selection stops here: a freeze frame stays in its clip (drag it alone to move it past a cut)')
    expect(stopNotice('freeze-taken')).toBe('The selection stops here: a freeze frame is already on that frame')
    expect(stopNotice('freeze-in-cut')).toBe("A selected freeze frame is in a cut, so the selection can't move. Ctrl+click it to leave it out")
    expect(stopNotice('full')).toBe('The selection already fills the recording')
  })
  it('±1 s and Starts at say when a limit cut the move short', () => {
    expect(movedNotice(1, null)).toBeNull()
    expect(movedNotice(0.6, 'zoom')).toBe('Moved 0.6 s later: a zoom is in the way')
    expect(movedNotice(-0.25, 'start')).toBe('Moved 0.3 s earlier: the start of the recording')
    expect(movedNotice(0, 'end')).toBe('Not moved: the end of the recording')
  })
  it('Ctrl+A says what it selected', () => {
    const text = Array.from({ length: 12 }, (_, i) => itemKey('annotation', `a${i}`))
    expect(selectAllNotice('track', text, 'Ctrl + A')).toBe('Selected all 12 text items · Ctrl + A again selects every item')
    expect(selectAllNotice('track', [itemKey('shape', 's1'), itemKey('spotlight', 'l1')], null)).toBe('Selected all 2 items on the shapes track')
    expect(selectAllNotice('track', [itemKey('zoom', 'z1')], 'Ctrl + A')).toBe('Selected the only zoom · Ctrl + A again selects every item')
    expect(selectAllNotice('all', text, 'Ctrl + A')).toBe('Selected every item (12)')
    expect(selectAllNotice('none', [], 'Ctrl + A')).toBe('No items to select yet')
  })
  it('delete and cut count the items, with the undo hint', () => {
    expect(removedNotice('Deleted', 5, ' · Ctrl + Z to undo')).toBe('Deleted 5 items · Ctrl + Z to undo')
    expect(removedNotice('Cut', 1, '')).toBe('Cut 1 item')
  })
  it('the hints for an empty clipboard name the user\'s key, or a way without one', () => {
    expect(copyLookFirst('Alt + C')).toBe('Copy a look first: select one item and press Alt + C')
    expect(copyLookFirst(null)).toBe('Copy a look first: select one item and press its Copy look button')
    expect(nothingCopiedNotice('Ctrl + C')).toBe('Nothing copied yet: select items and press Ctrl + C')
    expect(nothingCopiedNotice(null)).toBe('Nothing copied yet: select items and run "Copy selected items" from the command palette')
  })
})
