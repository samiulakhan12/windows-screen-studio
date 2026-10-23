import { describe, expect, it } from 'vitest'
import {
  canSplitAt,
  correctProjectMedia,
  displayTime,
  outputTimeAt,
  restoreRange,
  setRangeSpeed,
  stepOutput,
  timelineGaps
} from '../src/shared/editor/clips'
import { createProject } from '../src/shared/engine/project'
import { cutRange, outputDuration } from '../src/shared/engine/timeline'
import type { Clip } from '../src/shared/types'

const clip = (id: string, start: number, end: number, speed = 1): Clip => ({ id, start, end, speed })
const spans = (clips: Clip[]): number[][] => clips.map((c) => [c.start, c.end, c.speed])

describe('timelineGaps', () => {
  it('lists trims and cuts in order', () => {
    expect(timelineGaps([clip('a', 1, 3), clip('b', 4, 8)], 10)).toEqual([
      { kind: 'trim-start', start: 0, end: 1 },
      { kind: 'cut', start: 3, end: 4 },
      { kind: 'trim-end', start: 8, end: 10 }
    ])
    expect(timelineGaps([clip('a', 0, 10)], 10)).toEqual([])
  })
})

describe('restoreRange', () => {
  it('merges neighbours with the same speed back into one clip', () => {
    const cut = cutRange([clip('a', 0, 10)], 3, 5)
    expect(spans(restoreRange(cut, 3, 5, 10))).toEqual([[0, 10, 1]])
    expect(restoreRange(cut, 3, 5, 10)[0].id).toBe('a')
  })

  it('restores at 1x next to a sped-up clip', () => {
    const clips = [clip('a', 0, 3, 2), clip('b', 5, 10, 2)]
    expect(spans(restoreRange(clips, 3, 5, 10))).toEqual([[0, 10, 2]])
    const mixed = [clip('a', 0, 3, 2), clip('b', 5, 10, 4)]
    expect(spans(restoreRange(mixed, 3, 5, 10))).toEqual([
      [0, 3, 2],
      [3, 5, 1],
      [5, 10, 4]
    ])
  })

  it('restores trimmed ends', () => {
    expect(spans(restoreRange([clip('a', 2, 8)], 0, 2, 10))).toEqual([[0, 8, 1]])
    expect(spans(restoreRange([clip('a', 2, 8)], 8, 10, 10))).toEqual([[2, 10, 1]])
  })

  it('fills only the missing parts of a partially kept range', () => {
    const clips = [clip('a', 0, 2), clip('b', 4, 6, 2), clip('c', 8, 10)]
    expect(spans(restoreRange(clips, 1, 9, 10))).toEqual([
      [0, 2, 1],
      [2, 4, 1],
      [4, 6, 2],
      [6, 8, 1],
      [8, 10, 1]
    ])
  })
})

describe('setRangeSpeed', () => {
  it('splits at both ends and speeds up only the inside', () => {
    const out = setRangeSpeed([clip('a', 0, 10)], 2, 6, 2)
    expect(spans(out)).toEqual([
      [0, 2, 1],
      [2, 6, 2],
      [6, 10, 1]
    ])
    expect(outputDuration(out)).toBeCloseTo(8)
  })
})

describe('playhead mapping', () => {
  const clips = [clip('a', 1, 3), clip('b', 5, 9, 2)]

  it('shows the next kept frame inside a cut and the last kept frame past the end', () => {
    expect(displayTime(clips, 0)).toBe(1)
    expect(displayTime(clips, 4)).toBe(5)
    expect(displayTime(clips, 6)).toBe(6)
    expect(displayTime(clips, 9.5)).toBe(9)
  })

  it('maps to output time', () => {
    expect(outputTimeAt(clips, 2)).toBeCloseTo(1)
    expect(outputTimeAt(clips, 4)).toBeCloseTo(2)
    expect(outputTimeAt(clips, 7)).toBeCloseTo(3)
    expect(outputTimeAt(clips, 9.5)).toBeCloseTo(4)
  })

  it('steps in output time across cuts', () => {
    expect(stepOutput(clips, 2.9, 0.2)).toBeCloseTo(5.2)
    expect(stepOutput(clips, 5.2, -0.2)).toBeCloseTo(2.9)
    expect(stepOutput(clips, 8, 10)).toBe(9)
    expect(stepOutput(clips, 2, -10)).toBe(1)
  })

  it('knows where a split is possible', () => {
    expect(canSplitAt(clips, 2)).toBe(true)
    expect(canSplitAt(clips, 4)).toBe(false)
    expect(canSplitAt(clips, 1.02)).toBe(false)
  })
})

describe('correctProjectMedia', () => {
  const base = createProject({
    id: 'p',
    name: 'p',
    duration: 10,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [{ id: 'z', start: 9, end: 10, scale: 2, focus: { mode: 'cursor' }, auto: true }],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })

  it('follows a shorter file and clamps overlays without dropping them', () => {
    const p = correctProjectMedia({ ...base, annotations: [{ id: 'a', start: 8, end: 10, text: 'x', x: 0.5, y: 0.5, size: 0.05, style: 'pill' }] }, {
      duration: 9.997,
      width: 1920,
      height: 1080
    })
    expect(p.duration).toBe(9.997)
    expect(p.clips[p.clips.length - 1].end).toBe(9.997)
    expect(p.zooms[0].end).toBe(9.997)
    expect(p.annotations[0].end).toBe(9.997)
  })

  it('extends clips that ended at the old duration when the file is longer', () => {
    const p = correctProjectMedia(base, { duration: 10.4, width: 1918, height: 1080 })
    expect(p.clips[0].end).toBe(10.4)
    expect(p.width).toBe(1918)
  })

  it('returns the same object when nothing differs', () => {
    expect(correctProjectMedia(base, { duration: 10, width: 1920, height: 1080 })).toBe(base)
  })
})
