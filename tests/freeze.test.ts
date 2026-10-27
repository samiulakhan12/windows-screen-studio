// Freeze frames (E-11): the plan, the time maps between edit, video and source time, and the
// frames an export draws (docs/design/freeze-frame.md §4.1–4.3).
import { describe, expect, it } from 'vitest'
import {
  editToVideo,
  freezeKeepRanges,
  freezePlan,
  freezeSnapTargets,
  NO_FREEZES,
  pictureTime,
  planOf,
  videoDuration,
  videoFrames,
  videoTimeAt,
  videoToEdit,
  videoToSource
} from '../src/shared/engine/freeze'
import { exportFrameTimes } from '../src/shared/engine/timeline'
import type { Clip, Freeze } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `c${start}`, start, end, speed })
const freeze = (id: string, at: number, length = 3, sound: Freeze['sound'] = 'pause'): Freeze => ({ id, at, length, sound })

/** The worked example: [0,4) at 1×, [6,10) at 2× (6 s of edit); pause at 2 for 3 s, continue at 7 for 1.5 s. */
const clips = [clip(0, 4), clip(6, 10, 2)]
const freezes = [freeze('p', 2), freeze('k', 7, 1.5, 'continue')]

describe('the plan', () => {
  it('puts each pause freeze into the video at its edit time and each continue freeze over its span (worked example)', () => {
    const plan = freezePlan(clips, freezes)
    expect(plan.holds).toEqual([{ id: 'p', at: 2, edit: 2, start: 2, length: 3, end: false }])
    expect(plan.stills).toEqual([{ id: 'k', at: 7, editStart: 4.5, editEnd: 6 }])
    expect(plan.added).toBe(3)
    expect(plan.inactive).toEqual([])
    expect(videoDuration(clips, plan)).toBe(9)
  })

  it('starts each hold after the holds before it, in edit order', () => {
    const plan = freezePlan(clips, [freeze('b', 8, 1), freeze('a', 1, 2.5)])
    expect(plan.holds.map((h) => [h.id, h.edit, h.start])).toEqual([
      ['a', 1, 1],
      ['b', 5, 7.5]
    ])
    expect(plan.added).toBe(3.5)
  })

  it('leaves a freeze whose frame is cut inactive (and it comes back with the frame)', () => {
    const plan = freezePlan(clips, [freeze('cut', 5), freeze('p', 2)])
    expect(plan.inactive).toEqual(['cut'])
    expect(plan.holds.map((h) => h.id)).toEqual(['p'])
    expect(freezePlan([clip(0, 10)], [freeze('cut', 5)]).holds.map((h) => h.edit)).toEqual([5])
  })

  it('ends a continue span at the next active freeze, at the end of the video, or after its length', () => {
    const one = [clip(0, 20)]
    const two = freezePlan(one, [freeze('a', 4, 3, 'continue'), freeze('b', 5, 3, 'continue')])
    expect(two.stills).toEqual([
      { id: 'a', at: 4, editStart: 4, editEnd: 5 },
      { id: 'b', at: 5, editStart: 5, editEnd: 8 }
    ])
    // A pause freeze ends it too; a cut freeze does not.
    expect(freezePlan(one, [freeze('a', 4, 3, 'continue'), freeze('p', 6)]).stills[0].editEnd).toBe(6)
    expect(freezePlan(clips, [freeze('a', 3, 3, 'continue'), freeze('cut', 5)]).stills[0].editEnd).toBe(6)
    // The end of the video.
    expect(freezePlan(one, [freeze('a', 19, 3, 'continue')]).stills[0].editEnd).toBe(20)
    // A speed change inside the span never shortens it: the span is in seconds of the video.
    expect(freezePlan(clips, [freeze('a', 3, 2, 'continue')]).stills[0]).toEqual({ id: 'a', at: 3, editStart: 3, editEnd: 5 })
  })

  it('leaves a continue freeze at the edit end inactive (nothing plays after it) and marks a hold there as the end', () => {
    const plan = freezePlan(clips, [freeze('k', 10, 3, 'continue'), freeze('a', 9.99, 3, 'continue')])
    expect(plan.inactive.sort()).toEqual(['a', 'k'])
    expect(plan.stills).toEqual([])
    const end = freezePlan(clips, [freeze('e', 10, 1)])
    expect(end.holds).toEqual([{ id: 'e', at: 10, edit: 6, start: 6, length: 1, end: true }])
  })

  it('is NO_FREEZES without freezes, and memoised on the clips and freezes', () => {
    expect(planOf({ clips })).toBe(NO_FREEZES)
    expect(planOf({ clips, freezes: [] })).toBe(NO_FREEZES)
    expect(freezePlan(clips, undefined)).toBe(NO_FREEZES)
    const a = planOf({ clips, freezes })
    expect(planOf({ clips, freezes })).toBe(a)
    expect(planOf({ clips, freezes: [...freezes] })).not.toBe(a)
  })
})

