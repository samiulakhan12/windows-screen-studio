/**
 * Where the demo puts a step's callout (docs/design/smart-tools.md §6.1): test 109 of §22.1 (the
 * placement; the page's end screen and the demo's shots are in guideHtml.test.ts and
 * guideDoc.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { calloutPlace, DEMO_GAP, DEMO_HOTSPOT, DEMO_NARROW } from '../src/shared/guide/demoLayout'

const picture = { w: 1280, h: 720 }
const callout = { w: 320, h: 150 }

/** Whether the callout's box covers any of the hotspot's. */
function covers(place: { x: number; y: number }, hot: { x: number; y: number }): boolean {
  const r = DEMO_HOTSPOT / 2
  return place.x < hot.x + r && place.x + callout.w > hot.x - r && place.y < hot.y + r && place.y + callout.h > hot.y - r
}

describe('test 109: calloutPlace', () => {
  it('right of a hotspot at x 0.3, 16 px away', () => {
    const hot = { x: 0.3 * picture.w, y: 300 }
    const p = calloutPlace(hot, picture, callout)
    expect(p.side).toBe('right')
    expect(p.x).toBe(hot.x + DEMO_HOTSPOT / 2 + DEMO_GAP)
    expect(covers(p, hot)).toBe(false)
  })

  it('left of a hotspot at x 0.7', () => {
    const hot = { x: 0.7 * picture.w, y: 300 }
    const p = calloutPlace(hot, picture, callout)
    expect(p.side).toBe('left')
    expect(p.x + callout.w).toBe(hot.x - DEMO_HOTSPOT / 2 - DEMO_GAP)
    expect(covers(p, hot)).toBe(false)
  })

  it('above or below when neither side has 336 px', () => {
    const narrow = { w: 600, h: 720 }
    const low = calloutPlace({ x: 300, y: 600 }, narrow, callout)
    expect(low.side).toBe('above')
    expect(covers(low, { x: 300, y: 600 })).toBe(false)
    const high = calloutPlace({ x: 300, y: 100 }, narrow, callout)
    expect(high.side).toBe('below')
    expect(covers(high, { x: 300, y: 100 })).toBe(false)
    // One side with room is used before above or below.
    expect(calloutPlace({ x: 200, y: 300 }, narrow, callout).side).toBe('right')
    expect(calloutPlace({ x: 520, y: 300 }, { w: 600, h: 720 }, callout).side).toBe('left')
  })

  it('a side is used only with the callout’s width and the 16 px gap free: 336 px', () => {
    const narrow = { w: 600, h: 720 }
    const half = DEMO_HOTSPOT / 2
    // 336 px right of the hotspot: right; 335: neither side (the left has less), so below.
    expect(calloutPlace({ x: narrow.w - half - 336, y: 100 }, narrow, callout).side).toBe('right')
    expect(calloutPlace({ x: narrow.w - half - 335, y: 100 }, narrow, callout).side).toBe('below')
  })

  it('the top-left corner without a hotspot', () => {
    expect(calloutPlace(null, picture, callout)).toEqual({ side: 'corner', x: 16, y: 16 })
  })

  it('never over the hotspot, anywhere on the picture', () => {
    for (let x = 0; x <= picture.w; x += 40)
      for (let y = 0; y <= picture.h; y += 40) {
        const p = calloutPlace({ x, y }, picture, callout)
        expect(covers(p, { x, y }), `${x},${y} ${p.side}`).toBe(false)
        if (p.side === 'left' || p.side === 'right') expect(p.x >= 0 && p.x + callout.w <= picture.w, `${x},${y} ${p.side} inside`).toBe(true)
      }
  })

  it('the page is narrow below 640 px', () => {
    expect(DEMO_NARROW).toBe(640)
  })
})
