import { describe, expect, it } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import { groupAccepts, groupMovePlan, groupSnapPoints, moveGroup, setGroupLength, setGroupStart } from '../src/shared/editor/groupMove'
import type { ItemKey } from '../src/shared/editor/multiSelect'
import type { Project } from '../src/shared/types'
import { chapter, freeze, p20, shape, spot, text, title, zoom } from './groupFixture'

/* Moving several items together (docs/design/multi-select.md §4.8, §4.9, §10.1 G1-G9, G-PERF). P20: clips 0-8 and 10-20. */

const times = (p: Project, key: ItemKey): { start: number; end: number } => {
  const [kind, id] = key.split(':')
  if (kind === 'chapter') {
    const t = p.chapters!.find((c) => c.id === id)!.t
    return { start: t, end: t }
  }
  if (kind === 'freeze') {
    const at = p.freezes!.find((f) => f.id === id)!.at
    return { start: at, end: at }
  }
  const list = { zoom: p.zooms, annotation: p.annotations, shape: p.shapes, spotlight: p.spotlights, title: p.titles }[kind]!
  const x = list.find((i) => i.id === id)!
  return { start: x.start, end: x.end }
}

describe('G1: text, shapes, spotlights and title cards stop at the recording ends', () => {
  const p = p20({ annotations: [text('a1', 1, 3)], shapes: [shape('s1', 'rect', 4, 6)], titles: [title('t1', 15, 18)], spotlights: [spot('l1', 9, 10)] })
  const keys: ItemKey[] = ['annotation:a1', 'shape:s1', 'title:t1', 'spotlight:l1']
  const plan = groupMovePlan(p, keys)
  it('limits the delta by the first start and the last end', () => {
    expect([plan.min, plan.max, plan.minWhy, plan.maxWhy]).toEqual([-1, 2, 'start', 'end'])
    expect(plan.span).toEqual({ start: 1, end: 18 })
  })
  it('lands the edge items exactly on 0 and on the end, with the spacing kept', () => {
    const left = setGroupStart(p, keys, -5)
    expect(times(left.project, 'annotation:a1').start).toBe(0)
    expect(times(left.project, 'shape:s1')).toEqual({ start: 3, end: 5 })
    expect([left.moved, left.stopped]).toEqual([-1, 'start'])
    const right = setGroupStart(p, keys, 30)
    expect(times(right.project, 'title:t1').end).toBe(20)
    expect(times(right.project, 'annotation:a1')).toEqual({ start: 3, end: 5 })
    expect([right.moved, right.stopped]).toEqual([2, 'end'])
  })
})

describe('G2: zooms', () => {
  it('an unselected zoom between two selected zooms bounds both directions', () => {
    const p = p20({ zooms: [zoom('z1', 1, 2), zoom('z2', 3, 4), zoom('z3', 5, 6)] })
    const plan = groupMovePlan(p, ['zoom:z1', 'zoom:z3'])
    expect([plan.min, plan.max]).toEqual([-1, 1])
    expect(plan.maxWhy).toBe('zoom')
    expect(plan.minWhy).toBe('start')
    // z3 cannot move earlier than z2's end allows: 5 - 4.
    const tight = groupMovePlan(p20({ zooms: [zoom('z1', 2, 3), zoom('z2', 3.5, 4), zoom('z3', 4.25, 6)] }), ['zoom:z1', 'zoom:z3'])
    expect([tight.min, tight.max, tight.minWhy, tight.maxWhy]).toEqual([-0.25, 0.5, 'zoom', 'zoom'])
  })
  it('an outside obstacle stops the group with the moving edge exactly on its edge', () => {
    const p = p20({ zooms: [zoom('z1', 1, 2), zoom('z2', 4, 5), zoom('z3', 12, 14)] })
    const r = setGroupStart(p, ['zoom:z1', 'zoom:z2'], 100)
    expect(times(r.project, 'zoom:z2').end).toBe(12)
    expect(times(r.project, 'zoom:z2').start - times(r.project, 'zoom:z1').start).toBe(3)
    expect(r.stopped).toBe('zoom')
  })
  it('two touching selected zooms move together', () => {
    const p = p20({ zooms: [zoom('z1', 1, 2), zoom('z2', 2, 3)] })
    const plan = groupMovePlan(p, ['zoom:z1', 'zoom:z2'])
    expect([plan.min, plan.max]).toEqual([-1, 17])
    const q = moveGroup(p, plan, 4)
    expect([times(q, 'zoom:z1'), times(q, 'zoom:z2')]).toEqual([
      { start: 5, end: 6 },
      { start: 6, end: 7 }
    ])
  })
})

