import { describe, expect, it } from 'vitest'
import {
  extendTo,
  GROUP_KINDS,
  groupLabel,
  itemKey,
  kindCounts,
  NO_GROUP,
  parseItemKey,
  projectItems,
  rectsHit,
  selectAllStep,
  toggleKey,
  topmostHit,
  trackKeys,
  trackOfKind,
  unionKeys,
  validGroup,
  type ItemGroup,
  type ItemKey
} from '../src/shared/editor/multiSelect'
import { projectSnapSegments } from '../src/shared/editor/snapping'
import { chapter, freeze, p20, shape, spot, text, title, zoom } from './groupFixture'

/* The selection model of E-06 (docs/design/multi-select.md §4.1-4.4, §10.1 M1-M8). */

const ALL = p20({
  zooms: [zoom('z1', 1, 2), zoom('z2', 4, 5, { auto: true }), zoom('z3', 12, 14)],
  annotations: [text('a1', 1, 3), text('a2', 6, 7.5)],
  shapes: [shape('s1', 'rect', 2, 4), shape('s2', 'arrow', 2, 4), shape('s3', 'blur', 2, 4)],
  spotlights: [spot('l1', 3, 5)],
  titles: [title('t1', 15, 17)],
  chapters: [chapter('h1', 6)],
  freezes: [freeze('f1', 5)]
})

describe('M1: keys', () => {
  it('itemKey is the snapping owner key of every kind', () => {
    const owners = new Set(projectSnapSegments(ALL, { layouts: false }).map((s) => s.owner))
    for (const k of ['zoom:z1', 'annotation:a1', 'shape:s1', 'spotlight:l1', 'title:t1']) expect(owners.has(k), k).toBe(true)
    expect(itemKey('zoom', 'z1')).toBe('zoom:z1')
    expect(itemKey('annotation', 'a1')).toBe('annotation:a1')
    // Chapters and freezes: the chapter target's owner and FreezeMarks' exclude key.
    expect(itemKey('chapter', 'h1')).toBe('chapter:h1')
    expect(itemKey('freeze', 'f1')).toBe('freeze:f1')
  })

  it('parseItemKey reads them back, and nothing else', () => {
    for (const kind of GROUP_KINDS) expect(parseItemKey(itemKey(kind, 'x:y'))).toEqual({ kind, id: 'x:y' })
    expect(parseItemKey('caption:c1')).toBeNull()
    expect(parseItemKey('layout:l1')).toBeNull()
    expect(parseItemKey('clip:c0')).toBeNull()
    expect(parseItemKey('zoom:')).toBeNull()
    expect(parseItemKey('zoom')).toBeNull()
  })

  it('trackOfKind puts shapes and spotlights on one track', () => {
    expect(GROUP_KINDS.map(trackOfKind)).toEqual(['zoom', 'text', 'shapes', 'shapes', 'images', 'titles', 'chapters', 'freezes'])
  })
})

describe('M2: toggleKey', () => {
  it('a groupable single plus another item gives 2 keys, anchored on the new one', () => {
    expect(toggleKey([], 'zoom:z1', 'annotation:a1')).toEqual({ keys: ['zoom:z1', 'annotation:a1'], anchor: 'annotation:a1' })
  })
  it('without a groupable single (clip, caption, range: the caller passes null), the clicked key alone', () => {
    expect(toggleKey([], null, 'zoom:z2')).toEqual({ keys: ['zoom:z2'], anchor: 'zoom:z2' })
  })
  it('removing down to one leaves one key; toggling the only key leaves none', () => {
    expect(toggleKey(['zoom:z1', 'zoom:z2'], null, 'zoom:z2', 'zoom:z1')).toEqual({ keys: ['zoom:z1'], anchor: 'zoom:z1' })
    expect(toggleKey([], 'zoom:z1', 'zoom:z1')).toEqual({ keys: [], anchor: null })
  })
  it('removing the anchor makes the last remaining key the anchor; removing another keeps it', () => {
    const keys: ItemKey[] = ['zoom:z1', 'zoom:z2', 'annotation:a1']
    expect(toggleKey(keys, null, 'zoom:z1', 'zoom:z1')).toEqual({ keys: ['zoom:z2', 'annotation:a1'], anchor: 'annotation:a1' })
    expect(toggleKey(keys, null, 'zoom:z2', 'zoom:z1')).toEqual({ keys: ['zoom:z1', 'annotation:a1'], anchor: 'zoom:z1' })
  })
})

