// Lining a stem up with the mixed sound it is part of (shared/audio/align).
import { describe, expect, it } from 'vitest'
import { stemLag } from '../src/shared/audio/align'

const RATE = 8000

/** Deterministic noise in [-a, a] (mulberry32: different seeds give unrelated sequences). */
function noise(n: number, a: number, seed: number): Float32Array {
  let x = seed >>> 0
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    x = (x + 0x6d2b79f5) >>> 0
    let t = x
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    out[i] = ((((t ^ (t >>> 14)) >>> 0) / 4294967296) - 0.5) * 2 * a
  }
  return out
}

/** A 1 kHz beep of 0.1 s at the start of every second, `seconds` long. */
function beeps(seconds: number): Float32Array {
  const out = new Float32Array(seconds * RATE)
  for (let i = 0; i < out.length; i++) if (i % RATE < RATE / 10) out[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / RATE)
  return out
}

/** `s` later by `lag` samples (earlier when negative), plus `other`. */
function delayed(s: Float32Array, lag: number, other?: Float32Array): Float32Array {
  const out = new Float32Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const j = i - lag
    out[i] = (j >= 0 && j < s.length ? s[j] : 0) + (other ? other[i] : 0)
  }
  return out
}

describe('stemLag', () => {
  it('finds a delay of the mixed sound to the sample', () => {
    const stem = noise(20 * RATE, 0.2, 1)
    expect(stemLag(stem, delayed(stem, 157), RATE)?.lag).toBe(157)
    expect(stemLag(stem, delayed(stem, -40), RATE)?.lag).toBe(-40)
    expect(stemLag(stem, stem, RATE)).toEqual({ lag: 0, score: 1 })
  })

  it('finds it when another source of the same loudness is mixed in', () => {
    const mic = noise(20 * RATE, 0.2, 2)
    const system = noise(20 * RATE, 0.2, 3)
    const r = stemLag(mic, delayed(mic, 152, system), RATE)!
    expect(r.lag).toBe(152)
    expect(r.score).toBeGreaterThan(0.6)
  })

  it('lines up beeps (a steady tone repeats every cycle) to within a cycle', () => {
    const stem = beeps(10)
    const r = stemLag(stem, delayed(stem, 160), RATE)!
    expect(Math.abs(r.lag - 160)).toBeLessThanOrEqual(1)
  })

  it('gives up on silence, unrelated sound, a match at the search edge, or too little sound', () => {
    const silent = new Float32Array(10 * RATE)
    expect(stemLag(silent, noise(10 * RATE, 0.2, 4), RATE)).toBeNull()
    expect(stemLag(noise(10 * RATE, 0.2, 5), noise(10 * RATE, 0.2, 6), RATE)).toBeNull()
    const stem = noise(10 * RATE, 0.2, 7)
    expect(stemLag(stem, delayed(stem, 0.3 * RATE), RATE)).toBeNull()
    expect(stemLag(noise(RATE, 0.2, 8), noise(RATE, 0.2, 8), RATE)).toBeNull()
  })
})