describe('G3: the interval always contains 0', () => {
  it('even for overlapping (corrupt) zooms', () => {
    const p = p20({ zooms: [zoom('z1', 1, 4), zoom('z2', 3, 6), zoom('z3', 2, 5)] })
    const plan = groupMovePlan(p, ['zoom:z1'])
    expect(plan.min).toBeLessThanOrEqual(0)
    expect(plan.max).toBeGreaterThanOrEqual(0)
    const out = groupMovePlan(p20({ annotations: [text('a1', -1, 21)] }), ['annotation:a1'])
    expect([out.min, out.max, out.minWhy]).toEqual([0, 0, 'full'])
  })
})

describe('G4: freeze frames stay in their clip', () => {
  it('an active freeze: [c.start - at, c.end - 0.001 - at]', () => {
    const plan = groupMovePlan(p20({ freezes: [freeze('f1', 5)] }), ['freeze:f1'])
    expect(plan.min).toBe(-5)
    expect(plan.max).toBeCloseTo(7.999 - 5, 12)
    expect([plan.minWhy, plan.maxWhy]).toEqual(['freeze-clip', 'freeze-clip'])
    const late = groupMovePlan(p20({ freezes: [freeze('f1', 12)] }), ['freeze:f1'])
    expect(late.min).toBe(-2)
  })
  it('a freeze at the edit end can only move earlier, within the last clip', () => {
    const plan = groupMovePlan(p20({ freezes: [freeze('f1', 20)] }), ['freeze:f1'])
    expect([plan.min, plan.max]).toEqual([-10, 0])
  })
  it('a freeze whose frame is cut pins the group', () => {
    const plan = groupMovePlan(p20({ freezes: [freeze('f1', 9)], annotations: [text('a1', 1, 2)] }), ['freeze:f1', 'annotation:a1'])
    expect([plan.min, plan.max, plan.minWhy, plan.maxWhy]).toEqual([0, 0, 'freeze-in-cut', 'freeze-in-cut'])
  })
})

describe('G5: groupAccepts', () => {
  it('refuses a delta that puts a selected freeze on an unselected freeze', () => {
    const p = p20({ freezes: [freeze('f1', 2), freeze('f2', 4)] })
    const plan = groupMovePlan(p, ['freeze:f1'])
    expect(groupAccepts(p, plan, 2)).toBe(false)
    expect(groupAccepts(p, plan, 2 + 1 / 240)).toBe(false)
    expect(groupAccepts(p, plan, 1)).toBe(true)
  })
  it('accepts two selected freezes 1 s apart moved by +1 s and -1 s, thanks to the order', () => {
    const p = p20({ freezes: [freeze('f1', 2), freeze('f2', 3)] })
    const plan = groupMovePlan(p, ['freeze:f1', 'freeze:f2'])
    expect(plan.freezes).toEqual(['f1', 'f2'])
    expect(groupAccepts(p, plan, 1)).toBe(true)
    expect(groupAccepts(p, plan, -1)).toBe(true)
    const q = moveGroup(p, plan, 1)
    expect(q.freezes!.map((f) => f.at)).toEqual([3, 4])
    const r = moveGroup(p, plan, -1)
    expect(r.freezes!.map((f) => f.at)).toEqual([1, 2])
  })
  it('at 60 fps, moved anchors are frame starts in whole ms', () => {
    const p = p20({ freezes: [freeze('f1', 2)], annotations: [text('a1', 1, 2)] })
    const plan = groupMovePlan(p, ['freeze:f1', 'annotation:a1'])
    const q = moveGroup(p, plan, 0.123)
    const at = q.freezes![0].at
    expect(Math.round(at * 1000) / 1000).toBe(at)
    // The start of the frame the moved anchor falls in (2.123 s: frame 127 starts at 2.11666… s, stored as 2.117).
    expect(at).toBe(2.117)
    expect(Math.abs(at - (2 + 0.123))).toBeLessThan(1 / 60)
    expect(times(q, 'annotation:a1').start).toBe(1.123)
  })
})

