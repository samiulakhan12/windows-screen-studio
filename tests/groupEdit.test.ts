import { describe, expect, it } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import {
  applyField,
  copyLook,
  deleteItems,
  fieldsFor,
  fieldValue,
  GROUP_FIELDS,
  lookClassOf,
  lookLabel,
  mapItems,
  pasteLook,
  sharedValue,
  type FieldCtx,
  type GroupField
} from '../src/shared/editor/groupEdit'
import type { ItemKey } from '../src/shared/editor/multiSelect'
import { HIGHLIGHT_COLORS, SHAPE_COLORS } from '../src/shared/editor/shapes'
import { zoomInView } from '../src/shared/engine/crop'
import { DEFAULT_ZOOM_STYLE, zoomTargetScale } from '../src/shared/engine/zoom'
import type { Project } from '../src/shared/types'
import { chapter, freeze, p20, shape, spot, text, title, zoom } from './groupFixture'

/* Editing several items together (docs/design/multi-select.md §4.9-4.12, §10.1 E1-E10). */

const ctx: FieldCtx = { crop: null, cursorValid: true, style: DEFAULT_ZOOM_STYLE, background: { type: 'color', color: '#202020' } }
const field = (id: string): GroupField => GROUP_FIELDS.find((f) => f.id === id)!
const set = (p: Project, id: string, keys: ItemKey[], v: unknown, c: FieldCtx = ctx): Project => applyField(p, field(id), keys, v, c).project

describe('E1: sharedValue', () => {
  it('numbers are equal within 1e-6, else Mixed (with the first value)', () => {
    expect(sharedValue([0.5, 0.5000001])).toEqual({ mixed: false, value: 0.5 })
    expect(sharedValue([0.5, 0.501])).toEqual({ mixed: true, value: 0.5 })
    expect(sharedValue([])).toBeNull()
    expect(sharedValue([undefined, undefined])).toEqual({ mixed: false, value: undefined })
    expect(sharedValue([undefined, 0])).toEqual({ mixed: true, value: undefined })
  })
  it('the zoom level within 1e-3, colours in lower case', () => {
    const p = p20({ zooms: [zoom('z1', 1, 2, { scale: 2 }), zoom('z2', 3, 4, { scale: 2.0005 })], shapes: [shape('s1', 'rect', 1, 2, { color: '#FF3B30' }), shape('s2', 'rect', 1, 2, { color: '#ff3b30' })] })
    expect(fieldValue(p, field('zoom.level'), ['zoom:z1', 'zoom:z2'], ctx)).toEqual({ mixed: false, value: 2 })
    expect(fieldValue(p, field('mark.color'), ['shape:s1', 'shape:s2'], ctx)?.mixed).toBe(false)
  })
})

describe('E2: applyField returns the same project when no value changes', () => {
  it('for list items and for freezes', () => {
    const p = p20({ annotations: [text('a1', 1, 2, { size: 0.05 }), text('a2', 3, 4, { size: 0.05 })], freezes: [freeze('f1', 5)] })
    expect(set(p, 'text.size', ['annotation:a1', 'annotation:a2'], 0.05)).toBe(p)
    expect(set(p, 'freeze.length', ['freeze:f1'], 2)).toBe(p)
    expect(mapItems(p, 'annotation', new Set(['a1']), (a) => a)).toBe(p)
  })
  it('changes only the targets, in one result', () => {
    const p = p20({ annotations: [text('a1', 1, 2), text('a2', 3, 4), text('a3', 5, 6)] })
    const r = applyField(p, field('text.size'), ['annotation:a1', 'annotation:a3'], 0.1, ctx)
    expect(r.applied).toBe(2)
    expect(r.project.annotations.map((a) => a.size)).toEqual([0.1, p.annotations[1].size, 0.1])
    expect(r.project.annotations[1]).toBe(p.annotations[1])
  })
})

