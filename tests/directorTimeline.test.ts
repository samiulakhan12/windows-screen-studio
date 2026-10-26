import { describe, expect, it } from 'vitest'
import { rangesToOutput, type Range } from '../src/shared/audio/activity'
import { demoSpan, findHidden, findIntro, findOutro, HIDE, planTimeline, type TimelineInput } from '../src/shared/editor/directorTimeline'
import { DEFAULT_ZOOM_STYLE } from '../src/shared/engine/zoom'
import type { Clip, CursorTrack, ZoomSegment } from '../src/shared/types'

/*
 * The camera director's timeline (docs/design/camera-director.md, steps 5-9, test plan F2): the
 * demo span, the intro and outro, the hidden parts and the anti-flicker rule, all in output seconds.
 */

const r = (start: number, end: number): Range => ({ start, end })
const ranges = (list: [number, number][]): Range[] => list.map(([a, b]) => r(a, b))
const ONE: Clip[] = [{ id: 'c', start: 0, end: 60, speed: 1 }]

function track(over: Partial<CursorTrack> = {}): CursorTrack {
  return { samples: [], clicks: [], valid: true, ...over }
}
const clicksAt = (...ts: number[]): CursorTrack['clicks'] => ts.map((t) => ({ t, x: 0.5, y: 0.5, button: 'left' as const }))

function expectRange(got: Range | null | undefined, start: number, end: number, eps = 1e-6): void {
  expect(got).toBeTruthy()
  expect(got!.start).toBeCloseTo(start, Math.round(-Math.log10(eps)))
  expect(got!.end).toBeCloseTo(end, Math.round(-Math.log10(eps)))
}

function expectRanges(got: readonly Range[], want: [number, number][]): void {
  expect(got.length).toBe(want.length)
  want.forEach(([a, b], i) => expectRange(got[i], a, b))
}

// F2: T = 60, speech, clicks at 9, 12, 20 and 45.
const F2_SPEECH = ranges([
  [0.5, 7.8],
  [14, 22],
  [52, 59.5]
])
const F2_TRACK = track({ clicks: clicksAt(9, 12, 20, 45) })

const f2 = (over: Partial<TimelineInput> = {}): TimelineInput => ({
  total: 60,
  speech: F2_SPEECH,
  demo: demoSpan(F2_TRACK, [], ONE, DEFAULT_ZOOM_STYLE),
  locked: [],
  intro: true,
  hideAfter: 10,
  ...over
})

describe('F2: intro, outro and hidden parts', () => {
  it('finds the demo from the first to the last click', () => {
    expect(demoSpan(F2_TRACK, [], ONE, DEFAULT_ZOOM_STYLE)).toEqual({ start: 9, end: 45 })
  })

  it('ends the intro 1 s before the first action while still talking (no pause in [6, 8])', () => {
    expectRange(findIntro(F2_SPEECH, { start: 9, end: 45 }, []), 0, 8.0)
  })

  it('starts the outro 0.3 s before the next words after the demo', () => {
    expectRange(findOutro(F2_SPEECH, { start: 9, end: 45 }, 60, []), 51.7, 60)
  })

  it('hides in the silences of at least 10 s: [22, 52] gives [23.0, 51.7], [7.8, 14] stays shown', () => {
    const plan = planTimeline(f2())
    expectRange(plan.intro, 0, 8.0)
    expectRange(plan.outro, 51.7, 60)
    expectRanges(plan.hidden, [[23.0, 51.7]])
    expectRanges(plan.shown, [[8.0, 23.0]])
  })

  it('with hideAfter 5 also hides [8.0, 13.2], straight from the intro', () => {
    const plan = planTimeline(f2({ hideAfter: 5 }))
    expectRanges(plan.hidden, [
      [8.0, 13.2],
      [23.0, 51.7]
    ])
    expectRanges(plan.shown, [[13.2, 23.0]])
  })

  it('never hides with hideAfter 0 (Never)', () => {
    const plan = planTimeline(f2({ hideAfter: 0 }))
    expect(plan.hidden).toEqual([])
    expectRanges(plan.shown, [[8.0, 51.7]])
  })

  it('has no intro, outro or hiding without speech', () => {
    const plan = planTimeline(f2({ speech: null }))
    expect(plan).toEqual({ intro: null, outro: null, hidden: [], shown: [r(0, 60)] })
  })

  it('has no intro or outro when they are turned off, and hides from 1 s after the words', () => {
    const plan = planTimeline(f2({ intro: false }))
    expect(plan.intro).toBeNull()
    expect(plan.outro).toBeNull()
    expectRanges(plan.hidden, [[23.0, 51.2]])
  })
})

