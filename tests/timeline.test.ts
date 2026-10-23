import { describe, expect, it } from 'vitest'
import {
  atempoChain,
  clipIndexAt,
  cutRange,
  exportFrameTimes,
  keptBounds,
  normalizeClips,
  outputDuration,
  outputToSource,
  playableFrom,
  removeClip,
  setClipSpeed,
  setTrimEnd,
  setTrimStart,
  sourceToOutput,
  splitAt
} from '../src/shared/engine/timeline'
import type { Clip } from '../src/shared/types'

const clip = (id: string, start: number, end: number, speed = 1): Clip => ({ id, start, end, speed })
// 0-2 at 1x, (2-4 cut), 4-8 at 2x  => output 2 + 2 = 4s
const edit = [clip('a', 0, 2), clip('b', 4, 8, 2)]

describe('time mapping', () => {
  it('computes output duration with cuts and speed', () => {
    expect(outputDuration(edit)).toBe(4)
    expect(keptBounds(edit)).toEqual({ start: 0, end: 8 })
  })

  it('maps source -> output, returning null inside cuts', () => {
    expect(sourceToOutput(edit, 1)).toBe(1)
    expect(sourceToOutput(edit, 3)).toBeNull()
    expect(sourceToOutput(edit, 6)).toBe(3)
    expect(sourceToOutput(edit, 8)).toBe(4)
  })

  it('maps output -> source and is the inverse on kept time', () => {
    expect(outputToSource(edit, 1)).toEqual({ time: 1, index: 0 })
    expect(outputToSource(edit, 2)).toEqual({ time: 4, index: 1 })
    expect(outputToSource(edit, 3)).toEqual({ time: 6, index: 1 })
    expect(outputToSource(edit, 99)).toEqual({ time: 8, index: 1 })
    for (const s of [0.5, 1.7, 4.2, 7.9]) expect(outputToSource(edit, sourceToOutput(edit, s)!).time).toBeCloseTo(s)
  })

  it('finds where playback continues', () => {
    expect(playableFrom(edit, 1)).toEqual({ time: 1, index: 0 })
    expect(playableFrom(edit, 2.5)).toEqual({ time: 4, index: 1 })
    expect(playableFrom(edit, 8)).toBeNull()
    expect(clipIndexAt(edit, 3)).toBe(-1)
  })
})

describe('exportFrameTimes', () => {
  it('produces one source time per output frame, skipping cuts and honouring speed', () => {
    const t = exportFrameTimes(edit, 10)
    expect(t).toHaveLength(40)
    expect(t[0]).toBe(0)
    expect(t[19]).toBeCloseTo(1.9)
    expect(t[20]).toBeCloseTo(4)
    expect(t[21]).toBeCloseTo(4.2)
    expect(t[39]).toBeCloseTo(7.8)
    // strictly increasing
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1])
  })

  it('works for a single untouched clip', () => {
    const t = exportFrameTimes([clip('x', 1, 2)], 30)
    expect(t).toHaveLength(30)
    expect(t[0]).toBe(1)
    expect(t[29]).toBeCloseTo(1 + 29 / 30)
  })
})

describe('editing operations', () => {
  it('splits and removes clips', () => {
    const split = splitAt([clip('a', 0, 10)], 4)
    expect(split.map((c) => [c.start, c.end])).toEqual([
      [0, 4],
      [4, 10]
    ])
    expect(new Set(split.map((c) => c.id)).size).toBe(2)
    expect(removeClip(split, split[0].id).map((c) => c.start)).toEqual([4])
    expect(removeClip([clip('a', 0, 1)], 'a')).toHaveLength(1)
    expect(splitAt([clip('a', 0, 10)], 0.01)).toHaveLength(1)
  })

  it('cuts a range across clip boundaries', () => {
    const out = cutRange([clip('a', 0, 5), clip('b', 5, 10)], 3, 7)
    expect(out.map((c) => [c.start, c.end])).toEqual([
      [0, 3],
      [7, 10]
    ])
  })

  it('sets speed within limits', () => {
    expect(setClipSpeed(edit, 'b', 100)[1].speed).toBe(8)
    expect(setClipSpeed(edit, 'b', 0.01)[1].speed).toBe(0.25)
  })

  it('trims the start and end of the edit', () => {
    expect(setTrimStart(edit, 1).map((c) => [c.start, c.end])).toEqual([
      [1, 2],
      [4, 8]
    ])
    // trimming past the first clip drops it
    expect(setTrimStart(edit, 5).map((c) => [c.start, c.end])).toEqual([[5, 8]])
    expect(setTrimEnd(edit, 6, 10).map((c) => [c.start, c.end])).toEqual([
      [0, 2],
      [4, 6]
    ])
    expect(setTrimEnd(edit, 1, 10).map((c) => [c.start, c.end])).toEqual([[0, 1]])
  })

  it('normalizes overlapping, out-of-range and empty clip lists', () => {
    const n = normalizeClips([clip('b', 5, 12), clip('a', -1, 6)], 10)
    expect(n.map((c) => [c.start, c.end])).toEqual([
      [0, 6],
      [6, 10]
    ])
    expect(normalizeClips([], 3)).toHaveLength(1)
  })
})

describe('atempoChain', () => {
  it('keeps each atempo factor inside 0.5..2', () => {
    expect(atempoChain(1)).toBe('atempo=1')
    expect(atempoChain(1.5)).toBe('atempo=1.5')
    expect(atempoChain(8)).toBe('atempo=2,atempo=2,atempo=2')
    expect(atempoChain(0.25)).toBe('atempo=0.5,atempo=0.5')
    expect(atempoChain(3)).toBe('atempo=2,atempo=1.5')
  })
})
