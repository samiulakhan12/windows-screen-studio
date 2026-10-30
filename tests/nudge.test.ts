import { describe, expect, it } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import type { ItemKey } from '../src/shared/editor/multiSelect'
import { NUDGE_FRAME, nudgedNotice, nudgeItems, nudgeUndoKey } from '../src/shared/editor/nudge'
import { commandKeys, DEFAULT_KEYMAP, findConflicts, keymapFromPrefs, nudgeInstead, NUDGE_STEPS, resolveKeymap } from '../src/shared/editor/shortcuts'
import type { Project } from '../src/shared/types'
import { chapter, freeze, p20, text, zoom } from './groupFixture'

const k = (s: string): ItemKey => s as ItemKey

describe('nudgeItems', () => {
  it('moves one item one frame (1/30 s), earlier or later', () => {
    const p = p20({ annotations: [text('t', 5, 6)] })
    const later = nudgeItems(p, [k('annotation:t')], 1)
    expect(later.project.annotations[0].start).toBeCloseTo(5 + 1 / 30, 9)
    expect(later.project.annotations[0].end).toBeCloseTo(6 + 1 / 30, 9)
    expect(later).toMatchObject({ moved: NUDGE_FRAME, stopped: null })
    const earlier = nudgeItems(p, [k('annotation:t')], -10)
    expect(earlier.project.annotations[0].start).toBeCloseTo(5 - 10 / 30, 9)
  })

  it('moves a group together, chapters included, and makes zooms yours', () => {
    const p = p20({ zooms: [zoom('z', 2, 3, { auto: true })], chapters: [chapter('c', 4)], annotations: [text('t', 5, 6)] })
    const r = nudgeItems(p, [k('zoom:z'), k('chapter:c'), k('annotation:t')], 10)
    expect(r.project.zooms[0]).toMatchObject({ auto: false })
    expect(r.project.zooms[0].start).toBeCloseTo(2 + 1 / 3, 9)
    expect(r.project.chapters![0].t).toBeCloseTo(4 + 1 / 3, 9)
    expect(r.project.annotations[0].start).toBeCloseTo(5 + 1 / 3, 9)
  })

  it('stops at the start of the recording and says why', () => {
    const p = p20({ annotations: [text('t', 0.1, 1)] })
    const r = nudgeItems(p, [k('annotation:t')], -10)
    expect(r.project.annotations[0].start).toBeCloseTo(0, 9)
    expect(r.moved).toBeCloseTo(-0.1, 9)
    expect(r.stopped).toBe('start')
    const none = nudgeItems(r.project, [k('annotation:t')], -1)
    expect(none).toMatchObject({ moved: 0, stopped: 'start' })
    expect(none.project).toBe(r.project)
  })

  it('stops at another zoom', () => {
    const p = p20({ zooms: [zoom('a', 1, 2), zoom('b', 2.05, 3)] })
    const r = nudgeItems(p, [k('zoom:a')], 10)
    expect(r.project.zooms[0].end).toBeCloseTo(2.05, 9)
    expect(r.stopped).toBe('zoom')
  })

  it('keeps a freeze frame in its clip, and does not move onto a taken frame', () => {
    const p = p20({ freezes: [freeze('f', 7.99)] })
    const r = nudgeItems(p, [k('freeze:f')], 10)
    expect(r.stopped).toBe('freeze-clip')
    expect(r.project.freezes![0].at).toBeLessThan(8)
    const two = p20({ freezes: [freeze('a', 3), freeze('b', 3 + 1 / 30)] })
    expect(nudgeItems(two, [k('freeze:a')], 1)).toMatchObject({ moved: 0, stopped: 'freeze-taken' })
  })

  it('does nothing without items or frames', () => {
    const p = p20()
    expect(nudgeItems(p, [], 1)).toEqual({ project: p, moved: 0, stopped: null })
    expect(nudgeItems(p, [k('annotation:gone')], 1).project).toBe(p)
    expect(nudgeItems(p20({ annotations: [text('t', 5, 6)] }), [k('annotation:t')], 0).moved).toBe(0)
  })

  it('says what moved', () => {
    expect(nudgedNotice(1, 1)).toBe('Moved 1 item 1 frame later')
    expect(nudgedNotice(3, -10)).toBe('Moved 3 items 10 frames earlier')
  })
})

describe('one undo step per run of presses', () => {
  it('merges presses less than 800 ms apart, and starts again after a pause or another selection', () => {
    let now = 0
    const store = new EditStore<Project>(p20({ annotations: [text('t', 5, 6), text('u', 8.5, 9)] }), 200, 800, () => now)
    const press = (keys: ItemKey[], frames: number): void => store.update((p) => nudgeItems(p, keys, frames).project, nudgeUndoKey(keys))
    for (let i = 0; i < 20; i++) {
      press([k('annotation:t')], 1)
      now += 33
    }
    expect(store.state.annotations[0].start).toBeCloseTo(5 + 20 / 30, 6)
    now += 900
    press([k('annotation:t')], 1)
    press([k('annotation:u')], 1)
    store.undo()
    store.undo()
    expect(store.state.annotations[0].start).toBeCloseTo(5 + 20 / 30, 6)
    store.undo()
    expect(store.state.annotations[0].start).toBe(5)
    expect(store.canUndo).toBe(false)
  })
  it('names a run by its items in any order', () => {
    expect(nudgeUndoKey([k('zoom:b'), k('annotation:a')])).toBe(nudgeUndoKey([k('annotation:a'), k('zoom:b')]))
  })
})

describe('the step keys nudge while items are selected', () => {
  it('swaps the four step commands only', () => {
    expect(nudgeInstead('stepBack', true)).toBe('nudgeBack')
    expect(nudgeInstead('stepForward', true)).toBe('nudgeForward')
    expect(nudgeInstead('jumpBack', true)).toBe('nudgeBackTen')
    expect(nudgeInstead('jumpForward', true)).toBe('nudgeForwardTen')
    expect(nudgeInstead('stepBack', false)).toBe('stepBack')
    expect(nudgeInstead('split', true)).toBe('split')
    expect(Object.values(NUDGE_STEPS).map((s) => s.frames)).toEqual([-1, 1, -10, 10])
  })
  it("shows the step keys as the nudges' own, following the user's keymap", () => {
    expect(commandKeys(DEFAULT_KEYMAP, 'nudgeBack')).toEqual(['Left'])
    expect(commandKeys(DEFAULT_KEYMAP, 'nudgeForwardTen')).toEqual(['Shift+Right'])
    const mine = resolveKeymap({ stepBack: ['A'], nudgeBack: ['Alt+Left'] })
    expect(commandKeys(mine, 'nudgeBack')).toEqual(['Alt+Left', 'A'])
  })
  it('adds Ctrl+Shift+S for Save a version without a conflict, and keeps a user’s own use of it', () => {
    expect(DEFAULT_KEYMAP.saveVersion).toEqual(['Ctrl+Shift+S'])
    expect(findConflicts(DEFAULT_KEYMAP).size).toBe(0)
    const prefs = { version: 1, bindings: { split: ['Ctrl+Shift+S'] } }
    const km = keymapFromPrefs(prefs)
    expect(km.split).toEqual(['Ctrl+Shift+S'])
    expect(km.saveVersion).toEqual([])
    expect(DEFAULT_KEYMAP.nudgeBack).toEqual([])
    expect(DEFAULT_KEYMAP.toggleFilmstrip).toEqual([])
  })
})