describe('G6: moveGroup', () => {
  const p = p20({ zooms: [zoom('z1', 1, 2, { auto: true, anchor: { t: 1.2, x: 0.3, y: 0.4 } })], annotations: [text('a1', 3, 4)], chapters: [chapter('h1', 6)] })
  const keys: ItemKey[] = ['zoom:z1', 'annotation:a1', 'chapter:h1']
  const plan = groupMovePlan(p, keys)
  it('a zero delta returns the same project', () => {
    expect(moveGroup(p, plan, 0)).toBe(p)
  })
  it('exact writes the snapped edge as the target, and its owner keeps its length', () => {
    const q = moveGroup(p, plan, 0.4999999999, { from: 4, to: 4.5 })
    expect(times(q, 'annotation:a1')).toEqual({ start: 3.5, end: 4.5 })
    expect(times(q, 'annotation:a1').end).toBe(4.5)
    expect(times(q, 'chapter:h1').start).toBe(6 + 0.4999999999)
  })
  it('zooms come out yours and keep their anchor', () => {
    const q = moveGroup(p, plan, 1)
    expect(q.zooms[0]).toMatchObject({ start: 2, end: 3, auto: false, anchor: { t: 1.2, x: 0.3, y: 0.4 } })
    expect(q.chapters![0].t).toBe(7)
  })
  it('moving back to the press times during a drag is the same project again', () => {
    const q = moveGroup(p, plan, 1)
    const back = moveGroup(q, plan, 1)
    expect(back).toBe(q)
  })
})

describe('G7: groupSnapPoints', () => {
  it('puts the grabbed item first and removes repeats', () => {
    const p = p20({ annotations: [text('a1', 1, 3), text('a2', 5, 7)], chapters: [chapter('h1', 6)] })
    const plan = groupMovePlan(p, ['annotation:a1', 'annotation:a2', 'chapter:h1'])
    expect(groupSnapPoints(plan, 'annotation:a2')).toEqual([5, 7, 1])
    expect(groupSnapPoints(plan, 'chapter:h1')).toEqual([6, 1, 7])
  })
})

describe('G8: setGroupStart', () => {
  it('moves by t - start, clamped, with the reason', () => {
    const p = p20({ annotations: [text('a1', 2, 3)], titles: [title('t1', 5, 18)] })
    const r = setGroupStart(p, ['annotation:a1', 'title:t1'], 3.5)
    expect([r.moved, r.stopped]).toEqual([1.5, null])
    expect(times(r.project, 'title:t1')).toEqual({ start: 6.5, end: 19.5 })
    const far = setGroupStart(p, ['annotation:a1', 'title:t1'], 9)
    expect([far.moved, far.stopped]).toEqual([2, 'end'])
  })
  it('a refused freeze delta gives no change and freeze-taken', () => {
    const p = p20({ freezes: [freeze('f1', 2), freeze('f2', 4)], annotations: [text('a1', 1, 2)] })
    const r = setGroupStart(p, ['freeze:f1', 'annotation:a1'], 3)
    expect(r).toEqual({ project: p, moved: 0, stopped: 'freeze-taken' })
  })
})

