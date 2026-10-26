import { describe, expect, it } from 'vitest'
import { AreaHistory, OWN_AREA_MAX_SPANS } from '../src/shared/recording/ownAreas'

const A = { x: 0, y: 0, width: 100, height: 50 }
const B = { x: 500, y: 500, width: 100, height: 50 }
const inA = { x: 10, y: 10 }

describe('AreaHistory', () => {
  it('judges a point by where the window was when the event happened, with 250 ms of slack', () => {
    const h = new AreaHistory()
    h.set(A, 1000)
    h.set(null, 2000)
    expect(h.contains(inA, 1500)).toBe(true)
    // A click on × delivered after the window hid.
    expect(h.contains(inA, 2200)).toBe(true)
    expect(h.contains(inA, 2300)).toBe(false)
    expect(h.contains(inA, 800)).toBe(true)
    expect(h.contains(inA, 700)).toBe(false)
    expect(h.contains({ x: 200, y: 10 }, 1500)).toBe(false)
  })

  it('a moved window leaves its old place to the content', () => {
    const h = new AreaHistory()
    h.set(A, 1000)
    h.set(B, 3000)
    expect(h.contains(inA, 3300)).toBe(false)
    expect(h.contains(inA, 2900)).toBe(true)
    expect(h.contains({ x: 510, y: 510 }, 3300)).toBe(true)
    // Still open: true long after.
    expect(h.contains({ x: 510, y: 510 }, 99_000)).toBe(true)
  })

  it('repeating the same rectangle extends one span', () => {
    const h = new AreaHistory()
    h.set(A, 1000)
    h.set(A, 5000)
    h.set(null, 6000)
    // One span from 1000: a second span from 5000 would leave 2000 outside.
    expect(h.contains(inA, 2000)).toBe(true)
  })

  it('keeps at most OWN_AREA_MAX_SPANS spans, dropping the oldest', () => {
    const h = new AreaHistory()
    h.set(A, 0)
    for (let i = 1; i <= OWN_AREA_MAX_SPANS; i++) h.set({ x: 1000 + i, y: 1000, width: 10, height: 10 }, i * 1000)
    // 1001 spans were set: A's is gone.
    expect(h.contains(inA, 500)).toBe(false)
    // The second oldest is still there.
    expect(h.contains({ x: 1001, y: 1000 }, 1500)).toBe(true)
  })

  it('clear() forgets everything', () => {
    const h = new AreaHistory()
    h.set(A, 1000)
    h.clear()
    expect(h.contains(inA, 1500)).toBe(false)
  })
})
