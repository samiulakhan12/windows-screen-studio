import { describe, expect, it } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import { copyItems, duplicateItems, pasteItems, pasteNotice, type PasteResult } from '../src/shared/editor/groupClipboard'
import type { ItemKey } from '../src/shared/editor/multiSelect'
import { MAX_FREEZES } from '../src/shared/engine/freeze'
import { chapter, freeze, p20, shape, text, title, zoom } from './groupFixture'

/* Copy, paste and duplicate (docs/design/multi-select.md §4.11, §10.1 C1-C8). P20: clips 0-8 and 10-20. */

const newKeys = (r: PasteResult): string[] => r.keys.map((k) => k.split(':')[0])

describe('C1: paste time', () => {
  const p = p20({ annotations: [text('a1', 1, 3)], shapes: [shape('s1', 'rect', 2, 4)] })
  const clip = copyItems(p, ['annotation:a1', 'shape:s1'])!
  it('keeps the relative times', () => {
    expect([clip.origin, clip.span]).toEqual([1, 3])
    const r = pasteItems(p, clip, 12)
    expect(r.at).toBe(12)
    expect(r.movedBack).toBe(false)
    expect(r.project.annotations[1]).toMatchObject({ start: 12, end: 14 })
    expect(r.project.shapes![1]).toMatchObject({ start: 13, end: 15 })
  })
  it('is moved back to duration - span, and says so', () => {
    const r = pasteItems(p, clip, 19)
    expect(r.at).toBe(17)
    expect(r.movedBack).toBe(true)
    expect(r.project.shapes![1].end).toBe(20)
  })
  it('a playhead in a cut pastes at the next kept frame', () => {
    expect(pasteItems(p, clip, 9).at).toBe(10)
  })
})

describe('C2: fresh ids and deep copies', () => {
  it('gives new unique ids, and later edits of the project do not change the clipboard', () => {
    const p = p20({ annotations: [text('a1', 1, 2)], titles: [title('t1', 3, 4)] })
    const clip = copyItems(p, ['annotation:a1', 'title:t1'])!
    p.annotations[0].text = 'changed'
    expect((clip.items[0].item as { text: string }).text).toBe('Add your text')
    const r1 = pasteItems(p, clip, 5)
    const r2 = pasteItems(r1.project, clip, 10)
    const ids = [...r1.keys, ...r2.keys, 'annotation:a1', 'title:t1']
    expect(new Set(ids).size).toBe(ids.length)
    expect(newKeys(r1)).toEqual(['annotation', 'title'])
  })
})

describe('C3: zooms', () => {
  it('a pasted zoom is yours, without the anchor', () => {
    const p = p20({ zooms: [zoom('z1', 1, 2, { auto: true, anchor: { t: 1.2, x: 0.5, y: 0.5 } })] })
    const r = pasteItems(p, copyItems(p, ['zoom:z1'])!, 5)
    expect(r.project.zooms[1]).toMatchObject({ start: 5, end: 6, auto: false })
    expect('anchor' in r.project.zooms[1]).toBe(false)
  })
  it('a start inside a zoom is skipped; a 1.4 s gap shortens a 3 s zoom; a 0.8 s gap skips it', () => {
    const p = p20({ zooms: [zoom('z1', 1, 4), zoom('z2', 12, 13), zoom('z3', 15, 16)] })
    const clip = copyItems(p, ['zoom:z1'])!
    const inside = pasteItems(p, clip, 12.5)
    expect(inside.skipped).toEqual([{ kind: 'zoom', why: 'zoom-taken' }])
    expect(inside.project).toBe(p)
    const gap = pasteItems(p, clip, 10.6)
    expect(gap.project.zooms.find((z) => z.start === 10.6)).toMatchObject({ end: 12 })
    expect(gap.shortened).toBe(1)
    const small = pasteItems(p, clip, 14.2)
    expect(small.skipped).toEqual([{ kind: 'zoom', why: 'zoom-taken' }])
  })
})

describe('C4: chapters', () => {
  it('within 0.1 s of a chapter, or past the end of the video, is skipped', () => {
    const p = p20({ chapters: [chapter('h1', 3, 'Intro'), chapter('h2', 6)] })
    const clip = copyItems(p, ['chapter:h1'])!
    expect(pasteItems(p, clip, 6.05).skipped).toEqual([{ kind: 'chapter', why: 'chapter-near' }])
    expect(pasteItems(p, clip, 19.99).skipped).toEqual([{ kind: 'chapter', why: 'chapter-end' }])
    const ok = pasteItems(p, clip, 12)
    expect(ok.project.chapters![2]).toMatchObject({ t: 12, title: 'Intro' })
  })
})