describe('the intro and the outro are checked', () => {
  const demo = { start: 9, end: 45 }

  it('rejects an intro whose first words come at 5 s', () => {
    expect(findIntro(ranges([[5, 7.8]]), demo, [])).toBeNull()
  })

  it('rejects an intro with speech under 40% of it', () => {
    expect(
      findIntro(
        ranges([
          [0.5, 1.5],
          [7.5, 7.8]
        ]),
        demo,
        []
      )
    ).toBeNull()
  })

  it('rejects an intro shorter than 3 s', () => {
    expect(findIntro(ranges([[0.5, 2]]), { start: 3.5, end: 20 }, [])).toBeNull()
  })

  it('snaps the intro into a pause of the speech before the first action', () => {
    // Still talking at e = 8: the pause [6.6, 7.0] lies in [6, 8], so the intro ends at its middle.
    const intro = findIntro(
      ranges([
        [0.5, 6.6],
        [7.0, 8.5]
      ]),
      demo,
      []
    )
    expectRange(intro, 0, 6.8)
  })

  it('cuts the intro at a layout change of the user and drops it when too short', () => {
    expectRange(findIntro(F2_SPEECH, demo, [r(5, 6)]), 0, 5)
    expect(findIntro(F2_SPEECH, demo, [r(2, 3)])).toBeNull()
  })

  it('drops the outro when the demo between them is under 4 s', () => {
    const speech = ranges([
      [0.5, 7.8],
      [12, 20]
    ])
    const plan = planTimeline({ total: 20, speech, demo: { start: 9, end: 9.5 }, locked: [], intro: true, hideAfter: 10 })
    // outroStart = 12 - 0.3 = 11.7, only 3.7 s after the intro.
    expect(findOutro(speech, { start: 9, end: 9.5 }, 20, [])).toBeTruthy()
    expectRange(plan.intro, 0, 8.0)
    expect(plan.outro).toBeNull()
  })

  it('starts the outro in a pause after the last action while still talking', () => {
    const speech = ranges([
      [40, 47.0],
      [47.4, 59]
    ])
    // b = 46.5 meets speech; the pause [47.0, 47.4] lies in [46.5, 49]: its middle.
    expectRange(findOutro(speech, demo, 60, []), 47.2, 60)
  })
})