describe('time maps', () => {
  const plan = freezePlan(clips, freezes)

  it('edit to video: a hold AT an edit time comes first, holds before it add their length', () => {
    expect(editToVideo(plan, 0)).toBe(0)
    expect(editToVideo(plan, 2)).toBe(2)
    expect(editToVideo(plan, 2.5)).toBe(5.5)
    expect(editToVideo(plan, 6)).toBe(9)
  })

  it('video to edit and source: inside a hold, its frame and how far into it', () => {
    const r = videoToEdit(plan, 3.2)
    expect(r.edit).toBe(2)
    expect(r.hold?.id).toBe('p')
    expect(r.elapsed).toBeCloseTo(1.2, 9)
    expect(videoToEdit(plan, 1)).toEqual({ edit: 1, hold: null, elapsed: 0 })
    expect(videoToEdit(plan, 2)).toMatchObject({ edit: 2, elapsed: 0 })
    expect(videoToEdit(plan, 5)).toEqual({ edit: 2, hold: null, elapsed: 0 })
    expect(videoToEdit(plan, 8)).toEqual({ edit: 5, hold: null, elapsed: 0 })
    expect(videoToSource(clips, plan, 4)).toMatchObject({ time: 2, index: 0 })
    expect(videoToSource(clips, plan, 8)).toEqual({ time: 8, index: 1, hold: null })
    for (const v of [0, 1.7, 5.01, 6.25, 8.9]) expect(editToVideo(plan, videoToEdit(plan, v).edit)).toBeCloseTo(v, 9)
    // The end of a hold is its frame again, which starts the hold (a hold AT an edit time comes first).
    expect(editToVideo(plan, videoToEdit(plan, 5).edit)).toBe(2)
  })

  it('video time of a playhead: through cuts to the next clip, the edit end is the video end', () => {
    expect(videoTimeAt(clips, plan, 2)).toBe(2)
    expect(videoTimeAt(clips, plan, 3)).toBe(6)
    expect(videoTimeAt(clips, plan, 5)).toBe(7)
    expect(videoTimeAt(clips, plan, 10)).toBe(9)
    const end = freezePlan(clips, [freeze('e', 10, 1)])
    expect(videoTimeAt(clips, end, 10)).toBe(7)
    expect(videoTimeAt(clips, end, 9.9)).toBeCloseTo(5.95, 9)
  })

  it('picture time: a still anchor inside its span, else the time itself', () => {
    expect(pictureTime(clips, plan, 7.5)).toBe(7)
    expect(pictureTime(clips, plan, 7)).toBe(7)
    expect(pictureTime(clips, plan, 6.9)).toBe(6.9)
    expect(pictureTime(clips, plan, 9.99)).toBe(7)
    expect(pictureTime(clips, plan, 2)).toBe(2)
    expect(pictureTime(clips, plan, 5)).toBe(5)
  })

  it('snap targets: active anchors and still ends, in source seconds', () => {
    expect(freezeSnapTargets(clips, plan)).toEqual([2, 7, 10])
    expect(freezeSnapTargets(clips, freezePlan(clips, [freeze('cut', 5), freeze('k', 1, 2, 'continue')]))).toEqual([1, 3])
    expect(freezeSnapTargets(clips, NO_FREEZES)).toEqual([])
  })

  it('keep ranges: a quarter second on each side of every anchor', () => {
    expect(freezeKeepRanges([freeze('a', 5)])).toEqual([{ start: 4.75, end: 5.25 }])
  })
})