describe('E3: zoom level', () => {
  it('goes through setZoomLevelInView: with a crop, and for a region zoom; zooms become yours', () => {
    const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
    const region = zoom('z2', 3, 4, { auto: true, focus: { mode: 'region', x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, scale: 5 })
    const p = p20({ zooms: [zoom('z1', 1, 2, { auto: true }), region], crop })
    const c = { ...ctx, crop }
    const q = set(p, 'zoom.level', ['zoom:z1', 'zoom:z2'], 1.5, c)
    for (const z of q.zooms) {
      expect(zoomTargetScale(zoomInView(crop, z))).toBeCloseTo(1.5, 6)
      expect(z.auto).toBe(false)
    }
    expect(q.zooms[1].focus.mode).toBe('region')
  })
})

describe('E4: zoom focus', () => {
  it('Fixed point keeps where each zoom looks; Follow cursor sets the shown level', () => {
    const p = p20({
      zooms: [
        zoom('z1', 1, 2, { focus: { mode: 'cursor' }, scale: 2.5 }),
        zoom('z2', 3, 4, { focus: { mode: 'region', x: 0.2, y: 0.4, w: 0.2, h: 0.2 }, scale: 5 }),
        zoom('z3', 5, 6, { focus: { mode: 'fixed', x: 0.7, y: 0.1 } })
      ]
    })
    const c = { ...ctx, focusFor: () => ({ x: 0.6, y: 0.3 }) }
    const q = set(p, 'zoom.focus', ['zoom:z1', 'zoom:z2', 'zoom:z3'], 'fixed', c)
    expect(q.zooms[0].focus).toEqual({ mode: 'fixed', x: 0.6, y: 0.3 })
    expect(q.zooms[1].focus).toMatchObject({ mode: 'fixed' })
    expect((q.zooms[1].focus as { x: number }).x).toBeCloseTo(0.3, 12)
    expect((q.zooms[1].focus as { y: number }).y).toBeCloseTo(0.5, 12)
    expect(q.zooms[1].scale).toBe(5)
    expect(q.zooms[2]).toBe(p.zooms[2])
    const back = set(q, 'zoom.focus', ['zoom:z1', 'zoom:z2'], 'cursor', c)
    expect(back.zooms[1]).toMatchObject({ focus: { mode: 'cursor' }, scale: 5, auto: false })
    expect(fieldValue(p, field('zoom.focus'), ['zoom:z1', 'zoom:z2'], ctx)?.mixed).toBe(true)
  })
})

describe('E5: mark shapes', () => {
  const p = p20({ shapes: [shape('s1', 'rect', 1, 2, { fill: false }), shape('s2', 'arrow', 1, 2), shape('s3', 'highlight', 1, 2), shape('s4', 'blur', 1, 2)] })
  const marks: ItemKey[] = ['shape:s1', 'shape:s2', 'shape:s3', 'shape:s4']
  it('Filled applies only to boxes and ellipses; Line width is checked after Filled', () => {
    const sections = fieldsFor(p, marks)
    const mark = sections.find((s) => s.cls === 'mark')!
    expect(mark.keys).toEqual(['shape:s1', 'shape:s2', 'shape:s3'])
    expect(mark.fields.find((f) => f.field.id === 'mark.fill')!.targets).toEqual(['shape:s1'])
    expect(mark.fields.find((f) => f.field.id === 'mark.strokeWidth')!.targets).toEqual(['shape:s1', 'shape:s2'])
    const filled = set(p, 'mark.fill', marks, true)
    expect(filled.shapes!.map((s) => s.fill)).toEqual([true, false, false, false])
    const widths = set(filled, 'mark.strokeWidth', marks, 12)
    expect(widths.shapes!.map((s) => s.strokeWidth)).toEqual([p.shapes![0].strokeWidth, 12, p.shapes![2].strokeWidth, p.shapes![3].strokeWidth])
  })
  it('the colour presets are the highlight colours when every target is a highlight', () => {
    const color = field('mark.color')
    expect(color.presets!([p.shapes![2]])).toBe(HIGHLIGHT_COLORS)
    expect(color.presets!([p.shapes![0], p.shapes![2]])).toBe(SHAPE_COLORS)
    expect(set(p, 'mark.color', marks, '#0A84FF').shapes!.map((s) => s.color)).toEqual(['#0a84ff', '#0a84ff', '#0a84ff', p.shapes![3].color])
  })
})

describe('E6: privacy kind and a title card colour', () => {
  it('Effect applies only to blur and pixelate', () => {
    const p = p20({ shapes: [shape('s1', 'rect', 1, 2), shape('s2', 'blur', 1, 2), shape('s3', 'pixelate', 1, 2)] })
    const q = set(p, 'privacy.kind', ['shape:s1', 'shape:s2', 'shape:s3'], 'pixelate')
    expect(q.shapes!.map((s) => s.kind)).toEqual(['rect', 'pixelate', 'pixelate'])
    expect(lookClassOf(p, 'shape:s1')).toBe('mark')
    expect(lookClassOf(p, 'shape:s2')).toBe('privacy')
  })
  it("a title card's Colour applies only to solid cards, and its row shows only when every card is solid", () => {
    const p = p20({ titles: [title('t1', 1, 2, { background: 'solid' }), title('t2', 3, 4, { background: 'blur' })] })
    const q = set(p, 'title.color', ['title:t1', 'title:t2'], '#7c3aed')
    expect(q.titles!.map((c) => c.color)).toEqual(['#7c3aed', undefined])
    const rows = (x: Project): string[] => fieldsFor(x, ['title:t1', 'title:t2'])[0].fields.map((f) => f.field.id)
    expect(rows(p)).not.toContain('title.color')
    expect(rows(set(p, 'title.background', ['title:t1', 'title:t2'], 'solid'))).toContain('title.color')
  })
})

describe('E7: freeze frames', () => {
  it('keeping the sound is refused at the edit end and counted; lengths go through tenths', () => {
    const p = p20({ freezes: [freeze('f1', 5), freeze('f2', 20)] })
    const r = applyField(p, field('freeze.sound'), ['freeze:f1', 'freeze:f2'], 'continue', ctx)
    expect(r.applied).toBe(1)
    expect(r.refused).toBe(1)
    expect(r.project.freezes!.map((f) => f.sound)).toEqual(['continue', 'pause'])
    const q = set(p, 'freeze.length', ['freeze:f1', 'freeze:f2'], 3.14)
    expect(q.freezes!.map((f) => f.length)).toEqual([3.1, 3.1])
  })
})

describe('E8: one undo step', () => {
  it('a field written to 3 items is one undo step; slider moves with one key in a gesture are one step', () => {
    const p = p20({ annotations: [text('a1', 1, 2), text('a2', 3, 4), text('a3', 5, 6)] })
    const store = new EditStore(p)
    const keys: ItemKey[] = ['annotation:a1', 'annotation:a2', 'annotation:a3']
    store.update((q) => set(q, 'text.style', keys, 'title'))
    expect(store.state.annotations.every((a) => a.style === 'title')).toBe(true)
    store.undo()
    expect(store.state).toBe(p)
    store.beginGesture()
    for (const v of [0.06, 0.07, 0.08]) store.update((q) => set(q, 'text.size', keys, v), 'group-field:text.size:1')
    store.endGesture()
    expect(store.state.annotations.map((a) => a.size)).toEqual([0.08, 0.08, 0.08])
    store.undo()
    expect(store.state).toBe(p)
  })
})

describe('E9: deleteItems', () => {
  const p = p20({
    zooms: [zoom('z1', 1, 2), zoom('z2', 3, 4)],
    annotations: [text('a1', 1, 2)],
    shapes: [shape('s1', 'rect', 1, 2)],
    spotlights: [spot('l1', 1, 2)],
    titles: [title('t1', 1, 2)],
    chapters: [chapter('h1', 3)],
    freezes: [freeze('f1', 5)]
  })
  it('removes from every list in one result, and drops the freezes key with the last freeze', () => {
    const q = deleteItems(p, ['zoom:z1', 'annotation:a1', 'shape:s1', 'spotlight:l1', 'title:t1', 'chapter:h1', 'freeze:f1'])
    expect(q.zooms.map((z) => z.id)).toEqual(['z2'])
    expect([q.annotations, q.shapes, q.spotlights, q.titles, q.chapters]).toEqual([[], [], [], [], []])
    expect('freezes' in q).toBe(false)
  })
  it('an empty key list returns the same project', () => {
    expect(deleteItems(p, [])).toBe(p)
    expect(deleteItems(p, ['zoom:gone'])).toBe(p)
  })
})

describe('E10: copy look and paste look', () => {
  it('copies and pastes every class', () => {
    const p = p20({
      zooms: [zoom('z1', 1, 2, { scale: 3, easing: 'bouncy', transition: 1.2 }), zoom('z2', 3, 4, { auto: true })],
      annotations: [text('a1', 1, 2, { style: 'title', size: 0.07 }), text('a2', 3, 4)],
      shapes: [shape('s1', 'rect', 1, 2, { color: '#0a84ff', fill: true }), shape('s2', 'ellipse', 1, 2), shape('s3', 'blur', 1, 2, { strength: 0.9 }), shape('s4', 'pixelate', 1, 2)],
      spotlights: [spot('l1', 1, 2, { dim: 0.9, shape: 'rect' }), spot('l2', 3, 4)],
      titles: [title('t1', 1, 2, { background: 'solid', color: '#e11d48', style: 'big' }), title('t2', 3, 4)],
      freezes: [freeze('f1', 5, { length: 4, sound: 'continue' }), freeze('f2', 12)]
    })
    const pairs: [ItemKey, ItemKey][] = [
      ['zoom:z1', 'zoom:z2'],
      ['annotation:a1', 'annotation:a2'],
      ['shape:s1', 'shape:s2'],
      ['shape:s3', 'shape:s4'],
      ['spotlight:l1', 'spotlight:l2'],
      ['title:t1', 'title:t2'],
      ['freeze:f1', 'freeze:f2']
    ]
    for (const [from, to] of pairs) {
      const look = copyLook(p, from, ctx)!
      const r = pasteLook(p, [to], look, ctx)
      expect(r.applied, from).toBe(1)
      expect(copyLook(r.project, to, ctx)!.values, `${from} → ${to}`).toEqual(look.values)
    }
    const zl = copyLook(p, 'zoom:z1', ctx)!
    expect(zl.values).toEqual({ 'zoom.level': 3, 'zoom.easing': 'bouncy', 'zoom.transition': 1.2 })
    const z = pasteLook(p, ['zoom:z2'], zl, ctx).project.zooms[1]
    expect(z).toMatchObject({ scale: 3, easing: 'bouncy', transition: 1.2, auto: false })
    expect(lookLabel(copyLook(p, 'annotation:a1', ctx)!)).toBe('Text: Title style, 7 %')
    expect(copyLook(p, 'shape:s1', ctx)!.label).toBe('Box')
  })
  it('a mark look is not pasted onto privacy shapes (counted as other)', () => {
    const p = p20({ shapes: [shape('s1', 'arrow', 1, 2, { color: '#34c759' }), shape('s2', 'line', 1, 2), shape('s3', 'blur', 1, 2)] })
    const r = pasteLook(p, ['shape:s2', 'shape:s3'], copyLook(p, 'shape:s1', ctx)!, ctx)
    expect([r.applied, r.other]).toEqual([1, 1])
    expect(r.project.shapes![1].color).toBe('#34c759')
    expect(r.project.shapes![2]).toBe(p.shapes![2])
  })
  it('an identical look returns the same project; a chapter has no look', () => {
    const p = p20({ annotations: [text('a1', 1, 2), text('a2', 3, 4)], chapters: [chapter('h1', 3)] })
    expect(pasteLook(p, ['annotation:a2'], copyLook(p, 'annotation:a1', ctx)!, ctx).project).toBe(p)
    expect(copyLook(p, 'chapter:h1', ctx)).toBeNull()
    expect(lookClassOf(p, 'chapter:h1')).toBeNull()
  })
})
