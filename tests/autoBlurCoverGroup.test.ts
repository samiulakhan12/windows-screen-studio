import { describe, expect, it } from 'vitest'
import { copyItems, duplicateItems, pasteItems, pasteNotice } from '../src/shared/editor/groupClipboard'
import { applyField, copyLook, deleteItems, fieldsFor, GROUP_FIELDS, LOOK_CLASS_WORDS, pasteLook, type FieldCtx } from '../src/shared/editor/groupEdit'
import { groupMovePlan, moveGroup } from '../src/shared/editor/groupMove'
import { countOf, GROUP_KINDS, itemKey, KIND_WORDS, projectItems, toggleKey, trackOfKind } from '../src/shared/editor/multiSelect'
import { nudgeItems } from '../src/shared/editor/nudge'
import { EditStore } from '../src/shared/editor/editStore'
import { boxAt, writePath, type CoverKey } from '../src/shared/privacy/coverPath'
import type { Cover, Project } from '../src/shared/types'
import { base } from './autoBlurFixtures'

/*
 * Covers selected with other items (docs/design/auto-blur.md §14.4; §17.1 tests 70, 72 and 75): the
 * multi-select keys, group delete, colour and looks, time moves, the group clipboard, and the pinned
 * lists of the multi-select tests.
 */

const key = (t: number, x: number, y: number, w: number, h: number): CoverKey => ({ t, x, y, w, h })
const cover = (id: string, start: number, end: number, keys: CoverKey[], over: Partial<Cover> = {}): Cover => ({ id, start, end, path: writePath(keys), color: '#203040', ...over })
const ctx = (p: Project): FieldCtx => ({ crop: null, cursorValid: true, style: { defaultScale: 2, easing: 'smooth', transition: 0.6 } as never, background: p.style.background })

