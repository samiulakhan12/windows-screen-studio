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

  /** The previous implementation: scans back from the playhead on every call. */
  function scanOpacity(samples: CursorSample[], t: number, idleAfter = 2, fade = 0.3): number {
    if (samples.length < 2) return 1
    let i = -1
    for (let k = 0; k < samples.length && samples[k].t <= t; k++) i = k
    if (i <= 0) return 1
    const eps = 0.0015
    const ref = samples[i]
    let lastMove = samples[0].t
    for (let j = i; j > 0; j--) {
      const p = samples[j - 1]
      if (Math.abs(p.x - ref.x) > eps || Math.abs(p.y - ref.y) > eps) {
        lastMove = samples[j].t
        break
      }
    }
    const idle = t - lastMove - idleAfter
    return idle <= 0 ? 1 : Math.min(1, Math.max(0, 1 - idle / fade))
  }

  /** Deterministic pseudo-random numbers (mulberry32). */
  function rng(seed: number): () => number {
    let a = seed
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let x = Math.imul(a ^ (a >>> 15), 1 | a)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
  }

  it('gives exactly the results of scanning back sample by sample (perf-3)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed)
      const samples: CursorSample[] = []
      let x = r()
      let y = r()
      let t = 0
      for (let i = 0; i < 400; i++) {
        const mode = r()
        // Still stretches (exact repeats), sub-eps jitter and drift, real moves, and moves right at eps.
        if (mode < 0.35) {
          // repeat
        } else if (mode < 0.55) {
          x += (r() - 0.5) * 0.002
          y += (r() - 0.5) * 0.002
        } else if (mode < 0.65) {
          x += 0.0015
        } else if (mode < 0.9) {
          x = r()
          y = r()
        } else {
          y -= 0.0007
        }
        t += r() < 0.1 ? 1.5 : 1 / 60
        samples.push({ t, x, y })
      }
      for (let k = 0; k < 300; k++) {
        const at = r() * (t + 3) - 0.5
        expect(cursorOpacity(samples, at)).toBe(scanOpacity(samples, at))
      }
      for (const s of samples) expect(cursorOpacity(samples, s.t + 2.1)).toBe(scanOpacity(samples, s.t + 2.1))
    }
  })

  it('costs the same per frame however long the cursor has been still (perf-3)', () => {
    // 30 minutes polled at 60 Hz, still from 5 to 25 minutes.
    const samples: CursorSample[] = Array.from({ length: 30 * 60 * 60 }, (_, i) => {
      const t = i / 60
      const moving = t < 300 || t >= 1500
      return { t, x: moving ? 0.5 + 0.3 * Math.sin(t) : 0.2, y: moving ? 0.5 : 0.7 }
    })
    expect(cursorOpacity(samples, 100)).toBe(1)
    const t0 = performance.now()
    for (let f = 300 * 60; f < 1500 * 60; f++) cursorOpacity(samples, f / 60)
    const ms = performance.now() - t0
    // Scanning back took ~7 s for this stretch; a lookup is well under a microsecond.
    expect(ms).toBeLessThan(500)
    expect(cursorOpacity(samples, 301)).toBe(1)
    expect(cursorOpacity(samples, 1400)).toBe(0)
    expect(cursorOpacity(samples, 1500.5)).toBe(1)
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
