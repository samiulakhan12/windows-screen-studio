import { describe, expect, it } from 'vitest'
import { ACTIVITY, type Range } from '../src/shared/audio/activity'
import { LEVEL_WINDOW, type AudioLevels } from '../src/shared/audio/loudness'
import { soundDetector, speechActivity, trustSpeech, VAD_TRUST, VOICE, withTails } from '../src/shared/audio/voice'
import type { Project } from '../src/shared/types'

/* What counts as sound once the speech detector has run (docs/design/offline-captions.md §3.6). */

const r = (start: number, end: number): Range => ({ start, end })
const near = (got: readonly Range[], want: [number, number][]): void => {
  expect(got.length).toBe(want.length)
  got.forEach((g, i) => {
    expect(g.start).toBeCloseTo(want[i][0], 6)
    expect(g.end).toBeCloseTo(want[i][1], 6)
  })
}

describe('withTails', () => {
  it('extends speech into touching sound by at most 0.3 s after and 0.1 s before', () => {
    expect(VOICE).toEqual({ tail: 0.3, lead: 0.1 })
    near(withTails([r(2, 4)], [r(1, 6)]), [[1.9, 4.3]])
  })

  it('stops at the edge of the sound it touches: never across a gap', () => {
    near(withTails([r(2, 4)], [r(1.95, 4.1), r(4.2, 6)]), [[1.95, 4.1]])
  })

  it('does not extend into sound that does not touch it', () => {
    near(withTails([r(2, 4)], [r(0, 1.5), r(4.5, 6)]), [[2, 4]])
  })

  it('drops clatter that touches no speech', () => {
    near(withTails([r(2, 4)], [r(2, 4), r(10, 12)]), [[2, 4]])
    expect(withTails([], [r(10, 12)])).toEqual([])
  })

  it('never starts before 0', () => {
    near(withTails([r(0.05, 1)], [r(0, 2)]), [[0, 1.3]])
  })
})

describe('speechActivity', () => {
  it('joins across ACTIVITY.hold and drops blips under ACTIVITY.minLength', () => {
    near(speechActivity([r(1, 2), r(2.4, 3), r(8, 8.1)], []), [[1, 3]])
    expect(ACTIVITY.hold).toBe(0.5)
    expect(ACTIVITY.minLength).toBe(0.12)
  })
})

describe('trustSpeech', () => {
  it('is false for 1.5 s of speech in 12 s of sound (a typing tutorial)', () => {
    expect(trustSpeech([r(1, 2.5)], [r(0, 12)])).toBe(false)
  })

  it('is true with 2 s of speech or more, or with less than 10 s of sound', () => {
    expect(trustSpeech([r(1, 3)], [r(0, 12)])).toBe(true)
    expect(trustSpeech([r(1, 2)], [r(0, 9.9)])).toBe(true)
    expect(trustSpeech([], [])).toBe(true)
    expect(VAD_TRUST).toEqual({ minSpeech: 2.0, minSound: 10.0 })
  })
})

/** `seconds` at `db` with louder parts ([start, end, db]). */
function levels(seconds: number, parts: [number, number, number][], speech?: Range[], floorDb = -70): AudioLevels {
  const power = new Float32Array(Math.round(seconds / LEVEL_WINDOW)).fill(10 ** (floorDb / 10))
  for (const [s, e, db] of parts) for (let i = Math.round(s / LEVEL_WINDOW); i < Math.round(e / LEVEL_WINDOW); i++) power[i] = 10 ** (db / 10)
  return { window: LEVEL_WINDOW, power, ...(speech ? { speech } : {}) }
}

type P = Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>
const stems: P = { hasAudio: true, audioStems: { mic: true, system: true }, audio: { volume: 1, muted: false } }
const mixed: P = { hasAudio: true, audio: { volume: 1, muted: false } }

describe('soundDetector', () => {
  const voice = levels(20, [[1, 6, -20]], [r(1, 6)])
  const system = levels(20, [[10, 11, -30]])
  it('speech: every voice source used the speech detector', () => {
    expect(soundDetector(stems, { mic: voice, system })).toBe('speech')
  })
  it('mixed: a recording without stems', () => {
    expect(soundDetector(mixed, { mix: voice })).toBe('mixed')
  })
  it('guard: the trust guard used the level', () => {
    expect(soundDetector(stems, { mic: levels(20, [[0, 12, -20]], [r(1, 2)]), system })).toBe('guard')
  })
  it('level: the speech detector did not run', () => {
    expect(soundDetector(stems, { mic: levels(20, [[1, 6, -20]]), system })).toBe('level')
    expect(soundDetector(mixed, { mix: levels(20, [[1, 6, -20]]) })).toBe('level')
  })
  it('null while levels are missing, or without sound', () => {
    expect(soundDetector(stems, { mic: voice })).toBeNull()
    expect(soundDetector({ ...mixed, hasAudio: false }, {})).toBeNull()
    expect(soundDetector({ ...mixed, audio: { volume: 1, muted: true } }, { mix: voice })).toBeNull()
  })
})
