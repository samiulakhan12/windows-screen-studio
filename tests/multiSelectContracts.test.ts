import { describe, expect, it } from 'vitest'
import { COMMAND_IDS, commandInfo, type CommandId } from '../src/shared/editor/commands'
import * as groupClipboard from '../src/shared/editor/groupClipboard'
import * as groupEdit from '../src/shared/editor/groupEdit'
import * as groupMove from '../src/shared/editor/groupMove'
import * as multiSelect from '../src/shared/editor/multiSelect'
import * as shapes from '../src/shared/editor/shapes'
import * as shortcuts from '../src/shared/editor/shortcuts'
import * as snapping from '../src/shared/editor/snapping'
import * as titles from '../src/shared/editor/titles'

/*
 * The contracts of E-06, select several items (docs/design/multi-select.md §9.6): the exported
 * names of the four pure modules and the additive exports, the seven commands with their titles
 * and place, their keys, and the empty group. Builders and later waves rely on these names.
 */

const exportsOf = (m: object): string[] => Object.keys(m).sort()

describe('E-06 contracts', () => {
  it('multiSelect.ts exports the selection model and its rules', () => {
    for (const name of [
      'GROUP_KINDS',
      'NO_GROUP',
      'extendTo',
      'groupLabel',
      'isGroupKind',
      'itemKey',
      'kindCounts',
      'parseItemKey',
      'projectItems',
      'rectsHit',
      'selectAllStep',
      'toggleKey',
      'topmostHit',
      'trackKeys',
      'trackOfKind',
      'unionKeys',
      'validGroup'
    ])
      expect(exportsOf(multiSelect), name).toContain(name)
    expect(multiSelect.GROUP_KINDS).toEqual(['zoom', 'annotation', 'shape', 'spotlight', 'title', 'chapter', 'freeze'])
  })

  it('NO_GROUP is empty, frozen and has stamp 0', () => {
    expect(multiSelect.NO_GROUP).toEqual({ keys: [], anchor: null, stamp: 0 })
    expect(Object.isFrozen(multiSelect.NO_GROUP)).toBe(true)
    expect(Object.isFrozen(multiSelect.NO_GROUP.keys)).toBe(true)
  })

  it('itemKey is the snapping owner key', () => {
    expect(multiSelect.itemKey('zoom', 'z1')).toBe('zoom:z1')
    expect(multiSelect.itemKey('freeze', 'f1')).toBe('freeze:f1')
  })

  it('groupMove.ts, groupEdit.ts and groupClipboard.ts export their functions', () => {
    for (const name of ['groupAccepts', 'groupMovePlan', 'groupSnapPoints', 'moveGroup', 'setGroupLength', 'setGroupStart']) expect(exportsOf(groupMove), name).toContain(name)
    for (const name of ['GROUP_FIELDS', 'applyField', 'copyLook', 'deleteItems', 'fieldsFor', 'lookClassOf', 'lookLabel', 'mapItems', 'pasteLook', 'sharedValue'])
      expect(exportsOf(groupEdit), name).toContain(name)
    for (const name of ['DUPLICATE_MIN_OFFSET', 'copyItems', 'duplicateItems', 'pasteItems', 'pasteNotice']) expect(exportsOf(groupClipboard), name).toContain(name)
    expect(groupClipboard.DUPLICATE_MIN_OFFSET).toBe(1)
  })

  it('shared files gain additive exports only', () => {
    expect(typeof snapping.snapGroup).toBe('function')
    expect(typeof shapes.newShapeId).toBe('function')
    expect(typeof shapes.newSpotlightId).toBe('function')
    expect(typeof titles.newTitleId).toBe('function')
    expect(shapes.newShapeId()).toMatch(/^s/)
    expect(shapes.newSpotlightId()).toMatch(/^l/)
    expect(titles.newTitleId()).toMatch(/^c/)
    expect(shapes.newShapeId()).not.toBe(shapes.newShapeId())
    for (const name of ['STANDARD_EDIT_KEYS', 'standardEditCommand', 'commandKeys']) expect(exportsOf(shortcuts), name).toContain(name)
  })

  const NEW: [CommandId, string, string[]][] = [
    ['selectAll', 'Select all items on the track (again: every item)', []],
    ['copyItems', 'Copy selected items', []],
    ['cutItems', 'Cut selected items', []],
    ['pasteItems', 'Paste items at playhead', []],
    ['duplicateItems', 'Duplicate selected items', ['Ctrl+D']],
    ['copyLook', 'Copy look of the selected item', ['Ctrl+Shift+C']],
    ['pasteLook', 'Paste look onto selected items', ['Ctrl+Shift+V']]
  ]

  it('the seven commands, their titles, order and keys are frozen', () => {
    const at = COMMAND_IDS.indexOf('toggleFreezeSound')
    expect(COMMAND_IDS.slice(at + 1, at + 8)).toEqual(NEW.map(([id]) => id))
    for (const [id, title, keys] of NEW) {
      expect(commandInfo(id).title, id).toBe(title)
      expect(commandInfo(id).category, id).toBe('Edit')
      expect(shortcuts.DEFAULT_KEYMAP[id], id).toEqual(keys)
    }
    expect(shortcuts.STANDARD_EDIT_KEYS).toEqual({ 'Ctrl+A': 'selectAll', 'Ctrl+C': 'copyItems', 'Ctrl+X': 'cutItems', 'Ctrl+V': 'pasteItems' })
  })
})
