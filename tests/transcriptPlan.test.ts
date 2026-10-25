import { describe, expect, it } from 'vitest'
import { planParts, secondsForBytes, silencesBetween } from '../src/shared/captions/transcriptPlan'

describe('silencesBetween', () => {
  it('returns the gaps between sounds, including the start and the end', () => {
    expect(silencesBetween([{ start: 1, end: 3 }, { start: 5, end: 6 }], 10)).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 5 },
      { start: 6, end: 10 }
    ])
  })

  it('handles unsorted and overlapping ranges, and sound to the end', () => {
    expect(silencesBetween([{ start: 4, end: 10 }, { start: 0, end: 2 }, { start: 1, end: 3 }], 10)).toEqual([{ start: 3, end: 4 }])
    expect(silencesBetween([], 5)).toEqual([{ start: 0, end: 5 }])
  })
})

describe('secondsForBytes', () => {
  it('fits a 25 MB upload of 32 kbit/s sound in well over an hour, with a margin', () => {
    const s = secondsForBytes(25 * 1024 * 1024, 32000)
    expect(s).toBeGreaterThan(3600)
    expect((s * 32000) / 8).toBeLessThan(25 * 1024 * 1024)
  })
})

describe('planParts', () => {
  it('sends a short recording in one part', () => {
    expect(planParts(42, [], { maxSeconds: 600 })).toEqual([{ index: 0, start: 0, end: 42, keepStart: 0, keepEnd: 42 }])
    expect(planParts(0, [], { maxSeconds: 600 })).toEqual([])
  })

  it('cuts in the middle of the longest pause near the end of each part', () => {
    const silences = [
      { start: 3, end: 3.5 }, // too early in the window
      { start: 7, end: 7.4 },
      { start: 8.2, end: 9.2 }, // longest in the window: cut at 8.7
      { start: 16, end: 16.6 }
    ]
    const parts = planParts(20, silences, { maxSeconds: 10 })
    expect(parts.map((p) => [p.start, p.end])).toEqual([
      [0, 8.7],
      [8.7, 16.3],
      [16.3, 20]
    ])
    // No overlap: everything a part sends is kept.
    for (const p of parts) expect([p.keepStart, p.keepEnd]).toEqual([p.start, p.end])
  })

  it('ignores pauses shorter than the minimum', () => {
    const parts = planParts(20, [{ start: 8, end: 8.1 }], { maxSeconds: 10 })
    expect(parts[0].keepEnd).not.toBeCloseTo(8.05)
  })

  it('cuts at fixed points with an overlap where the sound never pauses, never sending more than the maximum', () => {
    const parts = planParts(35, [], { maxSeconds: 10, overlap: 2 })
    expect(parts.length).toBe(5)
    for (const p of parts) {
      expect(p.end - p.start).toBeLessThanOrEqual(10 + 1e-9)
      expect(p.keepStart).toBeGreaterThanOrEqual(p.start)
      expect(p.keepEnd).toBeLessThanOrEqual(p.end)
    }
    // Kept windows tile the recording exactly; neighbours overlap by the full overlap.
    expect(parts[0].keepStart).toBe(0)
    expect(parts[parts.length - 1].keepEnd).toBe(35)
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i].keepStart).toBe(parts[i - 1].keepEnd)
      expect(parts[i - 1].end - parts[i].start).toBeCloseTo(2)
    }
  })

  it('mixes both kinds of cuts', () => {
    const parts = planParts(30, [{ start: 16, end: 17 }], { maxSeconds: 10, overlap: 2 })
    // 0..9 (fixed, overlapped), then the pause at 16.5, then fixed again.
    expect(parts[0]).toMatchObject({ start: 0, end: 10, keepEnd: 9 })
    expect(parts[1]).toMatchObject({ start: 8, keepStart: 9, keepEnd: 16.5, end: 16.5 })
    expect(parts[2]).toMatchObject({ start: 16.5, keepStart: 16.5, keepEnd: 25.5, end: 26.5 })
    expect(parts[parts.length - 1].keepEnd).toBe(30)
    for (const p of parts) expect(p.end - p.start).toBeLessThanOrEqual(10 + 1e-9)
  })
})
