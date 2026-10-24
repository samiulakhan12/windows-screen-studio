import { describe, expect, it } from 'vitest'
import {
  clearZoomStyles,
  connectedZoomIds,
  connectToNext,
  disconnectFromNext,
  dragRegion,
  formatLevel,
  isConnectedToNext,
  levelForKey,
  MIN_REGION_SIDE,
  nextZoom,
  normalizeRegion,
  regionAround,
  regionFromPoints,
  setZoomLevel,
  setZoomRegion
} from '../src/shared/editor/zoomEdit'
import { cameraAt, connectGap, MIN_ZOOM_LENGTH, regionScale, zoomTargetScale } from '../src/shared/engine/zoom'
import type { ZoomSegment } from '../src/shared/types'

const seg = (id: string, start: number, end: number, extra: Partial<ZoomSegment> = {}): ZoomSegment => ({
  id,
  start,
  end,
  scale: 2,
  focus: { mode: 'fixed', x: 0.5, y: 0.5 },
  auto: true,
  ...extra
})

describe('zoom level shortcuts and presets', () => {
  it('maps number keys to levels', () => {
    expect(['0', '1', '2', '3', '4', '5', 'z'].map(levelForKey)).toEqual([0.75, 1.25, 1.5, 2, 3, null, null])
    expect(formatLevel(2)).toBe('2×')
    expect(formatLevel(1.25)).toBe('1.25×')
    expect(formatLevel(1.333333)).toBe('1.33×')
  })

  it('sets a level and marks the zoom as edited', () => {
    const z = setZoomLevel(seg('a', 0, 3), 3)
    expect(z).toMatchObject({ scale: 3, auto: false })
    expect(setZoomLevel(seg('a', 0, 3), 0.1).scale).toBe(0.5)
    expect(setZoomLevel(seg('a', 0, 3), 99).scale).toBe(5)
  })

  it('resizes a region around its centre to the new level, keeping its shape', () => {
    const z = seg('r', 0, 3, { focus: { mode: 'region', x: 0.2, y: 0.3, w: 0.4, h: 0.2 } })
    const out = setZoomLevel(z, 4)
    expect(out.focus.mode).toBe('region')
    if (out.focus.mode !== 'region') return
    expect(regionScale(out.focus)).toBeCloseTo(4)
    expect(out.scale).toBeCloseTo(4)
    expect(out.focus.x + out.focus.w / 2).toBeCloseTo(0.4)
    expect(out.focus.y + out.focus.h / 2).toBeCloseTo(0.4)
    expect(out.focus.w / out.focus.h).toBeCloseTo(2)
  })

  it('pulling a region zoom back turns it into a fixed point at its centre', () => {
    const out = setZoomLevel(seg('r', 0, 3, { focus: { mode: 'region', x: 0.2, y: 0.3, w: 0.4, h: 0.2 } }), 0.75)
    expect(out.focus).toEqual({ mode: 'fixed', x: 0.4, y: 0.4 })
    expect(zoomTargetScale(out)).toBe(0.75)
  })
})

