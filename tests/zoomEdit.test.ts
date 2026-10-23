import { describe, expect, it } from 'vitest'
import {
  clampZooms,
  dragZoomTimes,
  generateAutoZooms,
  insertZoom,
  MIN_NEW_ZOOM,
  MIN_ZOOM_LENGTH,
  regenerateAutoZooms,
  zoomDragBounds,
  ZOOM_TRANSITION
} from '../src/shared/engine/zoom'
import type { ClickEvent, ZoomSegment } from '../src/shared/types'

const seg = (id: string, start: number, end: number, extra: Partial<ZoomSegment> = {}): ZoomSegment => ({
  id,
  start,
  end,
  scale: 2,
  focus: { mode: 'cursor' },
  auto: false,
  ...extra
})

const click = (t: number, x = 0.5, y = 0.5, button: ClickEvent['button'] = 'left'): ClickEvent => ({ t, x, y, button })

describe('insertZoom (F09)', () => {
  it('never changes existing segments when the new zoom would overlap a later one', () => {
    // The audit's case: a tuned 3x fixed zoom at 3-4 s, playhead at 2 s.
    const user = seg('user', 3, 4, { scale: 3, focus: { mode: 'fixed', x: 0.2, y: 0.8 } })
    const r = insertZoom([user], 2, 10, { lead: ZOOM_TRANSITION })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.zooms.find((z) => z.id === 'user')).toEqual(user)
    const added = r.zooms.find((z) => z.id === r.id)!
    expect(added.end).toBeLessThanOrEqual(3)
    expect(added.start).toBeLessThanOrEqual(2)
    expect(added.end - added.start).toBeGreaterThanOrEqual(MIN_NEW_ZOOM)
  })

  it('keeps every other segment identical (ids, times, scale, focus)', () => {
    const zooms = [seg('a', 1, 2.5), seg('b', 5, 7, { scale: 2.6 }), seg('c', 12, 14, { auto: true })]
    const r = insertZoom(zooms, 9, 20, { lead: ZOOM_TRANSITION })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const z of zooms) expect(r.zooms.find((x) => x.id === z.id)).toEqual(z)
    const added = r.zooms.find((z) => z.id === r.id)!
    expect(added.start).toBeCloseTo(9 - ZOOM_TRANSITION)
    expect(added.end).toBeLessThanOrEqual(12)
    expect(r.zooms.map((z) => z.start)).toEqual([...r.zooms.map((z) => z.start)].sort((x, y) => x - y))
  })

  it('points at the existing zoom instead of adding inside it', () => {
    const r = insertZoom([seg('a', 5, 7)], 6, 20, { lead: ZOOM_TRANSITION })
    expect(r).toEqual({ ok: false, reason: 'inside', id: 'a' })
  })

  it('refuses when the free gap is too small', () => {
    const r = insertZoom([seg('a', 2, 5), seg('b', 5.5, 9)], 5.2, 20)
    expect(r).toEqual({ ok: false, reason: 'no-room' })
  })

  it('grows backwards when close to the end of the recording', () => {
    const r = insertZoom([], 9.8, 10, { lead: ZOOM_TRANSITION })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const z = r.zooms[0]
    expect(z.end).toBe(10)
    expect(z.start).toBeCloseTo(7)
  })

  it('uses the requested focus and scale', () => {
    const r = insertZoom([], 3, 10, { focus: { mode: 'fixed', x: 0.5, y: 0.5 }, scale: 1.5 })
    expect(r.ok && r.zooms[0].focus).toEqual({ mode: 'fixed', x: 0.5, y: 0.5 })
    expect(r.ok && r.zooms[0].scale).toBe(1.5)
  })
})

describe('zoom drag helpers', () => {
  it('bounds a drag between the neighbours', () => {
    const zooms = [seg('a', 1, 2), seg('b', 4, 6), seg('c', 9, 10)]
    expect(zoomDragBounds(zooms, 'b', 12)).toEqual({ lower: 2, upper: 9 })
    expect(dragZoomTimes({ start: 4, end: 6 }, 'move', 10, { lower: 2, upper: 9 })).toEqual({ start: 7, end: 9 })
    expect(dragZoomTimes({ start: 4, end: 6 }, 'start', 5, { lower: 2, upper: 9 }).start).toBeCloseTo(6 - MIN_ZOOM_LENGTH)
    expect(dragZoomTimes({ start: 4, end: 6 }, 'end', -10, { lower: 2, upper: 9 }).end).toBeCloseTo(4 + MIN_ZOOM_LENGTH)
  })

  it('clampZooms only clamps to the duration and never shifts neighbours', () => {
    const zooms = [seg('a', 1, 3), seg('b', 2.5, 4), seg('c', 9.5, 12), seg('d', 11, 12)]
    expect(clampZooms(zooms, 10).map((z) => [z.id, z.start, z.end])).toEqual([
      ['a', 1, 3],
      ['b', 2.5, 4],
      ['c', 9.5, 10]
    ])
  })
})

describe('auto zoom clicks (F04 defence, F27)', () => {
  it('ignores clicks outside the captured display', () => {
    expect(generateAutoZooms([click(3, 1.4, 0.5), click(8, 0.5, -0.2)], 20)).toEqual([])
    expect(generateAutoZooms([click(3, 1, 0)], 20)).toHaveLength(1)
  })

  it('regenerate replaces auto zooms and keeps user-edited ones', () => {
    const edited = seg('edited', 4, 7, { auto: false, scale: 3 })
    const stale = seg('stale', 15, 16, { auto: true })
    const r = regenerateAutoZooms([edited, stale], [click(5), click(12)], 20)
    expect(r.zooms.find((z) => z.id === 'edited')).toEqual(edited)
    expect(r.zooms.some((z) => z.id === 'stale')).toBe(false)
    // The click at 5 s is covered by the edited zoom, so only the 12 s zoom is new.
    expect(r.added).toBe(1)
    expect(r.removed).toBe(1)
    expect(r.kept).toBe(1)
    expect(r.zooms.filter((z) => z.auto)).toHaveLength(1)
  })

  it('regenerating twice is stable', () => {
    const once = regenerateAutoZooms([], [click(3), click(10)], 20).zooms
    const twice = regenerateAutoZooms(once, [click(3), click(10)], 20).zooms
    expect(twice.map((z) => [z.start, z.end])).toEqual(once.map((z) => [z.start, z.end]))
  })
})