describe('M3: extendTo', () => {
  const items = projectItems(ALL)
  it('takes the run between the anchor and the clicked item on the same track, inclusive, shapes and spotlights interleaved', () => {
    // Shapes track: s1, s2, s3 at 2-4 (by key), then l1 at 3-5.
    expect(extendTo([], null, 'shape:s1', 'spotlight:l1', items)).toEqual({ keys: ['shape:s1', 'shape:s2', 'shape:s3', 'spotlight:l1'], anchor: 'shape:s1' })
    // Backwards too; the anchor stays.
    expect(extendTo(['shape:s3', 'zoom:z1'], 'shape:s3', null, 'shape:s1', items)).toEqual({ keys: ['shape:s3', 'zoom:z1', 'shape:s1', 'shape:s2'], anchor: 'shape:s3' })
  })
  it('on another track, or with no anchor, adds only the clicked key (which becomes the anchor)', () => {
    expect(extendTo(['zoom:z1', 'zoom:z2'], 'zoom:z2', null, 'annotation:a2', items)).toEqual({ keys: ['zoom:z1', 'zoom:z2', 'annotation:a2'], anchor: 'annotation:a2' })
    expect(extendTo([], null, null, 'title:t1', items)).toEqual({ keys: ['title:t1'], anchor: 'title:t1' })
  })
  it('never removes', () => {
    const r = extendTo(['zoom:z1', 'zoom:z3'], 'zoom:z1', null, 'zoom:z3', items)
    expect(r.keys).toEqual(['zoom:z1', 'zoom:z3', 'zoom:z2'])
    expect(r.anchor).toBe('zoom:z1')
  })
})

describe('M4: selectAllStep', () => {
  const items = projectItems(ALL)
  it('selects the track when it is not all selected', () => {
    expect(selectAllStep(items, [], 'zoom')).toEqual({ keys: ['zoom:z1', 'zoom:z2', 'zoom:z3'], scope: 'track' })
    expect(selectAllStep(items, ['zoom:z1'], 'zoom').scope).toBe('track')
  })
  it('selects everything when the track is all selected, null or empty', () => {
    expect(selectAllStep(items, ['zoom:z1', 'zoom:z2', 'zoom:z3'], 'zoom')).toEqual({ keys: items.map((x) => x.key), scope: 'all' })
    expect(selectAllStep(items, [], null).scope).toBe('all')
    const noTitles = projectItems({ ...ALL, titles: [] })
    expect(selectAllStep(noTitles, [], 'titles').scope).toBe('all')
    expect(items).toHaveLength(12)
  })
  it('none when the project has no groupable item', () => {
    expect(selectAllStep(projectItems(p20()), [], 'zoom')).toEqual({ keys: [], scope: 'none' })
  })
  it('freezes selects the freeze frames', () => {
    expect(selectAllStep(items, [], 'freezes')).toEqual({ keys: ['freeze:f1'], scope: 'track' })
    expect(trackKeys(items, 'chapters')).toEqual(['chapter:h1'])
  })
})

describe('M5: validGroup', () => {
  const g: ItemGroup = { keys: ['zoom:z1', 'annotation:a1', 'freeze:f1'], anchor: 'annotation:a1', stamp: 4 }
  it('is the same object when every key is valid', () => {
    expect(validGroup(g, ALL)).toBe(g)
  })
  it('drops keys of removed items, keeping the anchor when it is there', () => {
    const p = { ...ALL, zooms: ALL.zooms.filter((z) => z.id !== 'z1') }
    expect(validGroup(g, p)).toEqual({ keys: ['annotation:a1', 'freeze:f1'], anchor: 'annotation:a1', stamp: 4 })
  })
  it('collapses to one key, whose item becomes the single selection', () => {
    const p = { ...ALL, zooms: [], freezes: undefined }
    expect(validGroup(g, p)).toEqual({ keys: ['annotation:a1'], anchor: 'annotation:a1', stamp: 4 })
    expect(validGroup(g, { ...p, annotations: [] })).toBe(NO_GROUP)
  })
  it('NO_GROUP is a fast path', () => {
    expect(validGroup(NO_GROUP, ALL)).toBe(NO_GROUP)
  })
})

