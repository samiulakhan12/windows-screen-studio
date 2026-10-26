import { describe, expect, it } from 'vitest'
import { advance, blockAt, endPosition, rateAt, ScrollClock, snap, stepDelayMs, stepTarget, type BlockBox } from '../src/shared/notes/scroll'

const b: BlockBox[] = [
  { top: 0, height: 96, words: 12 },
  { top: 96, height: 48, words: 4 },
  { top: 144, height: 144, words: 30 }
]

describe('scroll maths', () => {
  it('finds the block on the reading line', () => {
    expect(blockAt(b, 0)).toBe(0)
    expect(blockAt(b, 95.9)).toBe(0)
    expect(blockAt(b, 96)).toBe(1)
    expect(blockAt(b, 500)).toBe(2)
    expect(blockAt([], 10)).toBe(0)
  })

  it('paces each block by its own words', () => {
    expect(rateAt(b, 0, 120)).toBe(16)
    expect(rateAt(b, 100, 120)).toBe(24)
    expect(rateAt(b, 288, 120)).toBe(0)
    expect(rateAt([], 0, 120)).toBe(0)
    expect(rateAt([{ top: 0, height: 40, words: 0 }], 0, 60)).toBe(40)
  })

  it('advances across block boundaries, never past the end', () => {
    expect(endPosition(b)).toBe(288)
    expect(endPosition([])).toBe(0)
    expect(advance(b, 90, 1, 120)).toBeCloseTo(111, 6)
    expect(advance(b, 0, 1000, 120)).toBe(288)
    expect(advance(b, 50, 0, 120)).toBe(50)
    expect(advance([], 0, 5, 120)).toBe(0)
  })

  it('steps back and forward by blocks', () => {
    expect(stepTarget(b, 120, 'back', 46)).toBe(0)
    expect(stepTarget(b, 150, 'back', 46)).toBe(96)
    expect(stepTarget(b, 200, 'back', 46)).toBe(144)
    expect(stepTarget(b, 0, 'back', 46)).toBe(0)
    expect(stepTarget(b, 0, 'forward', 46)).toBe(96)
    expect(stepTarget(b, 200, 'forward', 46)).toBe(288)
    expect(stepTarget([], 0, 'forward', 46)).toBe(0)
  })

  it('snaps to device pixels', () => {
    expect(snap(10.26, 1.5)).toBe(10)
    expect(snap(10.5, 1.5)).toBeCloseTo(10.6667, 4)
    expect(snap(3.4, 1)).toBe(3)
  })

  it('waits one device pixel per step, at most 30 writes a second', () => {
    expect(stepDelayMs(16, 1)).toBe(62.5)
    expect(stepDelayMs(16, 1.5)).toBeCloseTo(41.67, 2)
    expect(stepDelayMs(400, 2)).toBeCloseTo(33.33, 2)
    expect(stepDelayMs(0.5, 1)).toBe(1000)
    expect(stepDelayMs(0, 1)).toBe(1000)
  })
})

describe('ScrollClock', () => {
  const clock = (): ScrollClock => {
    const c = new ScrollClock()
    c.setLayout(b, 0)
    c.setWpm(120, 0)
    return c
  }

  it('is a function of time while playing, still while paused', () => {
    const c = clock()
    expect(c.playing).toBe(false)
    c.play(0)
    expect(c.playing).toBe(true)
    expect(c.positionAt(1000)).toBe(16)
    c.pause(1000)
    expect(c.positionAt(5000)).toBe(16)
  })

  it('keeps the position through a speed change', () => {
    const c = clock()
    c.play(0)
    c.setWpm(240, 1000)
    expect(c.positionAt(1000)).toBe(16)
    expect(c.positionAt(2000)).toBe(48)
  })

  it('jumps and rebases, clamped to the text', () => {
    const c = clock()
    c.play(0)
    c.jump(200, 500)
    expect(c.positionAt(500)).toBe(200)
    expect(c.positionAt(1500)).toBeCloseTo(200 + (2 * 144) / 30, 6)
    c.jump(-5, 2000)
    expect(c.positionAt(2000)).toBe(0)
    c.jump(9999, 3000)
    expect(c.positionAt(3000)).toBe(288)
  })

  it('keeps the block and the share of it through a new layout', () => {
    const c = clock()
    c.jump(120, 0) // half way through block 1
    c.setLayout(
      b.map((x) => ({ ...x, top: x.top * 2, height: x.height * 2 })),
      10
    )
    expect(c.positionAt(10)).toBe(240)
    expect(blockAt(b.map((x) => ({ ...x, top: x.top * 2, height: x.height * 2 })), c.positionAt(10))).toBe(1)
  })

  it('knows when the end reached the reading line', () => {
    const c = clock()
    expect(c.endedAt(0)).toBe(false)
    c.jump(280, 0)
    c.play(0)
    expect(c.endedAt(100)).toBe(false)
    expect(c.endedAt(5000)).toBe(true)
    expect(new ScrollClock().endedAt(0)).toBe(false)
  })
})
