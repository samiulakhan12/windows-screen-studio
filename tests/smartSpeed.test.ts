import { describe, expect, it } from 'vitest'
import { LEVEL_WINDOW, type AudioLevels } from '../src/shared/audio/loudness'
import { sourceActivity } from '../src/shared/audio/soundtrack'
import { outputDuration } from '../src/shared/engine/timeline'
import {
  applySmartSpeed,
  findIdleRanges,
  inputGaps,
  intersectRanges,
  keptRanges,
  mergeRanges,
  planSmartSpeed,
  rangeGaps,
  rangeSaving,
  type TimeRange
} from '../src/shared/editor/smartSpeed'
import type { Clip, CursorTrack, Project } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1, id = `c${start}`): Clip => ({ id, start, end, speed })

/** A cursor that moves continuously except inside `still` (source seconds). */
function track(duration: number, still: TimeRange[] = [], extra: Partial<CursorTrack> = {}): CursorTrack {
  const samples = []
  let x = 0.2
  for (let t = 0; t <= duration + 1e-9; t += 1 / 30) {
    const resting = still.some((r) => t > r.start && t < r.end)
    if (!resting) x += 0.01
    samples.push({ t: +t.toFixed(4), x, y: 0.5 })
  }
  return { samples, clicks: [], keys: [], valid: true, ...extra }
}

const round = (rs: TimeRange[]): TimeRange[] => rs.map((r) => ({ start: +r.start.toFixed(2), end: +r.end.toFixed(2) }))

/** `actual` has the ranges of `expected`, each end within `tol` seconds. */
function expectNear(actual: TimeRange[] | null, expected: TimeRange[], tol = 0.06): void {
  expect(actual, JSON.stringify(actual)).not.toBeNull()
  expect(actual!.length, JSON.stringify(actual)).toBe(expected.length)
  actual!.forEach((r, i) => {
    expect(Math.abs(r.start - expected[i].start), `start ${i}: ${JSON.stringify(actual)}`).toBeLessThanOrEqual(tol)
    expect(Math.abs(r.end - expected[i].end), `end ${i}: ${JSON.stringify(actual)}`).toBeLessThanOrEqual(tol)
  })
}

describe('range helpers', () => {
  it('merges overlapping and nearby ranges and drops empty ones', () => {
    expect(mergeRanges([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 1.5, end: 3 }, { start: 4, end: 4 }, { start: 7, end: 6 }])).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 }
    ])
    expect(mergeRanges([{ start: 1, end: 2 }, { start: 2.2, end: 3 }], 0.3)).toEqual([{ start: 1, end: 3 }])
    expect(mergeRanges([{ start: 1, end: 2 }, { start: 2.5, end: 3 }], 0.3)).toHaveLength(2)
    expect(mergeRanges([{ start: NaN, end: 2 }, { start: 0, end: Infinity }])).toEqual([])
  })

  it('intersects two lists', () => {
    const a = [{ start: 0, end: 4 }, { start: 6, end: 10 }]
    const b = [{ start: 2, end: 7 }, { start: 9, end: 12 }]
    expect(intersectRanges(a, b)).toEqual([
      { start: 2, end: 4 },
      { start: 6, end: 7 },
      { start: 9, end: 10 }
    ])
    expect(intersectRanges(a, [])).toEqual([])
  })

  it('treats neighbouring clips as one kept part and cuts as holes', () => {
    expect(keptRanges([clip(0, 3), clip(3, 5, 2), clip(7, 10)])).toEqual([
      { start: 0, end: 5 },
      { start: 7, end: 10 }
    ])
  })
})