describe('regions', () => {
  it('normalizeRegion keeps the box inside and frameable', () => {
    expect(normalizeRegion({ x: 0.9, y: 0.9, w: 0.3, h: 0.3 })).toMatchObject({ x: 0.7, y: 0.7, w: 0.3, h: 0.3 })
    const tiny = normalizeRegion({ x: 0.5, y: 0.5, w: 0.01, h: 0.005 })
    expect(Math.max(tiny.w, tiny.h)).toBeCloseTo(0.2)
    expect(tiny.h).toBeGreaterThanOrEqual(MIN_REGION_SIDE)
    expect(normalizeRegion({ x: -1, y: 0, w: 5, h: 0.5 })).toMatchObject({ x: 0, w: 1 })
  })

  it('setZoomRegion frames the box: level follows from it', () => {
    const z = setZoomRegion(seg('a', 0, 4), { x: 0.1, y: 0.2, w: 0.25, h: 0.25 })
    expect(z.scale).toBeCloseTo(4)
    expect(z.auto).toBe(false)
    const cam = cameraAt([z], 2, null)
    expect(cam.scale).toBeCloseTo(4)
    expect(cam.cx).toBeCloseTo(0.225)
  })

  it('regionAround is the view of a zoom at that level', () => {
    expect(regionAround(0.5, 0.5, 2)).toMatchObject({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    expect(regionAround(0.95, 0.05, 4)).toMatchObject({ x: 0.75, y: 0, w: 0.25, h: 0.25 })
  })

  it('dragRegion moves inside the recording and resizes from the dragged corner', () => {
    const r = { x: 0.2, y: 0.2, w: 0.4, h: 0.2 }
    expect(dragRegion(r, 'move', 0.9, -0.9)).toEqual({ x: 0.6, y: 0, w: 0.4, h: 0.2 })
    const se = dragRegion(r, 'se', 0.1, 0.3, true)
    expect(se.x).toBe(0.2)
    expect(se.y).toBe(0.2)
    expect(se.w / se.h).toBeCloseTo(2)
    const free = dragRegion(r, 'nw', -0.1, 0.05, false)
    expect(free).toEqual({ x: expect.closeTo(0.1), y: expect.closeTo(0.25), w: expect.closeTo(0.5), h: expect.closeTo(0.15) })
    // Never inverted.
    const shrunk = dragRegion(r, 'e', -5, 0)
    expect(shrunk.w).toBeCloseTo(MIN_REGION_SIDE)
  })

  it('regionFromPoints draws the recording shape unless asked for any shape', () => {
    expect(regionFromPoints({ x: 0.6, y: 0.6 }, { x: 0.2, y: 0.5 }, false)).toEqual({ x: 0.2, y: 0.5, w: expect.closeTo(0.4), h: expect.closeTo(0.1) })
    const sq = regionFromPoints({ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.3 }, true)
    expect(sq.w).toBeCloseTo(sq.h)
    expect(sq.w).toBeCloseTo(0.3)
    // Kept inside the recording.
    const edge = regionFromPoints({ x: 0.9, y: 0.5 }, { x: 1.4, y: 0.9 }, true)
    expect(edge.x + edge.w).toBeLessThanOrEqual(1 + 1e-9)
    expect(edge.w).toBeCloseTo(edge.h)
  })
})

describe('pan to next zoom (connected zooms)', () => {
  const zooms = [seg('a', 1, 3), seg('b', 6, 8, { focus: { mode: 'fixed', x: 0.8, y: 0.8 } }), seg('c', 8.2, 10)]

  it('finds the next zoom and which zooms are connected', () => {
    expect(nextZoom(zooms, 'a')?.id).toBe('b')
    expect(nextZoom(zooms, 'c')).toBeNull()
    expect([...connectedZoomIds(zooms)]).toEqual(['b'])
    expect(isConnectedToNext(zooms, 'b')).toBe(true)
    expect(isConnectedToNext(zooms, 'a')).toBe(false)
  })

  it('connect makes the zooms touch and the camera stays zoomed in across', () => {
    const joined = connectToNext(zooms, 'a')!
    const a = joined.find((z) => z.id === 'a')!
    expect(a.end).toBe(6)
    expect(a.auto).toBe(false)
    expect(isConnectedToNext(joined, 'a')).toBe(true)
    for (let t = 2; t < 7; t += 0.01) expect(cameraAt(joined, t, null).scale).toBeGreaterThanOrEqual(2 - 1e-9)
    // Only the connected zoom changed.
    expect(joined.filter((z) => z.id !== 'a')).toEqual(zooms.filter((z) => z.id !== 'a'))
    expect(connectToNext(zooms, 'c')).toBeNull()
  })

  it('disconnect leaves room to zoom out in between, or refuses when too short', () => {
    const split = disconnectFromNext(zooms, 'b')!
    const b = split.find((z) => z.id === 'b')!
    expect(8.2 - b.end).toBeGreaterThanOrEqual(connectGap(b, zooms[2]))
    expect(isConnectedToNext(split, 'b')).toBe(false)
    expect(b.end - b.start).toBeGreaterThanOrEqual(MIN_ZOOM_LENGTH)
    expect(disconnectFromNext([seg('x', 0, 1), seg('y', 1, 3)], 'x')).toBeNull()
  })

  it('clearZoomStyles removes per-zoom easing and transition only', () => {
    const styled = [seg('a', 0, 2, { easing: 'bouncy', transition: 1.2 }), seg('b', 3, 5)]
    const out = clearZoomStyles(styled)
    expect(out[0]).toEqual(seg('a', 0, 2))
    expect(out[1]).toBe(styled[1])
    expect(clearZoomStyles(out)).toBe(out)
  })
})
