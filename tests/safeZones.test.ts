import { describe, expect, it } from 'vitest'
import { COMMON_SAFE, keepInArea, SAFE_ZONES, zonesFor, type SafeBox, type SafePlatform } from '../src/shared/render/safeZones'

/*
 * The safe-zone table and the area all three apps leave free (docs/design/vertical-video.md §7,
 * test 51), the boxes the preview shades, and keepInArea, which Make a vertical version uses to
 * move text and images into that area once (§6.4).
 */

const PLATFORMS: SafePlatform[] = ['tiktok', 'reels', 'shorts']
/** Overlap of two normalised boxes (0 when they only touch). */
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

describe('the safe-zone table (test 51)', () => {
  it('has boxes inside the frame, three per platform, each labelled, and a checked date for every platform', () => {
    for (const p of PLATFORMS) {
      const { boxes, checked, name } = SAFE_ZONES[p]
      expect(name.length).toBeGreaterThan(0)
      expect(checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(Date.parse(checked))).toBe(false)
      expect(boxes).toHaveLength(3)
      for (const b of boxes) {
        expect(b.label.length, `${p} ${b.label}`).toBeGreaterThan(0)
        for (const v of [b.x, b.y, b.w, b.h]) expect(v).toBeGreaterThanOrEqual(0)
        expect(b.w).toBeGreaterThan(0)
        expect(b.h).toBeGreaterThan(0)
        expect(b.x + b.w).toBeLessThanOrEqual(1 + 1e-9)
        expect(b.y + b.h).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('has the common safe area of §7, which overlaps no box of any platform', () => {
    expect(COMMON_SAFE).toEqual({ x: 0.06, y: 0.11, w: 0.8, h: 0.65 })
    for (const p of PLATFORMS) for (const b of SAFE_ZONES[p].boxes) expect(overlap(COMMON_SAFE, b), `${p} ${b.label}`).toBeLessThan(1e-9)
    // It reaches each of the boxes that bound it: as large as the apps allow, not smaller.
    const touches = (b: SafeBox): boolean => overlap({ x: COMMON_SAFE.x - 1e-6, y: COMMON_SAFE.y - 1e-6, w: COMMON_SAFE.w + 2e-6, h: COMMON_SAFE.h + 2e-6 }, b) > 0
    expect(touches(SAFE_ZONES.reels.boxes[0])).toBe(true)
    expect(touches(SAFE_ZONES.tiktok.boxes[1])).toBe(true)
    expect(touches(SAFE_ZONES.shorts.boxes[1])).toBe(true)
  })

  it('zonesFor: every platform\'s nine boxes for all three, three for each one, as copies of the table', () => {
    const all = zonesFor('all')
    expect(all).toHaveLength(9)
    expect(all).toEqual(PLATFORMS.flatMap((p) => SAFE_ZONES[p].boxes))
    for (const p of PLATFORMS) {
      const boxes = zonesFor(p)
      expect(boxes).toHaveLength(3)
      expect(boxes).toEqual(SAFE_ZONES[p].boxes)
      expect(boxes[0]).not.toBe(SAFE_ZONES[p].boxes[0])
    }
    // Changing what it returns leaves the table as it is.
    zonesFor('tiktok')[0].h = 0.5
    expect(SAFE_ZONES.tiktok.boxes[0].h).toBe(0.08)
    expect(zonesFor('nope' as SafePlatform)).toEqual([])
  })
})

describe('keepInArea', () => {
  const area = { x: 65, y: 211, w: 864, h: 1248 }

  it('leaves a box already inside exactly where it is', () => {
    expect(keepInArea({ x: 100, y: 300, w: 200, h: 80 }, area)).toEqual({ dx: 0, dy: 0, scale: 1 })
    expect(keepInArea({ x: 65, y: 211, w: 864, h: 1248 }, area)).toEqual({ dx: 0, dy: 0, scale: 1 })
  })

  it('shifts a box that sticks out back in, the shortest way', () => {
    // Under the area (a 16:9 lower third in a 9:16 frame): moved up to its bottom.
    expect(keepInArea({ x: 100, y: 1700, w: 300, h: 100 }, area)).toEqual({ dx: 0, dy: 211 + 1248 - 100 - 1700, scale: 1 })
    // Past its left and top edges.
    expect(keepInArea({ x: 10, y: 50, w: 100, h: 40 }, area)).toEqual({ dx: 55, dy: 161, scale: 1 })
    // Past its right edge (the apps' buttons).
    const r = keepInArea({ x: 900, y: 600, w: 100, h: 40 }, area)
    expect(r.scale).toBe(1)
    expect(900 + r.dx + 100).toBeCloseTo(65 + 864, 9)
    expect(r.dy).toBe(0)
  })

  it('shrinks a box larger than the area about its centre to fit, then keeps it inside', () => {
    const box = { x: 40, y: 1500, w: 1000, h: 100 }
    const r = keepInArea(box, area)
    expect(r.scale).toBeCloseTo(864 / 1000, 12)
    const w = box.w * r.scale
    const h = box.h * r.scale
    const left = box.x + box.w / 2 + r.dx - w / 2
    const top = box.y + box.h / 2 + r.dy - h / 2
    expect(left).toBeCloseTo(65, 9)
    expect(left + w).toBeCloseTo(65 + 864, 9)
    expect(top + h).toBeLessThanOrEqual(211 + 1248 + 1e-9)
    expect(top).toBeGreaterThanOrEqual(211 - 1e-9)
  })

  it('shrinks no further than 60% (or minScale), and centres what is still too large on the area', () => {
    const box = { x: 0, y: 400, w: 2000, h: 50 }
    const r = keepInArea(box, area)
    expect(r.scale).toBe(0.6)
    // 1200 px wide at 60%: centred on the area across.
    expect(box.x + box.w / 2 + r.dx).toBeCloseTo(65 + 864 / 2, 9)
    expect(r.dy).toBe(0)
    expect(keepInArea(box, area, 0.3).scale).toBeCloseTo(864 / 2000, 12)
    expect(keepInArea(box, area, 0.9).scale).toBe(0.9)
    expect(keepInArea(box, area, 1).scale).toBe(1)
  })

  it('moves nothing for sizes it cannot use', () => {
    expect(keepInArea({ x: Number.NaN, y: 0, w: 10, h: 10 }, area)).toEqual({ dx: 0, dy: 0, scale: 1 })
    expect(keepInArea({ x: 0, y: 0, w: 10, h: 10 }, { ...area, w: Number.POSITIVE_INFINITY })).toEqual({ dx: 0, dy: 0, scale: 1 })
    expect(keepInArea({ x: 100, y: 300, w: 0, h: 0 }, area)).toEqual({ dx: 0, dy: 0, scale: 1 })
  })
})
