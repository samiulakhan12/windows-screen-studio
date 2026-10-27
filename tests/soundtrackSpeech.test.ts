import { describe, expect, it } from 'vitest'
import { combineLevels, detectActivity, mergeRanges, type Range } from '../src/shared/audio/activity'
import { LEVEL_WINDOW, type AudioLevels } from '../src/shared/audio/loudness'
import { sourceActivity } from '../src/shared/audio/soundtrack'
import { speechActivity } from '../src/shared/audio/voice'
import type { Project } from '../src/shared/types'

/*
 * sourceActivity with the speech detector (docs/design/offline-captions.md §3.6): without speech
 * it is exactly today's rule (the regression lock); with speech each source has its own rule.
 */

/** `seconds` at `floorDb`, with louder parts ([start, end, db]). */
function levels(seconds: number, parts: [number, number, number][], floorDb = -70, speech?: Range[]): AudioLevels {
  const power = new Float32Array(Math.round(seconds / LEVEL_WINDOW)).fill(floorDb <= -200 ? 0 : 10 ** (floorDb / 10))
  for (const [s, e, db] of parts) for (let i = Math.round(s / LEVEL_WINDOW); i < Math.round(e / LEVEL_WINDOW); i++) power[i] = 10 ** (db / 10)
  return { window: LEVEL_WINDOW, power, ...(speech ? { speech } : {}) }
}
const r = (start: number, end: number): Range => ({ start, end })
const pairs = (ranges: readonly Range[] | null): [number, number][] | null => ranges && ranges.map((x) => [Number(x.start.toFixed(3)), Number(x.end.toFixed(3))])

type P = Omit<Pick<Project, 'hasAudio' | 'audioStems' | 'audio' | 'clips'>, 'clips'>
const stems: P = { hasAudio: true, audioStems: { mic: true, system: true }, audio: { volume: 1, muted: false } }
const mixed: P = { hasAudio: true, audio: { volume: 1, muted: false } }

/* Three envelopes: talking with clatter on the microphone and a notification on the PC; speech over a fan; a quiet bed. */
const mic = levels(20, [
  [1, 4, -22],
  [4.5, 6, -24],
  [9, 12, -38],
  [15, 15.4, -30]
])
const system = levels(20, [[7, 7.3, -40]], -90)
const fan = levels(20, [
  [2, 5, -40],
  [8, 9, -35]
], -48)
const bed = levels(20, [[0, 20, -45]], -60)

describe('the regression lock: no speech is exactly today', () => {
  it('deep-equals today’s rule (combineLevels + detectActivity) on three envelopes', () => {
    expect(sourceActivity(stems, { mic, system })).toEqual(detectActivity(combineLevels([mic, system])!))
    expect(sourceActivity(mixed, { mix: fan })).toEqual(detectActivity(fan))
    expect(sourceActivity(mixed, { mix: bed })).toEqual(detectActivity(bed))
  })

  it('and today’s literal ranges', () => {
    expect(pairs(sourceActivity(stems, { mic, system }))).toEqual([
      [1, 6],
      [7, 7.3],
      [9, 12],
      [15, 15.4]
    ])
    expect(pairs(sourceActivity(mixed, { mix: fan }))).toEqual([[8, 9]])
    // A steady bed is the noise floor: no sound.
    expect(pairs(sourceActivity(mixed, { mix: bed }))).toEqual([])
  })

  it('muted gives [], missing levels give null', () => {
    expect(sourceActivity({ ...stems, audio: { volume: 1, muted: true } }, { mic, system })).toEqual([])
    expect(sourceActivity(stems, { mic })).toBeNull()
    expect(sourceActivity(stems, { mic: { ...mic, speech: [r(1, 6)] } })).toBeNull()
  })
})

describe('with speech', () => {
  const voiced = { ...mic, speech: [r(1.1, 3.9), r(4.6, 5.9)] }

  it('mic speech (with tails) ∪ the system stem’s own sound; clatter on the mic does not count', () => {
    const got = sourceActivity(stems, { mic: voiced, system })!
    expect(got).toEqual(mergeRanges([...speechActivity(voiced.speech, detectActivity(mic)), ...detectActivity(system)]))
    expect(pairs(got)).toEqual([
      [1, 6],
      [7, 7.3]
    ])
  })

  it('the mixed track of a recording without stems: speech ∪ level, a superset of today’s', () => {
    const quiet = { ...fan, speech: [r(2, 5)] }
    const got = sourceActivity(mixed, { mix: quiet })!
    expect(pairs(got)).toEqual([
      [2, 5],
      [8, 9]
    ])
    for (const t of detectActivity(fan)) expect(got.some((g) => g.start <= t.start && g.end >= t.end)).toBe(true)
  })

  it('the trust guard: little speech against much sound uses the level', () => {
    const typing = levels(20, [[0, 12, -25]])
    const got = sourceActivity(stems, { mic: { ...typing, speech: [r(1, 2)] }, system })
    expect(got).toEqual(mergeRanges([...detectActivity(typing), ...detectActivity(system)]))
  })

  it('the system stem gets its own threshold: brief PC sounds on a silent stem still count', () => {
    const pings = levels(30, [
      [5, 5.3, -40],
      [12, 12.3, -40],
      [20, 20.3, -40]
    ], -100)
    const got = sourceActivity(stems, { mic: { ...levels(30, [[1, 3, -20]]), speech: [r(1, 3)] }, system: pings })!
    expect(pairs(got)).toEqual([
      [1, 3],
      [5, 5.3],
      [12, 12.3],
      [20, 20.3]
    ])
  })

  it('a system stem with a steady music bed keeps its louder events', () => {
    const music = levels(30, [
      [0, 30, -38],
      [10, 11, -20]
    ], -38)
    const got = sourceActivity(stems, { mic: { ...levels(30, [[1, 3, -20]]), speech: [r(1, 3)] }, system: music })!
    expect(pairs(got)).toContainEqual([10, 11])
    expect(pairs(got)).toContainEqual([1, 3])
  })
})