describe('G9: setGroupLength', () => {
  it('a zoom stops at the next zoom and at 0.6 s, and becomes yours', () => {
    const p = p20({ zooms: [zoom('z1', 1, 2, { auto: true }), zoom('z2', 3, 4), zoom('z3', 6, 7)] })
    const long = setGroupLength(p, ['zoom:z1', 'zoom:z2'], 2.5)
    expect(times(long.project, 'zoom:z1')).toEqual({ start: 1, end: 3 })
    expect(times(long.project, 'zoom:z2')).toEqual({ start: 3, end: 5.5 })
    expect(long.clamped).toBe(1)
    expect(long.project.zooms[0].auto).toBe(false)
    const short = setGroupLength(p, ['zoom:z1'], 0.1)
    expect(times(short.project, 'zoom:z1').end - 1).toBeCloseTo(0.6, 12)
    expect(short.clamped).toBe(1)
  })
  it('text stops at 0.3 s, a title card at 0.5 s; chapters and freezes are left alone', () => {
    const p = p20({ annotations: [text('a1', 1, 2)], titles: [title('t1', 4, 6)], chapters: [chapter('h1', 9)], freezes: [freeze('f1', 5)] })
    const r = setGroupLength(p, ['annotation:a1', 'title:t1', 'chapter:h1', 'freeze:f1'], 0.1)
    expect(times(r.project, 'annotation:a1').end).toBeCloseTo(1.3, 12)
    expect(times(r.project, 'title:t1').end).toBeCloseTo(4.5, 12)
    expect(r.clamped).toBe(2)
    expect(r.project.chapters).toBe(p.chapters)
    expect(r.project.freezes).toBe(p.freezes)
    const same = setGroupLength(p, ['annotation:a1'], 1)
    expect(same).toEqual({ project: p, clamped: 0 })
  })
  it('shapes and spotlights stop at 0.3 s and at the end of the recording', () => {
    const p = p20({ shapes: [shape('s1', 'arrow', 18, 19)], spotlights: [spot('l1', 2, 3)] })
    const r = setGroupLength(p, ['shape:s1', 'spotlight:l1'], 5)
    expect(times(r.project, 'shape:s1')).toEqual({ start: 18, end: 20 })
    expect(times(r.project, 'spotlight:l1')).toEqual({ start: 2, end: 7 })
    expect(r.clamped).toBe(1)
  })
})

describe('one undo step per group action', () => {
  it('a drag of several moves inside one gesture is one step', () => {
    const p = p20({ annotations: [text('a1', 1, 2)], zooms: [zoom('z1', 3, 4)] })
    const store = new EditStore(p)
    const plan = groupMovePlan(p, ['annotation:a1', 'zoom:z1'])
    store.beginGesture()
    for (const d of [0.1, 0.5, 1, 1.5]) store.update((q) => moveGroup(q, plan, d), 'group-move:1')
    store.endGesture()
    expect(times(store.state, 'zoom:z1')).toEqual({ start: 4.5, end: 5.5 })
    store.undo()
    expect(store.state).toBe(p)
  })
})

describe('G-PERF', () => {
  it('plans and moves 1000 selected items among 2000 quickly', () => {
    const annotations = Array.from({ length: 1000 }, (_, i) => text(`a${i}`, (i % 100) * 0.1, (i % 100) * 0.1 + 0.5))
    const shapes = Array.from({ length: 1000 }, (_, i) => shape(`s${i}`, 'rect', (i % 100) * 0.1 + 1, (i % 100) * 0.1 + 2))
    const p = p20({ annotations, shapes })
    const keys = annotations.map((a) => `annotation:${a.id}` as ItemKey)
    // The best of five runs, so a pause of the test machine during one run does not decide it
    // (one run takes 50 to 100 ms, over 300 ms under load; a move that is quadratic in the items takes seconds).
    let ms = Infinity
    let q = p
    for (let run = 0; run < 5; run++) {
      const begin = performance.now()
      const plan = groupMovePlan(p, keys)
      q = p
      for (let i = 0; i < 1000; i++) q = moveGroup(q, plan, (i % 50) * 0.01)
      ms = Math.min(ms, performance.now() - begin)
    }
    expect(ms).toBeLessThan(250)
    expect(q.shapes).toBe(p.shapes)
  })
})
