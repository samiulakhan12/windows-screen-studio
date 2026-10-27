import { describe, expect, it } from 'vitest'
import { decodeProbs, speechFromProbs } from '../src/shared/audio/vad'

const frames = (...runs: [number, number][]): Uint8Array => {
  const out: number[] = []
  for (const [n, p] of runs) for (let i = 0; i < n; i++) out.push(Math.round(p * 255))
  return Uint8Array.from(out)
}

describe('speechFromProbs (32 ms frames)', () => {
  it('bridges a 96 ms gap into one range, padded by 30 ms', () => {
    const r = speechFromProbs(frames([10, 0.1], [20, 0.9], [3, 0.2], [20, 0.9]))
    expect(r).toHaveLength(1)
    expect(r[0].start).toBeCloseTo(10 * 0.032 - 0.03, 4)
    expect(r[0].end).toBeCloseTo(53 * 0.032, 4) // clamped to the audio
  })

  it('drops a 224 ms burst', () => {
    expect(speechFromProbs(frames([10, 0], [7, 0.9], [10, 0]))).toEqual([])
    expect(speechFromProbs(frames([10, 0], [8, 0.9], [10, 0]))).toHaveLength(1)
  })

  it('clamps the padding at 0', () => {
    expect(speechFromProbs(frames([20, 0.9], [10, 0]))[0].start).toBe(0)
  })

  it('keeps speech while p >= 0.35 (hysteresis), ends it below', () => {
    const r = speechFromProbs(frames([5, 0], [10, 0.9], [20, 0.4], [10, 0.3], [5, 0]))
    expect(r).toHaveLength(1)
    expect(r[0].end).toBeCloseTo(35 * 0.032 + 0.03, 4)
    // 0.4 never starts speech.
    expect(speechFromProbs(frames([40, 0.4]))).toEqual([])
  })

  it('all speech, none, empty', () => {
    expect(speechFromProbs(frames([100, 1]))).toEqual([{ start: 0, end: 3.2 }])
    expect(speechFromProbs(frames([100, 0]))).toEqual([])
    expect(speechFromProbs(new Uint8Array())).toEqual([])
  })

  it('keeps separate ranges apart', () => {
    const r = speechFromProbs(frames([10, 0.9], [20, 0], [10, 0.9]))
    expect(r).toHaveLength(2)
    expect(r[0].end).toBeLessThan(r[1].start)
  })
})

describe('decodeProbs', () => {
  it('decodes base64 bytes', () => {
    expect([...decodeProbs(Buffer.from([0, 128, 255]).toString('base64'), 10)!]).toEqual([0, 128, 255])
    expect([...decodeProbs('', 0)!]).toEqual([])
  })
  it('rejects invalid base64 and more than maxFrames', () => {
    expect(decodeProbs('@@@@', 10)).toBeNull()
    expect(decodeProbs('AAA', 10)).toBeNull()
    expect(decodeProbs(Buffer.alloc(11).toString('base64'), 10)).toBeNull()
    expect(decodeProbs(Buffer.alloc(10).toString('base64'), 10)).toHaveLength(10)
  })
})