describe('export frames', () => {
  it('hold and still frames of the worked example at 60 fps', () => {
    const { times, pictures, held } = videoFrames(clips, freezePlan(clips, freezes), 60)
    expect(times).toHaveLength(540)
    expect(times[119]).toBeCloseTo(1.9833, 4)
    for (let i = 120; i < 300; i++) expect(times[i]).toBe(2)
    // Moving again from the held frame.
    expect(times[300]).toBe(2)
    expect(times[301]).toBeCloseTo(2 + 1 / 60, 9)
    expect(times[420]).toBe(6)
    expect(pictures[449]).toBeCloseTo(6.9667, 4)
    for (let i = 450; i < 540; i++) expect(pictures[i]).toBe(7)
    // The sound's clock goes on under the still.
    expect(times[450]).toBe(7)
    expect(times[539]).toBeCloseTo(7 + (89 / 60) * 2, 9)
    for (let i = 0; i < 540; i++) expect(held![i], `frame ${i}`).toBe((i >= 120 && i < 300) || i >= 450 ? 1 : 0)
    for (let i = 1; i < 540; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
      expect(pictures[i]).toBeGreaterThanOrEqual(pictures[i - 1])
    }
  })

  it('without freezes, and with stills only, the frame times are exportFrameTimes', () => {
    const none = videoFrames(clips, NO_FREEZES, 60)
    expect(none.times).toEqual(exportFrameTimes(clips, 60))
    expect(none.pictures).toBe(none.times)
    expect(none.held).toBeNull()
    for (const fps of [24, 30, 60]) {
      const stills = videoFrames(clips, freezePlan(clips, [freeze('k', 7, 1.5, 'continue')]), fps)
      expect(stills.times).toEqual(exportFrameTimes(clips, fps))
      expect(stills.pictures).not.toBe(stills.times)
      expect(stills.held!.reduce((a, b) => a + b, 0)).toBe(Math.round(1.5 * fps))
    }
    // All inactive: nothing changes.
    const inactive = videoFrames(clips, freezePlan(clips, [freeze('cut', 5)]), 60)
    expect(inactive.times).toEqual(exportFrameTimes(clips, 60))
    expect(inactive.held).toBeNull()
  })

  it('a hold at the edit end repeats the last frame exported', () => {
    const four = [clip(0, 4)]
    const { times, pictures, held } = videoFrames(four, freezePlan(four, [freeze('e', 4, 1)]), 60)
    expect(times).toHaveLength(300)
    expect(times[239]).toBeCloseTo(3.9833, 4)
    for (let i = 240; i < 300; i++) {
      expect(times[i]).toBe(times[239])
      expect(pictures[i]).toBe(times[239])
      expect(held![i]).toBe(1)
    }
    // After a still that runs to the end, the end hold keeps its picture.
    const after = videoFrames(four, freezePlan(four, [freeze('k', 3.5, 3, 'continue'), freeze('e', 4, 1)]), 60)
    for (let i = 240; i < 300; i++) expect([after.times[i], after.pictures[i]]).toEqual([after.times[239], 3.5])
  })

  it('every hold is exactly length × fps frames when that is whole, wherever it starts', () => {
    const plan = freezePlan([clip(0.3, 5.3, 1.5)], [freeze('a', 1.234, 0.5), freeze('b', 3.003, 2.3)])
    const { held } = videoFrames([clip(0.3, 5.3, 1.5)], plan, 30)
    expect(held!.reduce((a, b) => a + b, 0)).toBe(Math.round(2.8 * 30))
  })
})
