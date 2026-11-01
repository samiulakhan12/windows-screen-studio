// Review mode's row times (docs/design/review-mode.md §4.3, §6): every row's video time worked out in
// one pass over the clips (videoTimesAt) gives the same numbers videoTimeAt gives row by row, and the
// panel's labels (rowTimes) are kept by start for each clips array and freeze plan.
import { describe, expect, it } from 'vitest'
import { freezePlan, NO_FREEZES, videoTimeAt, videoTimesAt } from '../src/shared/engine/freeze'
import { formatTime } from '../src/shared/engine/project'
import { normalizeClips, SPEED_PRESETS } from '../src/shared/engine/timeline'
import { rowTimes } from '../src/shared/review/times'
import type { Clip, Freeze } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `c${start}`, start, end, speed })
const freeze = (id: string, at: number, length = 3, sound: Freeze['sound'] = 'pause'): Freeze => ({ id, at, length, sound })

/** Mulberry32: the same draws for a seed on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Each time as videoTimeAt maps it by itself. */
const oneByOne = (clips: Clip[], plan: ReturnType<typeof freezePlan>, ts: readonly number[]): number[] => ts.map((t) => videoTimeAt(clips, plan, t))

/** Same numbers, bit for bit (NaN as NaN, -0 as -0). */
function same(a: readonly number[], b: readonly number[]): void {
  expect(a.length).toBe(b.length)
  a.forEach((x, k) => expect(Object.is(x, b[k]), `at ${k}: ${x} vs ${b[k]}`).toBe(true))
}

describe('videoTimesAt', () => {
  /** [0,4) at 1×, [6,10) at 2×; a pause at 2 for 3 s, a continue at 7, a pause at the end. */
  const clips = [clip(0, 4), clip(6, 10, 2)]
  const plan = freezePlan(clips, [freeze('p', 2), freeze('k', 7, 1.5, 'continue'), freeze('e', 10, 1)])

  it('maps every kind of time as videoTimeAt does: in a clip, in a cut, at the edges, before, past the end, not finite', () => {
    const ts = [0, 1, 2, 3.999, 4, 5, 5.999, 6, 7, 9.5, 10, 11, -1, -Infinity, Infinity, NaN, 2, 0.5]
    for (const p of [NO_FREEZES, plan]) {
      const all = videoTimesAt(clips, p, ts)
      same(all, oneByOne(clips, p, ts))
    }
    // The worked example's numbers: 2 is the pause's start, the cut 4-6 goes on at 6 (edit 4 + 3 s held).
    expect(videoTimesAt(clips, plan, [2, 5, 10])).toEqual([2, 7, 10])
  })

  it('takes the times in any order and keeps their order in the answer', () => {
    const ts = [9, 0.5, 6.5, 0.5, 3, 12, 1]
    same(videoTimesAt(clips, plan, ts), oneByOne(clips, plan, ts))
    expect(videoTimesAt(clips, plan, [])).toEqual([])
  })

  it('maps clips never put in order (overlapping, backwards) one time at a time, as before', () => {
    const odd = [clip(5, 8), clip(0, 6), clip(9, 9)]
    const ts = [0, 4, 5.5, 7, 9, 10]
    same(videoTimesAt(odd, NO_FREEZES, ts), oneByOne(odd, NO_FREEZES, ts))
  })

  it('gives the same numbers on random edits, speeds and freezes (500 seeds)', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed)
      const duration = 20 + Math.floor(r() * 200)
      const raw: Clip[] = []
      for (let s = r() * 2; s < duration; ) {
        const len = 0.05 + r() * 8
        raw.push(clip(+s.toFixed(3), +Math.min(duration, s + len).toFixed(3), SPEED_PRESETS[Math.floor(r() * SPEED_PRESETS.length)]))
        s += len + (r() < 0.5 ? 0 : r() * 4)
      }
      const clips = normalizeClips(raw, duration)
      const freezes = Array.from({ length: Math.floor(r() * 6) }, (_, k) =>
        freeze(`f${k}`, r() < 0.2 ? clips[Math.floor(r() * clips.length)].start : r() * duration, 0.5 + Math.floor(r() * 30) / 10, r() < 0.7 ? 'pause' : 'continue')
      )
      const plan = freezePlan(clips, freezes)
      const edges = clips.flatMap((c) => [c.start, c.end, c.end - 1e-12, c.start - 1e-9])
      const ts = [...Array.from({ length: 300 }, () => -1 + r() * (duration + 2)), ...edges, ...freezes.map((f) => f.at)]
      // Shuffled, with repeats.
      for (let k = ts.length - 1; k > 0; k--) {
        const j = Math.floor(r() * (k + 1))
        ;[ts[k], ts[j]] = [ts[j], ts[k]]
      }
      same(videoTimesAt(clips, plan, ts), oneByOne(clips, plan, ts))
    }
  })
})

/** A 3-hour recording's clips with a pause every 4 s cut (2,700 clips) and its 8,098 rows' starts. */
function longCut(): { clips: Clip[]; starts: number[] } {
  const clips: Clip[] = []
  const starts: number[] = []
  for (let k = 0; k < 2700; k++) {
    clips.push(clip(k * 4, k * 4 + 1.5))
    starts.push(k * 4 + 1.5, k * 4 + 1.5, k * 4 + 3.7)
  }
  return { clips, starts: starts.slice(0, 8098).sort((a, b) => a - b) }
}

describe('rowTimes', () => {
  it('is each start’s video time as m:ss.t, freeze frames counted', () => {
    const clips = [clip(0, 4), clip(6, 10, 2)]
    const plan = freezePlan(clips, [freeze('p', 2)])
    const items = [{ start: 3 }, { start: 0 }, { start: 5 }, { start: 9 }]
    expect(rowTimes(items, clips, plan)).toEqual(items.map((i) => formatTime(videoTimeAt(clips, plan, i.start))))
    expect(rowTimes(items, clips, plan)).toEqual(['0:06.0', '0:00.0', '0:07.0', '0:08.5'])
    // Another plan for the same clips (a freeze added) reads the times again.
    expect(rowTimes(items, clips, NO_FREEZES)).toEqual(['0:03.0', '0:00.0', '0:04.0', '0:05.5'])
  })

  it('works out thousands of rows over thousands of clips in one pass, and reads them back for the same clips', () => {
    const { clips, starts } = longCut()
    const items = starts.map((start) => ({ start }))
    const t0 = performance.now()
    const labels = rowTimes(items, clips, NO_FREEZES)
    const first = performance.now() - t0
    const t1 = performance.now()
    const again = rowTimes([...items], clips, NO_FREEZES)
    const second = performance.now() - t1
    expect(again).toEqual(labels)
    // Every 50th row as videoTimeAt reads it alone (all of them that way take 40 ms or more).
    for (let k = 0; k < items.length; k += 50) expect(labels[k]).toBe(formatTime(videoTimeAt(clips, NO_FREEZES, items[k].start)))
    expect(labels.slice(0, 4)).toEqual(['0:01.5', '0:01.5', '0:01.5', '0:03.0'])
    expect(first).toBeLessThan(40)
    expect(second).toBeLessThan(10)
  })
})