describe('the demo span', () => {
  it('is null without events', () => {
    expect(demoSpan(track(), [], ONE, DEFAULT_ZOOM_STYLE)).toBeNull()
  })

  it('ignores the cursor track when it is not valid', () => {
    expect(demoSpan(track({ valid: false, clicks: clicksAt(5) }), [], ONE, DEFAULT_ZOOM_STYLE)).toBeNull()
  })

  it('ignores clicks outside the recorded frame', () => {
    expect(demoSpan(track({ clicks: [{ t: 5, x: 1.4, y: 0.5, button: 'left' }] }), [], ONE, DEFAULT_ZOOM_STYLE)).toBeNull()
  })

  it('counts a fast cursor sweep and ends the intro after the last words before it', () => {
    const samples = []
    for (let i = 0; i <= 200; i++) {
      const t = i / 10
      const k = Math.min(1, Math.max(0, (t - 8) / 0.5))
      samples.push({ t, x: 0.5 + 0.42 * k, y: 0.5 + 0.4 * k })
    }
    const demo = demoSpan(track({ samples }), [], ONE, DEFAULT_ZOOM_STYLE)
    expect(demo!.start).toBeCloseTo(8.0, 6)
    expect(demo!.end).toBeCloseTo(8.5, 6)
    // e = 7.0; the words end at 6.0: introEnd = min(7.0, 6.5).
    expectRange(findIntro(ranges([[0.5, 6.0]]), demo!, []), 0, 6.5)
  })

  it('does not count a slow drift or a short twitch as a sweep', () => {
    const slow = Array.from({ length: 201 }, (_, i) => ({ t: i / 10, x: 0.3 + i * 0.001, y: 0.5 }))
    expect(demoSpan(track({ samples: slow }), [], ONE, DEFAULT_ZOOM_STYLE)).toBeNull()
    const twitch = Array.from({ length: 201 }, (_, i) => ({ t: i / 10, x: i === 50 ? 0.6 : 0.5, y: 0.5 }))
    expect(demoSpan(track({ samples: twitch }), [], ONE, DEFAULT_ZOOM_STYLE)).toBeNull()
  })

  it('counts keys, typing and zoom-here marks', () => {
    expect(demoSpan(track({ keys: [{ t: 4, label: 'Ctrl+C' }] }), [], ONE, DEFAULT_ZOOM_STYLE)).toEqual({ start: 4, end: 4 })
    expect(demoSpan(track({ typing: [{ t: 4, end: 7 }] }), [], ONE, DEFAULT_ZOOM_STYLE)).toEqual({ start: 4, end: 7 })
    expect(demoSpan(track({ valid: false, marks: [{ t: 6 }] }), [], ONE, DEFAULT_ZOOM_STYLE)).toEqual({ start: 6, end: 6 })
  })

  it('counts zooms over [start, end - transition], also without cursor data', () => {
    const zoom: ZoomSegment = { id: 'z', start: 10, end: 20, scale: 2, focus: { mode: 'cursor' }, auto: false }
    const demo = demoSpan(track({ valid: false }), [zoom], ONE, DEFAULT_ZOOM_STYLE)
    expect(demo!.start).toBeCloseTo(10, 6)
    expect(demo!.end).toBeCloseTo(19.3, 6)
    const slow = demoSpan(track({ valid: false }), [{ ...zoom, transition: 2 }], ONE, DEFAULT_ZOOM_STYLE)
    expect(slow!.end).toBeCloseTo(18, 6)
  })

  it('counts scroll sessions of in-frame wheel events, so a demo can start or end with scrolling', () => {
    const wheel = (from: number, to: number, x = 0.5): CursorTrack['scrolls'] =>
      Array.from({ length: Math.round((to - from) / 0.25) + 1 }, (_, i) => ({ t: from + i * 0.25, x, y: 0.5, dx: 0, dy: -1 }))
    expect(demoSpan(track({ scrolls: wheel(8, 18), clicks: clicksAt(20, 26) }), [], ONE, DEFAULT_ZOOM_STYLE)).toEqual({ start: 8, end: 26 })
    expect(demoSpan(track({ scrolls: wheel(30, 40), clicks: clicksAt(20, 26) }), [], ONE, DEFAULT_ZOOM_STYLE)).toEqual({ start: 20, end: 40 })
    // One wheel event is an instant; wheel events outside the frame, or without valid input, do not count.
    expect(demoSpan(track({ scrolls: wheel(12, 12) }), [], ONE, DEFAULT_ZOOM_STYLE)).toEqual({ start: 12, end: 12 })
    expect(demoSpan(track({ scrolls: wheel(8, 18, 1.4), clicks: clicksAt(20) }), [], ONE, DEFAULT_ZOOM_STYLE)).toEqual({ start: 20, end: 20 })
    expect(demoSpan(track({ valid: false, scrolls: wheel(8, 18) }), [], ONE, DEFAULT_ZOOM_STYLE)).toBeNull()
  })

  it('does not count the move to stop the recording at the end (the e2e recording)', () => {
    // 48 s; the move into the demo at 8.0-8.5, clicks at 13-25, then the mouse goes to the
    // taskbar over 47.0-47.5 (its click at 47.8 is a stray 'end' one, not in the effective track).
    const clips: Clip[] = [{ id: 'c', start: 0, end: 48, speed: 1 }]
    const samples = []
    for (let i = 0; i <= 480; i++) {
      const t = i / 10
      const k = Math.min(1, Math.max(0, (t - 8) / 0.5))
      const j = Math.min(1, Math.max(0, (t - 47) / 0.5))
      samples.push({ t, x: 0.5 + 0.42 * k - 0.42 * j, y: 0.5 + 0.4 * k + 0.09 * j })
    }
    const stop = track({ samples, clicks: [13, 16, 19, 22, 25].map((t) => ({ t, x: 0.92, y: 0.9, button: 'left' as const })) })
    const demo = demoSpan(stop, [], clips, DEFAULT_ZOOM_STYLE)
    expect(demo).toEqual({ start: 8, end: 25 })
    const speech = ranges([
      [0.5, 6],
      [17, 22],
      [34, 46.5]
    ])
    expectRange(planTimeline({ total: 48, speech, demo, locked: [], intro: true, hideAfter: 10 }).outro, 33.7, 48)
    // Without any other event the move into the demo still counts, the one at the end does not.
    expect(demoSpan(track({ samples }), [], clips, DEFAULT_ZOOM_STYLE)).toEqual({ start: 8, end: 8.5 })
    // Input after it (a shortcut at 47.9) makes it part of the demo again.
    expect(demoSpan({ ...stop, keys: [{ t: 47.9, label: 'Ctrl+S' }] }, [], clips, DEFAULT_ZOOM_STYLE)).toEqual({ start: 8, end: 47.9 })
    // Earlier in the video, the same move counts.
    expect(demoSpan(stop, [], ONE, DEFAULT_ZOOM_STYLE)?.end).toBeCloseTo(47.5, 6)
  })

  it('does not count movement off the recorded frame as a sweep', () => {
    // While talking (0.5-6), the mouse moves on another monitor (x = 1.6) from y 0.2 to 0.8 over 2-3 s.
    const samples = Array.from({ length: 101 }, (_, i) => {
      const t = i / 10
      return { t, x: 1.6, y: 0.2 + 0.6 * Math.min(1, Math.max(0, t - 2)) }
    })
    const demo = demoSpan(track({ samples, clicks: clicksAt(9) }), [], ONE, DEFAULT_ZOOM_STYLE)
    expect(demo).toEqual({ start: 9, end: 9 })
    expectRange(findIntro(ranges([[0.5, 6]]), demo!, []), 0, 6.5)
    // Just past the right edge (over a covering window), or one jump off the frame: no sweep either.
    const edge = samples.map((p) => ({ ...p, x: 1.001 }))
    expect(demoSpan(track({ samples: edge }), [], ONE, DEFAULT_ZOOM_STYLE)).toBeNull()
    const jump = Array.from({ length: 31 }, (_, i) => ({ t: i / 10, x: i < 15 ? 0.5 : 1.6, y: 0.5 }))
    expect(demoSpan(track({ samples: jump }), [], ONE, DEFAULT_ZOOM_STYLE)).toBeNull()
  })

  it('drops events inside cuts and maps the rest to output time', () => {
    const clips: Clip[] = [
      { id: 'a', start: 0, end: 10, speed: 1 },
      { id: 'b', start: 15, end: 30, speed: 2 }
    ]
    expect(demoSpan(track({ clicks: clicksAt(12, 20) }), [], clips, DEFAULT_ZOOM_STYLE)).toEqual({ start: 12.5, end: 12.5 })
    expect(demoSpan(track({ clicks: clicksAt(12) }), [], clips, DEFAULT_ZOOM_STYLE)).toBeNull()
  })
})