describe('inputGaps', () => {
  it('finds stretches without movement, clicks, keys, typing or marks', () => {
    const t = track(20, [{ start: 4, end: 12 }], {
      clicks: [{ t: 8, x: 0.5, y: 0.5, button: 'left' }],
      keys: [{ t: 15.5, label: 'Ctrl + C' }]
    })
    const gaps = inputGaps(t, 20)!.filter((g) => g.end - g.start > 0.5)
    expectNear(gaps, [
      { start: 4.05, end: 7.95 },
      { start: 8.05, end: 12 }
    ])
    // A typing burst fills its whole span; marks count too.
    const typed = inputGaps(track(10, [{ start: 0, end: 10 }], { typing: [{ t: 2, end: 5 }], marks: [{ t: 8 }] }), 10)!
    expectNear(typed, [
      { start: 0, end: 1.95 },
      { start: 5.05, end: 7.95 },
      { start: 8.05, end: 10 }
    ])
  })

  it('ignores hand jitter but adds up a slow drift', () => {
    const jitter = { samples: [0, 1, 2, 3, 4, 5].map((t) => ({ t, x: 0.5 + (t % 2) * 0.001, y: 0.5 })), clicks: [], valid: true }
    expect(inputGaps(jitter, 5)).toEqual([{ start: 0, end: 5 }])
    const drift = { samples: Array.from({ length: 11 }, (_, i) => ({ t: i, x: 0.5 + i * 0.002, y: 0.5 })), clicks: [], valid: true }
    const gaps = inputGaps(drift, 10)!
    expect(gaps.length).toBeGreaterThan(2)
    expect(gaps.every((g) => g.end - g.start <= 2 + 1e-9)).toBe(true)
  })

  it('is unknown (null) without input data and whole without any input', () => {
    expect(inputGaps({ samples: [], clicks: [], valid: false }, 10)).toBeNull()
    expect(inputGaps({ samples: [], clicks: [], valid: true }, 10)).toEqual([{ start: 0, end: 10 }])
    // Events past the end are clamped.
    expect(inputGaps({ samples: [], clicks: [{ t: 30, x: 0, y: 0, button: 'left' }], valid: true }, 10)).toEqual([{ start: 0, end: 10 }])
  })
})

describe('findIdleRanges', () => {
  const base = { duration: 20, clips: [clip(0, 20)] }

  it('needs a still picture and no input, then pads both ends', () => {
    const still = [{ start: 3, end: 9 }, { start: 12, end: 18 }]
    const inactive = [{ start: 0, end: 10 }]
    expect(round(findIdleRanges({ ...base, still, inactive }, 2))).toEqual([{ start: 3.5, end: 8.5 }])
  })

  it('uses the picture alone when input is unknown', () => {
    const still = [{ start: 3, end: 9 }, { start: 12, end: 18 }]
    expect(round(findIdleRanges({ ...base, still, inactive: null }, 2))).toEqual([
      { start: 3.5, end: 8.5 },
      { start: 12.5, end: 17.5 }
    ])
  })

  it('drops parts shorter than the minimum and pads short parts less', () => {
    const still = [{ start: 1, end: 2.5 }, { start: 5, end: 6 }, { start: 10, end: 11.2 }]
    expect(round(findIdleRanges({ ...base, still, inactive: null }, 1.2))).toEqual([
      { start: 1.3, end: 2.2 },
      { start: 10.24, end: 10.96 }
    ])
  })

  it('joins still stretches split by a tiny change, but never across input', () => {
    const still = [{ start: 2, end: 5 }, { start: 5.2, end: 9 }]
    expect(round(findIdleRanges({ ...base, still, inactive: null }, 5))).toEqual([{ start: 2.5, end: 8.5 }])
    // A click at 5.1, as inputGaps reports it.
    const inactive = inputGaps({ samples: [], clicks: [{ t: 5.1, x: 0.5, y: 0.5, button: 'left' }], valid: true }, 20)!
    expectNear(findIdleRanges({ ...base, still, inactive }, 2), [
      { start: 2.5, end: 4.55 },
      { start: 5.65, end: 8.5 }
    ])
  })

  it('only counts what is still in the video and stays inside the recording', () => {
    const still = [{ start: 2, end: 14 }, { start: 18, end: 25 }]
    // 6–10 is cut; the trimmed end is at 19.
    const clips = [clip(0, 6), clip(10, 19)]
    expect(round(findIdleRanges({ duration: 20, clips, still, inactive: null }, 3))).toEqual([
      { start: 2.5, end: 5.5 },
      { start: 10.5, end: 13.5 }
    ])
  })
})

