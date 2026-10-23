import { describe, expect, it } from 'vitest'
import { activeClicks, cursorAt, cursorOpacity, SmoothedTrack } from '../src/shared/engine/cursor'
import type { CursorSample } from '../src/shared/types'

const line: CursorSample[] = [
  { t: 0, x: 0, y: 0 },
  { t: 1, x: 1, y: 0.5 }
]

describe('cursorAt', () => {
  it('interpolates and clamps', () => {
    expect(cursorAt(line, 0.5)).toEqual({ x: 0.5, y: 0.25 })
    expect(cursorAt(line, -1)).toEqual({ x: 0, y: 0 })
    expect(cursorAt(line, 5)).toEqual({ x: 1, y: 0.5 })
    expect(cursorAt([], 1)).toBeNull()
  })
})

describe('SmoothedTrack', () => {
  const jump: CursorSample[] = [
    { t: 0, x: 0.1, y: 0.1 },
    { t: 0.5, x: 0.1, y: 0.1 },
    { t: 0.51, x: 0.9, y: 0.9 },
    { t: 3, x: 0.9, y: 0.9 }
  ]

  it('lags behind a sudden jump and then settles on the target', () => {
    const track = new SmoothedTrack(jump, 3, 0.6)
    const mid = track.at(0.55)
    expect(mid.x).toBeGreaterThan(0.1)
    expect(mid.x).toBeLessThan(0.9)
    expect(track.at(2.5).x).toBeCloseTo(0.9, 2)
  })

  it('smoother settings lag more', () => {
    const snappy = new SmoothedTrack(jump, 3, 0).at(0.6).x
    const floaty = new SmoothedTrack(jump, 3, 1).at(0.6).x
    expect(snappy).toBeGreaterThan(floaty)
  })

  it('never overshoots (critically damped)', () => {
    const track = new SmoothedTrack(jump, 3, 0.8)
    for (let t = 0; t <= 3; t += 0.01) expect(track.at(t).x).toBeLessThanOrEqual(0.9 + 1e-4)
  })

  it('is deterministic for the same input', () => {
    const a = new SmoothedTrack(jump, 3, 0.5).at(1.234)
    const b = new SmoothedTrack(jump, 3, 0.5).at(1.234)
    expect(a).toEqual(b)
  })

  it('handles an empty track', () => {
    expect(new SmoothedTrack([], 2, 0.5).at(1)).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe('cursorOpacity', () => {
  const still: CursorSample[] = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, x: i < 10 ? i * 0.01 : 0.09, y: 0.5 }))
  it('is visible while moving and fades after idling', () => {
    expect(cursorOpacity(still, 0.5)).toBe(1)
    expect(cursorOpacity(still, 2.5)).toBe(1)
    expect(cursorOpacity(still, 6)).toBe(0)
  })
})

describe('activeClicks', () => {
  it('returns clicks within the ripple window', () => {
    const clicks = [{ t: 1, x: 0, y: 0, button: 'left' as const }]
    expect(activeClicks(clicks, 0.9)).toHaveLength(0)
    expect(activeClicks(clicks, 1.2)).toHaveLength(1)
    expect(activeClicks(clicks, 2)).toHaveLength(0)
  })
})