describe('hidden parts', () => {
  it('hide straight from the intro and until the outro', () => {
    const hidden = findHidden(F2_SPEECH, [r(8, 51.7)], 5, r(0, 8), r(51.7, 60), 60)
    expectRanges(hidden, [
      [8.0, 13.2],
      [23.0, 51.7]
    ])
  })

  it('hide from the very start and until the very end without an intro or outro', () => {
    const hidden = findHidden(ranges([[20, 30]]), [r(0, 60)], 10, null, null, 60)
    expectRanges(hidden, [
      [0, 19.2],
      [31, 60]
    ])
  })

  it('stay outside locked ranges and are at least 5 s long', () => {
    const hidden = findHidden(ranges([[20, 30]]), [r(0, 3), r(5, 60)], 10, null, null, 60)
    expectRanges(hidden, [
      [5, 19.2],
      [31, 60]
    ])
  })
})

describe('the anti-flicker rule (MIN_SHOWN)', () => {
  const input = (speech: Range[]): TimelineInput => ({ total: 40, speech, demo: null, locked: [], intro: true, hideAfter: 5 })

  it('absorbs a 2 s bubble gap without speech between two hidden parts', () => {
    const plan = planTimeline(
      input(
        ranges([
          [0, 10],
          [20, 20.2],
          [30.2, 40]
        ])
      )
    )
    // [11, 19.2] and [21.2, 29.4] with only 0.2 s of speech between them: one hidden part.
    expectRanges(plan.hidden, [[11, 29.4]])
    expectRanges(plan.shown, [
      [0, 11],
      [29.4, 40]
    ])
  })

  it('grows a bubble gap with 2 s of speech to 4 s, taking the time from the hidden parts', () => {
    const plan = planTimeline(
      input(
        ranges([
          [0, 10],
          [20, 22],
          [32, 40]
        ])
      )
    )
    // [19.2, 23.0] is 3.8 s: 0.1 s from each neighbour.
    expectRanges(plan.hidden, [
      [11, 19.1],
      [23.1, 31.2]
    ])
    expect(plan.shown[1].end - plan.shown[1].start).toBeCloseTo(HIDE.minShown, 6)
  })

  it('shows a hidden neighbour instead when giving the time would leave it under 5 s', () => {
    const plan = planTimeline(
      input(
        ranges([
          [0, 10],
          [16.8, 18.8],
          [30, 40]
        ])
      )
    )
    // [11, 16.0] would drop to 4.9 s: shown with the bubble gap.
    expectRanges(plan.hidden, [[19.8, 29.2]])
    expectRanges(plan.shown, [
      [0, 19.8],
      [29.2, 40]
    ])
  })

  it('joins a short bubble gap to the intro', () => {
    // Intro [0, 8.0]; the outro would start at 11.7; shown [8, 11.7] is 3.7 s: dropped outro, so
    // the demo is [8, 20]; with the locked range from 10 the bubble piece [8, 10] joins the intro.
    const plan = planTimeline({
      total: 20,
      speech: ranges([
        [0.5, 7.8],
        [12, 20]
      ]),
      demo: { start: 9, end: 9.5 },
      locked: [r(10, 20)],
      intro: true,
      hideAfter: 10
    })
    expectRange(plan.intro, 0, 10)
    expect(plan.shown).toEqual([])
  })

  it('leaves short bubble time between the user\'s segments alone', () => {
    const plan = planTimeline({ total: 40, speech: null, demo: null, locked: [r(0, 10), r(12, 40)], intro: true, hideAfter: 10 })
    expectRanges(plan.shown, [[10, 12]])
  })
})