describe('M6: projectItems', () => {
  it('is ordered by start, then end, then key, whatever the stored order', () => {
    const a = projectItems(ALL).map((x) => x.key)
    const shuffled = projectItems({ ...ALL, shapes: [...ALL.shapes!].reverse(), zooms: [...ALL.zooms].reverse() }).map((x) => x.key)
    expect(shuffled).toEqual(a)
    expect(a.slice(0, 2)).toEqual(['zoom:z1', 'annotation:a1'])
    // Points: a chapter's and a freeze's start and end are their time.
    const f = projectItems(ALL).find((x) => x.key === 'freeze:f1')!
    expect([f.start, f.end, f.track]).toEqual([5, 5, 'freezes'])
  })
})

describe('M7: rectsHit and topmostHit', () => {
  const rects = [
    { key: 'zoom:z1' as ItemKey, x: 10, y: 0, w: 20, h: 10 },
    { key: 'freeze:f1' as ItemKey, x: 40, y: 0, w: 5, h: 5 },
    { key: 'freeze:f1' as ItemKey, x: 60, y: 0, w: 5, h: 5 },
    { key: 'annotation:a1' as ItemKey, x: 10, y: 20, w: 20, h: 10 }
  ]
  it('a touching edge counts', () => {
    expect(rectsHit(rects, { x0: 30, y0: 10, x1: 35, y1: 12 })).toEqual(['zoom:z1'])
    expect(rectsHit(rects, { x0: 0, y0: 30, x1: 9, y1: 40 })).toEqual([])
  })
  it('a key with two pieces is returned once, and the box may be drawn backwards', () => {
    expect(rectsHit(rects, { x0: 70, y0: 4, x1: 35, y1: 1 })).toEqual(['freeze:f1'])
    expect(rectsHit(rects, { x0: 0, y0: 0, x1: 100, y1: 100 })).toEqual(['zoom:z1', 'freeze:f1', 'annotation:a1'])
  })
  it('no hit gives []', () => {
    expect(rectsHit(rects, { x0: 200, y0: 200, x1: 300, y1: 300 })).toEqual([])
  })
  it('topmostHit returns the first box containing the point', () => {
    const boxes = [
      { key: 'annotation:a1' as ItemKey, x: 0, y: 0, w: 50, h: 50 },
      { key: 'shape:s1' as ItemKey, x: 0, y: 0, w: 100, h: 100 }
    ]
    expect(topmostHit(boxes, 10, 10)).toBe('annotation:a1')
    expect(topmostHit(boxes, 80, 80)).toBe('shape:s1')
    expect(topmostHit(boxes, 120, 80)).toBeNull()
  })
})

describe('M8: groupLabel', () => {
  it('counts kinds in a fixed order with their words', () => {
    expect(groupLabel(['annotation:a1', 'zoom:z1', 'zoom:z2', 'annotation:a2', 'zoom:z3'])).toBe('3 zooms · 2 text items')
    expect(groupLabel(['freeze:f1'])).toBe('1 freeze frame')
    expect(groupLabel(['title:t1', 'chapter:h1', 'chapter:h2', 'spotlight:l1', 'shape:s1'])).toBe('1 shape · 1 spotlight · 1 title card · 2 chapters')
    expect(kindCounts(['zoom:z1', 'zoom:z2', 'freeze:f1'])).toEqual({ zoom: 2, freeze: 1 })
  })
  it('unionKeys keeps order and drops repeats', () => {
    expect(unionKeys(['zoom:z1', 'zoom:z2'], ['zoom:z2', 'title:t1', 'title:t1'])).toEqual(['zoom:z1', 'zoom:z2', 'title:t1'])
  })
})
