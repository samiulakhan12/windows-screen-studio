import { describe, expect, it } from 'vitest'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { cameraAt, generateAutoZooms, normalizeZooms, segmentEnvelope, ZOOM_TRANSITION } from '../src/shared/engine/zoom'
import type { ClickEvent, ZoomSegment } from '../src/shared/types'

const click = (t: number, button: ClickEvent['button'] = 'left'): ClickEvent => ({ t, x: 0.5, y: 0.5, button })

describe('generateAutoZooms', () => {
  it('creates no zooms without clicks', () => {
    expect(generateAutoZooms([], 10)).toEqual([])
  })

  it('starts before the click and holds after it', () => {
    const [z] = generateAutoZooms([click(5)], 20)
    expect(z.start).toBeLessThan(5)
    expect(z.end).toBeGreaterThan(5.5)
    expect(z.auto).toBe(true)
    expect(z.focus).toEqual({ mode: 'cursor' })
  })

  it('clusters nearby clicks into one segment', () => {
    const zooms = generateAutoZooms([click(2), click(3), click(4.5)], 30)
    expect(zooms).toHaveLength(1)
    expect(zooms[0].end).toBeGreaterThan(4.5)
  })

  it('keeps distant clicks separate and non-overlapping', () => {
    const zooms = generateAutoZooms([click(2), click(15)], 30)
    expect(zooms).toHaveLength(2)
    expect(zooms[0].end).toBeLessThanOrEqual(zooms[1].start)
  })

  it('ignores right clicks and stays within the recording', () => {
    expect(generateAutoZooms([click(2, 'right')], 10)).toHaveLength(0)
    const [z] = generateAutoZooms([click(0.1), click(9.9)], 10)
    expect(z.start).toBeGreaterThanOrEqual(0)
    expect(z.end).toBeLessThanOrEqual(10)
  })
})

const seg = (start: number, end: number, extra: Partial<ZoomSegment> = {}): ZoomSegment => ({
  id: `${start}`,
  start,
  end,
  scale: 2,
  focus: { mode: 'cursor' },
  auto: false,
  ...extra
})

describe('segmentEnvelope', () => {
  it('ramps in, holds at 1 and ramps out', () => {
    const z = seg(1, 5)
    expect(segmentEnvelope(z, 0.5)).toBe(0)
    expect(segmentEnvelope(z, 1 + ZOOM_TRANSITION / 2)).toBeCloseTo(0.5, 5)
    expect(segmentEnvelope(z, 3)).toBe(1)
    expect(segmentEnvelope(z, 5)).toBe(0)
  })
})

describe('cameraAt', () => {
  it('shows the full frame outside zooms', () => {
    expect(cameraAt([seg(1, 3)], 5, null)).toEqual({ scale: 1, cx: 0.5, cy: 0.5 })
  })

  it('reaches the target scale and focuses on a fixed point', () => {
    const cam = cameraAt([seg(0, 4, { focus: { mode: 'fixed', x: 0.6, y: 0.4 } })], 2, null)
    expect(cam.scale).toBe(2)
    expect(cam.cx).toBeCloseTo(0.6)
    expect(cam.cy).toBeCloseTo(0.4)
  })

  it('clamps the viewport inside the frame when following a cursor in a corner', () => {
    const corner = new SmoothedTrack([{ t: 0, x: 0.99, y: 0.01 }], 5, 0.5)
    const cam = cameraAt([seg(0, 5)], 2.5, corner)
    expect(cam.cx).toBeCloseTo(0.75)
    expect(cam.cy).toBeCloseTo(0.25)
  })
})

describe('normalizeZooms', () => {
  it('sorts, clamps and removes overlaps and tiny segments', () => {
    const out = normalizeZooms([seg(5, 9), seg(-1, 3), seg(2.5, 6), seg(9, 9.1)], 8)
    expect(out.map((z) => [z.start, z.end])).toEqual([
      [0, 3],
      [3, 6],
      [6, 8]
    ])
  })
})