describe('cuts and speed', () => {
  // clips [{0, 10, x1}, {15, 30, x2}]: a hidden part needs 10 s of OUTPUT silence.
  const clips: Clip[] = [
    { id: 'a', start: 0, end: 10, speed: 1 },
    { id: 'b', start: 15, end: 30, speed: 2 }
  ]
  const speech = rangesToOutput(
    ranges([
      [0.5, 4],
      [15.5, 16]
    ]),
    clips
  )

  it('does not hide 14 s of source silence in the 2x clip (7 s of output) after 10 s', () => {
    expectRanges(speech, [
      [0.5, 4],
      [10.25, 10.5]
    ])
    const plan = planTimeline({ total: 17.5, speech, demo: null, locked: [], intro: false, hideAfter: 10 })
    expect(plan.hidden).toEqual([])
  })

  it('hides it after 5 s', () => {
    const plan = planTimeline({ total: 17.5, speech, demo: null, locked: [], intro: false, hideAfter: 5 })
    expectRanges(plan.hidden, [[11.5, 17.5]])
  })

  it('does hide the same source silence after 10 s at normal speed', () => {
    const normal = rangesToOutput(
      ranges([
        [0.5, 4],
        [15.5, 16]
      ]),
      [{ id: 'c', start: 0, end: 30, speed: 1 }]
    )
    const plan = planTimeline({ total: 30, speech: normal, demo: null, locked: [], intro: false, hideAfter: 10 })
    // [5, 14.7] and [17, 30]; the 2.3 s between them holds 0.5 s of speech, so they join.
    expectRanges(plan.hidden, [[5, 30]])
  })
})
