import { describe, expect, it } from 'vitest'
import { buildSnapIndex, SNAP, snapGroup, type SnapSources, type SnapTarget, type SnapView } from '../src/shared/editor/snapping'
import type { Clip } from '../src/shared/types'

/* snapGroup: a group drag's snapping (docs/design/multi-select.md §4.8, §9.2, §10.1 S1-S4). New cases only; snapping.test.ts is unchanged. */

const clip = (id: string, start: number, end: number): Clip => ({ id, start, end, speed: 1 })
/** A cut at 4-6 of 15 s, and a chapter at 9. */
const SRC: SnapSources = {
  duration: 15,
  clips: [clip('c0', 0, 4), clip('c1', 6, 15)],
  clicks: [],
  chapters: [{ id: 'h1', t: 9, title: 'Demo' }],
  segments: [],
  freezes: [],
  playhead: null
}
const index = buildSnapIndex(SRC)
const view = (current: SnapTarget | null = null, more: Partial<SnapView> = {}): SnapView => ({ pxPerSec: 100, current, ...more })
const free = (d: number): number => d

describe('S1: catches through the grabbed edge and through an outer edge', () => {
  it('the grabbed item end (point 1) catches the cut at 4', () => {
    // Grabbed 1-3.96, group 0.5-8.
    const r = snapGroup(index, [1, 3.96, 0.5, 8], 0, view(), free)
    expect(r.target?.t).toBe(4)
    expect(r.delta).toBeCloseTo(0.04, 12)
    expect(r.exact).toEqual({ from: 3.96, to: 4 })
  })
  it('an outer edge (the group end) catches the chapter', () => {
    const r = snapGroup(index, [1, 2, 0.5, 8.96], 0, view(), free)
    expect(r.target?.label).toBe('Chapter · Demo')
    expect(r.exact).toEqual({ from: 8.96, to: 9 })
  })
})

describe('S2: on a tie the grabbed point wins (lower index)', () => {
  it('two points each 3 px from a target of the same kind', () => {
    // Point 0 at 5.97 (3 px before 6), point 2 at 4.03 (3 px after 4): both cut edges, same priority.
    const r = snapGroup(index, [5.97, 7, 4.03, 7.5], 0, view(), free)
    expect(r.exact?.from).toBe(5.97)
    expect(r.target?.t).toBe(6)
  })
})

describe('S3: falls back unsnapped', () => {
  it('when the clamp moves the snapped point off its target', () => {
    const r = snapGroup(index, [1, 3.96], 0.01, view(), (d) => Math.min(d, 0.02))
    expect(r).toEqual({ delta: 0.01, target: null, exact: null })
    expect(SNAP.exactS).toBe(1e-9)
  })
  it('when accept refuses the snapped delta', () => {
    const r = snapGroup(index, [1, 3.96], 0, view(), free, (d) => d < 0.03)
    expect(r).toEqual({ delta: 0, target: null, exact: null })
  })
  it('with nothing in reach, the clamped raw delta', () => {
    expect(snapGroup(index, [1, 2], 0.5, view(), (d) => Math.min(d, 0.3))).toEqual({ delta: 0.3, target: null, exact: null })
  })
})

describe('S4: hysteresis and the visible window', () => {
  it('a caught target holds out to 12 px, not past it', () => {
    const cut = index.targets.find((x) => x.t === 4)!
    // 10 px away (more than 8, less than 12): held only when it is the current target.
    expect(snapGroup(index, [1, 3.9], 0, view(cut), free).target?.t).toBe(4)
    expect(snapGroup(index, [1, 3.9], 0, view(), free).target).toBeNull()
    expect(snapGroup(index, [1, 3.87], 0, view(cut), free).target).toBeNull()
  })
  it('nothing outside the visible window catches', () => {
    expect(snapGroup(index, [1, 3.96], 0, view(null, { visible: { start: 0, end: 3.5 } }), free).target).toBeNull()
  })
})