describe('planning and applying', () => {
  it('reports what each part saves and skips parts that are already fast', () => {
    const clips = [clip(0, 10), clip(10, 20, 8)]
    const input = { duration: 20, clips, still: [{ start: 2, end: 8 }, { start: 12, end: 18 }], inactive: null }
    const plan = planSmartSpeed(input, 2, 4)
    expect(round(plan.parts)).toEqual([{ start: 2.5, end: 7.5 }])
    expect(plan.parts[0].saved).toBeCloseTo(5 - 5 / 4)
    expect(plan.saved).toBeCloseTo(3.75)
    const cut = planSmartSpeed(input, 2, 'cut')
    expect(cut.parts).toHaveLength(2)
    expect(cut.saved).toBeCloseTo(5 + 5 / 8)
    expect(rangeSaving({ start: 0, end: 4 }, [clip(0, 2, 2), clip(2, 4)], 2)).toBeCloseTo(0 + 1)
  })

  it('speeds idle parts up in one go, leaving faster parts alone', () => {
    const clips = [clip(0, 5), clip(5, 7, 8, 'fast'), clip(7, 20)]
    const out = applySmartSpeed(clips, [{ start: 2, end: 10 }, { start: 14, end: 16 }], 4)
    expect(out.map((c) => [c.start, c.end, c.speed])).toEqual([
      [0, 2, 1],
      [2, 5, 4],
      [5, 7, 8],
      [7, 10, 4],
      [10, 14, 1],
      [14, 16, 4],
      [16, 20, 1]
    ])
    expect(outputDuration(out)).toBeCloseTo(20 - (3 + 3 + 2) * 0.75 - 2 + 2 / 8)
    // The planned saving is what applying saves.
    const plan = planSmartSpeed({ duration: 20, clips, still: [{ start: 1.5, end: 10.5 }, { start: 13.5, end: 16.5 }], inactive: null }, 2, 4)
    const applied = applySmartSpeed(clips, plan.parts, 4)
    expect(outputDuration(clips) - outputDuration(applied)).toBeCloseTo(plan.saved)
  })

  it('cuts idle parts, but never the whole video', () => {
    const clips = [clip(0, 20)]
    const out = applySmartSpeed(clips, [{ start: 3, end: 6 }, { start: 10, end: 12 }], 'cut')
    expect(out.map((c) => [c.start, c.end])).toEqual([
      [0, 3],
      [6, 10],
      [12, 20]
    ])
    expect(applySmartSpeed(clips, [{ start: 0, end: 20 }], 'cut')).toEqual(clips)
    expect(applySmartSpeed(clips, [], 4)).toBe(clips)
  })
})

describe('smart speed and the recording\'s sound', () => {
  // Still from 2.5 s to 11 s, no mouse or keyboard input after a click at 2 s.
  const base = { duration: 12, clips: [clip(0, 12)], still: [{ start: 2.5, end: 11 }], inactive: [{ start: 2.05, end: 12 }] }

  it('the parts of the recording outside some ranges', () => {
    expect(rangeGaps([{ start: 4, end: 9 }, { start: 8, end: 10 }, { start: 11, end: 20 }], 12)).toEqual([
      { start: 0, end: 4 },
      { start: 10, end: 11 }
    ])
    expect(rangeGaps([], 5)).toEqual([{ start: 0, end: 5 }])
    expect(rangeGaps([{ start: -1, end: 6 }], 5)).toEqual([])
  })

  it('someone talking over a still screen is not idle', () => {
    // Narration from 4 s to 9 s: no part of 3 s or more is left, and none covers the speech.
    const talking = { ...base, sound: [{ start: 4, end: 9 }] }
    expect(planSmartSpeed(talking, 3, 4).parts).toEqual([])
    const short = findIdleRanges(talking, 1)
    expect(round(short)).toEqual([
      { start: 2.8, end: 3.7 },
      { start: 9.4, end: 10.6 }
    ])
    for (const r of short) expect(intersectRanges([r], talking.sound)).toEqual([])
  })

  it('without sound, or with its sound unknown, the picture and the input decide as before', () => {
    const before = findIdleRanges(base, 3)
    expect(round(before)).toEqual([{ start: 3, end: 10.5 }])
    expect(findIdleRanges({ ...base, sound: null }, 3)).toEqual(before)
    // Measured and silent: nothing is heard anywhere.
    expect(findIdleRanges({ ...base, sound: [] }, 3)).toEqual(before)
  })

  it('takes the sound from the measured levels of the sources that are heard', () => {
    const levels = (db: number[]): AudioLevels => ({ window: LEVEL_WINDOW, power: Float32Array.from(db, (v) => 10 ** (v / 10)) })
    const run = (db: number, seconds: number): number[] => new Array(Math.round(seconds / LEVEL_WINDOW)).fill(db)
    // Room noise, and speech from 4 s to 9 s.
    const mix = levels([...run(-60, 4), ...run(-20, 5), ...run(-60, 3)])
    const sound = (p: Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>) => sourceActivity(p, { mix })
    const narrated = sound({ hasAudio: true, audio: { volume: 1, muted: false } })
    expect(round(narrated!)).toEqual([{ start: 4, end: 9 }])
    expect(planSmartSpeed({ ...base, sound: narrated }, 3, 4).parts).toEqual([])
    // Muted, or a recording without sound: nothing is heard, smart speed finds what it did before.
    for (const p of [{ hasAudio: true, audio: { volume: 1, muted: true } }, { hasAudio: false, audio: { volume: 1, muted: false } }]) {
      expect(round(findIdleRanges({ ...base, sound: sound(p) }, 3))).toEqual([{ start: 3, end: 10.5 }])
    }
  })
})