/** Three covers (two suggestions, one followed) and a zoom. */
function project(): Project {
  return {
    ...base('g1', 30),
    zooms: [{ id: 'z1', start: 1, end: 3, scale: 2, focus: { mode: 'cursor' }, auto: false }],
    covers: [
      cover('a', 2, 4, [key(2, 0.1, 0.1, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'ga' }),
      cover('b', 5, 7, [key(5, 0.3, 0.3, 0.2, 0.05)], { found: 'check', kind: 'key', group: 'gb' }),
      cover('f', 8, 12, [key(8, 0.5, 0.5, 0.2, 0.05), key(10, 0.5, 0.4, 0.2, 0.05)], { kind: 'phone', group: 'gf' })
    ]
  }
}

describe('auto-blur P1: covers in a group', () => {
  it('70. Multi-select: Ctrl+click several covers; group delete is one step with rejected places; group colour; Copy look and Paste look', () => {
    const p = project()
    // Ctrl+click: the single selected cover is the first member, the clicked one joins, again leaves.
    let r = toggleKey([], 'cover:a', 'cover:b')
    expect(r.keys).toEqual(['cover:a', 'cover:b'])
    r = toggleKey(r.keys, null, 'cover:f', r.anchor)
    expect(r.keys).toEqual(['cover:a', 'cover:b', 'cover:f'])
    expect(toggleKey(r.keys, null, 'cover:b', r.anchor).keys).toEqual(['cover:a', 'cover:f'])
    // Covers are items of their own row.
    expect(projectItems(p).filter((x) => x.track === 'covers').map((x) => x.key)).toEqual(['cover:a', 'cover:b', 'cover:f'])
    // Group delete: one update, the suggestions' places written to privacy.rejected (the kept cover leaves none).
    const store = new EditStore<Project>(p)
    store.update((q) => deleteItems(q, ['cover:a', 'cover:b', 'cover:f', 'zoom:z1']))
    expect(store.state.covers).toBeUndefined()
    expect(store.state.zooms).toEqual([])
    expect(store.state.privacy!.rejected!.map((x) => [x.kind, x.start, x.end])).toEqual([
      ['email', 2, 4],
      ['key', 5, 7]
    ])
    store.undo()
    expect(store.state).toBe(p)
    // Group colour: the Selection view's Colour row writes every selected cover, one update, each now the user's.
    const field = GROUP_FIELDS.find((f) => f.id === 'cover.color')!
    expect(field.cls).toBe('cover')
    const sections = fieldsFor(p, ['cover:a', 'cover:b', 'zoom:z1'])
    expect(sections.find((s) => s.cls === 'cover')!.fields.map((f) => f.field.id)).toEqual(['cover.color'])
    const coloured = applyField(p, field, ['cover:a', 'cover:b'], '#ffffff', ctx(p))
    expect(coloured.applied).toBe(2)
    expect(coloured.project.covers!.filter((c) => c.id !== 'f').map((c) => [c.color, c.found])).toEqual([
      ['#ffffff', undefined],
      ['#ffffff', undefined]
    ])
    expect(coloured.project.covers![2]).toBe(p.covers![2])
    // Copy look on one cover, Paste look on the others: its colour.
    const look = copyLook(coloured.project, 'cover:a', ctx(p))!
    expect(look).toEqual({ cls: 'cover', values: { 'cover.color': '#ffffff' }, label: 'Cover' })
    const pasted = pasteLook(p, ['cover:b', 'cover:f', 'zoom:z1'], look, ctx(p))
    expect([pasted.applied, pasted.other]).toEqual([2, 1])
    expect(pasted.project.covers!.map((c) => c.color)).toEqual(['#203040', '#ffffff', '#ffffff'])
    expect(LOOK_CLASS_WORDS.cover).toEqual(['cover', 'covers'])
    expect(countOf(3, 'cover')).toBe('3 covers')
  })

  it('72. The group clipboard pastes covers only into their own project, as snapshots', () => {
    const p = project()
    const clip = copyItems(p, ['cover:a', 'cover:f', 'zoom:z1'])!
    expect(clip.items.map((c) => c.kind)).toEqual(['zoom', 'cover', 'cover'])
    // A snapshot: editing the source after the copy changes nothing in the clipboard.
    const edited: Project = { ...p, covers: p.covers!.map((c) => ({ ...c, color: '#ffffff', path: writePath([key(c.start, 0.8, 0.8, 0.1, 0.1)]) })) }
    const into = pasteItems(edited, clip, 20)
    const pastedCovers = into.keys.filter((k) => k.startsWith('cover:'))
    expect(pastedCovers).toHaveLength(2)
    const pasted = into.project.covers!.filter((c) => pastedCovers.includes(itemKey('cover', c.id)))
    expect(pasted.map((c) => c.color)).toEqual(['#203040', '#203040'])
    // Each keeps its distance to the others: the copy spans 1 to 12 (the zoom to the followed cover), pasted at 20 and moved back to 19 so it fits.
    expect(into.at).toBe(19)
    expect(pasted.map((c) => [c.start, c.end])).toEqual([
      [20, 22],
      [26, 30]
    ])
    expect(boxAt(pasted[0], 21)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.05 })
    // The user's covers, in no group, with new ids.
    for (const c of pasted) expect([c.found, c.group, ['a', 'f'].includes(c.id)]).toEqual([undefined, undefined, false])
    // Another project: the covers are left out and the notice says why; the zoom still pastes.
    const other = pasteItems({ ...edited, id: 'other' }, clip, 20)
    expect(other.keys.filter((k) => k.startsWith('cover:'))).toEqual([])
    expect(other.skipped.filter((s) => s.kind === 'cover').map((s) => s.why)).toEqual(['cover-other-recording', 'cover-other-recording'])
    expect(pasteNotice(other, clip.items.length)).toContain('2 covers are from another recording')
    // Covers alone into another project: the one-project message.
    const only = pasteItems({ ...p, id: 'other' }, copyItems(p, ['cover:a'])!, 3)
    expect(pasteNotice(only, 1)).toBe('Covers paste only into the video they were copied from.')
    // Duplicate: right after themselves, in this project.
    const dup = duplicateItems(p, ['cover:a'])
    expect(dup.keys).toHaveLength(1)
    const d = dup.project.covers!.find((c) => itemKey('cover', c.id) === dup.keys[0])!
    expect([d.start, d.end]).toEqual([4, 6])
  })

  it('75. The pinned list tests hold with cover: GROUP_KINDS ends with graphic then cover, on its own Covers row, with its words', async () => {
    expect(GROUP_KINDS).toEqual(['zoom', 'annotation', 'shape', 'spotlight', 'overlay', 'title', 'chapter', 'freeze', 'graphic', 'cover'])
    expect(GROUP_KINDS.at(-2)).toBe('graphic')
    expect(GROUP_KINDS.map(trackOfKind)).toEqual(['zoom', 'text', 'shapes', 'shapes', 'images', 'titles', 'chapters', 'freezes', 'graphics', 'covers'])
    expect(KIND_WORDS.cover).toBe('style.groupEdit.count.cover')
    // The pinned tests themselves say so.
    const fs = await import('node:fs')
    const read = (f: string): string => fs.readFileSync(`tests/${f}`, 'utf8')
    expect(read('multiSelectContracts.test.ts')).toContain(`expect(multiSelect.GROUP_KINDS).toEqual(['zoom', 'annotation', 'shape', 'spotlight', 'overlay', 'title', 'chapter', 'freeze', 'graphic', 'cover'])`)
    expect(read('graphicsSelection.test.ts')).toContain(`expect(GROUP_KINDS.at(-2)).toBe('graphic')`)
    expect(read('multiSelect.test.ts')).toContain(`'graphics', 'covers'])`)
    expect(read('multiSelectCopy.test.ts')).toMatch(/for \(const kind of GROUP_KINDS\)/)
    // A selection of every kind round-trips, covers included.
    const SELECTION = '../src/renderer/src/editor/selection'
    const selection = (await import(/* @vite-ignore */ SELECTION)) as { selectionOfKey(k: string): unknown; selectionKey(s: unknown): string; groupKeyOf(s: unknown): string | null }
    expect(selection.selectionOfKey('cover:c1')).toEqual({ kind: 'cover', id: 'c1' })
    expect(selection.groupKeyOf({ kind: 'cover', id: 'c1' })).toBe('cover:c1')
  })
})

describe('auto-blur P1: covers moved in time with others', () => {
  it('a group time move takes each cover from its press times, moves one-key covers and leaves followed ones (the status line is test 71)', () => {
    const p = project()
    const keys = ['cover:a', 'cover:f', 'zoom:z1'] as const
    const plan = groupMovePlan(p, keys)
    // A drag's moves, each from the press (as the timeline calls it on the state the last move left).
    let q = moveGroup(p, plan, 1)
    q = moveGroup(q, plan, 2)
    q = moveGroup(q, plan, 1.5)
    const a = q.covers!.find((c) => c.id === 'a')!
    expect([a.start, a.end]).toEqual([3.5, 5.5])
    expect(q.covers!.find((c) => c.id === 'f')).toBe(p.covers![2])
    expect([q.zooms[0].start, q.zooms[0].end]).toEqual([2.5, 4.5])
    // The nudge commands move them the same way.
    const n = nudgeItems(p, ['cover:a', 'cover:f'], 3)
    expect(n.project.covers!.find((c) => c.id === 'a')!.start).toBeCloseTo(2.1, 6)
    expect(n.project.covers!.find((c) => c.id === 'f')).toBe(p.covers![2])
  })
})