describe('C5: freeze frames', () => {
  const p = p20({ freezes: [freeze('f1', 2, { length: 1.5 }), freeze('f2', 12)] })
  const clip = copyItems(p, ['freeze:f1'])!
  it('cut, taken, frozen and full are skipped with their reason', () => {
    // A paste time in a cut moves to the next kept frame, so a cut frame comes from the group's spacing.
    const two = copyItems(p20({ freezes: [freeze('a', 1), freeze('b', 2)] }), ['freeze:a', 'freeze:b'])!
    const cut = pasteItems(p, two, 7)
    expect(cut.skipped).toEqual([{ kind: 'freeze', why: 'freeze-cut' }])
    expect(cut.project.freezes!.map((f) => f.at)).toEqual([2, 7, 12])
    expect(pasteItems(p, clip, 12).skipped).toEqual([{ kind: 'freeze', why: 'freeze-taken' }])
    const cont = p20({ freezes: [freeze('f1', 2, { sound: 'continue', length: 3 })] })
    expect(pasteItems(cont, copyItems(cont, ['freeze:f1'])!, 3).skipped).toEqual([{ kind: 'freeze', why: 'freeze-frozen' }])
    const many = p20({ freezes: Array.from({ length: MAX_FREEZES }, (_, i) => freeze(`f${i}`, 10 + i * 0.04)) })
    expect(pasteItems(many, copyItems(many, ['freeze:f0'])!, 1).skipped).toEqual([{ kind: 'freeze', why: 'freeze-full' }])
  })
  it('keeps its length and sound; a clipboard from another recording skips it', () => {
    const r = pasteItems(p, clip, 4)
    expect(r.project.freezes!.find((f) => f.at === 4)).toMatchObject({ length: 1.5, sound: 'pause' })
    expect(pasteItems({ ...p, id: 'other' }, clip, 4).skipped).toEqual([{ kind: 'freeze', why: 'freeze-other-recording' }])
  })
})

describe('C6: duplicate', () => {
  it('lands at origin + span', () => {
    const p = p20({ zooms: [zoom('z1', 1, 2)], annotations: [text('a1', 1.5, 3)] })
    const r = duplicateItems(p, ['zoom:z1', 'annotation:a1'])
    expect(r.at).toBe(3)
    expect(r.project.zooms[1]).toMatchObject({ start: 3, end: 4 })
    expect(r.project.annotations[1]).toMatchObject({ start: 3.5, end: 5 })
  })
  it('a single freeze lands at at + length; a group of chapters lands 1 s later', () => {
    const p = p20({ freezes: [freeze('f1', 2, { length: 2 })], chapters: [chapter('h1', 3), chapter('h2', 3.5)] })
    expect(duplicateItems(p, ['freeze:f1']).project.freezes!.map((f) => f.at)).toEqual([2, 4])
    const c = duplicateItems(p, ['chapter:h1', 'chapter:h2'])
    expect(c.project.chapters!.map((x) => x.t)).toEqual([3, 3.5, 4, 4.5])
  })
  it('repeated duplicates make a series', () => {
    let p = p20({ annotations: [text('a1', 1, 2)] })
    let keys: ItemKey[] = ['annotation:a1']
    for (let i = 0; i < 3; i++) {
      const r = duplicateItems(p, keys)
      p = r.project
      keys = r.keys
    }
    expect(p.annotations.map((a) => a.start)).toEqual([1, 2, 3, 4])
  })
})

describe('C7: one store update, the pasted items as the result', () => {
  it('a paste of several items is one undo step', () => {
    const p = p20({ annotations: [text('a1', 1, 2)], shapes: [shape('s1', 'rect', 2, 3)] })
    const store = new EditStore(p)
    let r: PasteResult | null = null
    store.update((q) => {
      r = pasteItems(q, copyItems(q, ['annotation:a1', 'shape:s1'])!, 10)
      return r.project
    })
    expect(r!.keys).toHaveLength(2)
    expect(r!.keys.every((k) => !['annotation:a1', 'shape:s1'].includes(k))).toBe(true)
    store.undo()
    expect(store.state).toBe(p)
  })
})

describe('C8: pasteNotice', () => {
  const base: PasteResult = { project: p20(), keys: ['zoom:a', 'zoom:b'] as ItemKey[], at: 52, movedBack: false, shortened: 0, skipped: [] }
  it('says what happened', () => {
    expect(pasteNotice(base, 2)).toBe('Pasted 2 items')
    expect(pasteNotice({ ...base, movedBack: true }, 2)).toBe('Pasted 2 items at 0:52.0 (moved back so they fit)')
    expect(
      pasteNotice(
        {
          ...base,
          skipped: [
            { kind: 'zoom', why: 'zoom-taken' },
            { kind: 'freeze', why: 'freeze-cut' }
          ]
        },
        4
      )
    ).toBe('Pasted 2 of 4: 1 zoom is already there, 1 freeze frame is in a cut')
    expect(pasteNotice({ ...base, shortened: 1 }, 2)).toBe('Pasted 2 items · 1 zoom was shortened to fit')
    expect(pasteNotice({ ...base, keys: [], skipped: [{ kind: 'zoom', why: 'zoom-taken' }, { kind: 'zoom', why: 'zoom-taken' }] }, 2)).toBe('Nothing pasted: 2 zooms are already there')
    expect(pasteNotice({ ...base, keys: ['zoom:a'] as ItemKey[] }, 1, 'Duplicated')).toBe('Duplicated 1 item')
  })
})
