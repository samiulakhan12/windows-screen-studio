/**
 * The guide's steps from the recording (docs/design/smart-tools.md §5.1): tests 9–13, 30 and 111 of
 * §22.1.
 */
import { describe, expect, it } from 'vitest'
import type { SceneScan } from '../src/shared/api/projects'
import { effectiveTrack } from '../src/shared/engine/inputTrack'
import { createProject } from '../src/shared/engine/project'
import { findSteps, STEP_RULES, stepKey, typedBefore } from '../src/shared/guide/steps'
import { badgeLabels } from '../src/shared/render/callouts'
import type { Annotation, ClickEvent, CursorTrack, Project } from '../src/shared/types'

const W = 1920
const H = 1080

function project(duration = 60, patch: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'Billing',
    duration,
    width: W,
    height: H,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps: 60 }
  })
  return { ...p, ...patch }
}

function track(patch: Partial<CursorTrack> = {}): CursorTrack {
  return { samples: [], clicks: [], valid: true, scale: 1, ...patch }
}

const click = (t: number, x = 0.5, y = 0.5, extra: Partial<ClickEvent> = {}): ClickEvent => ({ t, x, y, button: 'left', ...extra })
const px = (n: number): number => n / W

const steps = (t: CursorTrack, p: Project = project(), scan: SceneScan | null = null) => findSteps({ track: t, project: p, scan })

describe('test 9: clicks, double-clicks, drags, repeats, buttons, ignored clicks and cuts', () => {
  it('a click is a step keyed by its time', () => {
    const out = steps(track({ clicks: [click(3)] }))
    expect(out).toEqual([{ key: 'c3000', t: 3, kind: 'click', x: 0.5, y: 0.5 }])
    expect(stepKey('click', 3)).toBe('c3000')
  })

  it('two presses 0.49 s and 3 px apart are one double-click; 0.51 s or 5 px are two clicks', () => {
    expect(steps(track({ clicks: [click(8), click(8.49, 0.5 + px(3))] })).map((s) => s.kind)).toEqual(['double'])
    expect(steps(track({ clicks: [click(8), click(8.49, 0.5 + px(3))] }))[0].key).toBe('c8000')
    // Not a double-click: two clicks (on the same spot in a row, one step "2 times", rule 4).
    expect(steps(track({ clicks: [click(8), click(8.51, 0.5 + px(3))] })).map((s) => [s.kind, s.times])).toEqual([['click', 2]])
    expect(steps(track({ clicks: [click(8), click(8.49, 0.5 + px(5))] })).map((s) => [s.kind, s.times])).toEqual([['click', 2]])
  })

  it('the double-click distance grows with the display scale', () => {
    expect(steps(track({ scale: 1.5, clicks: [click(8), click(8.3, 0.5 + px(5))] })).map((s) => s.kind)).toEqual(['double'])
  })

  it('a press held 0.24 s is a click; 0.26 s with 0.03 of the height travelled is a drag with `to`', () => {
    const samples = [
      { t: 16, x: 0.3, y: 0.3 },
      { t: 16.5, x: 0.3, y: 0.33 }
    ]
    const short = steps(track({ samples, clicks: [click(16.4, 0.3, 0.3, { up: 16.64 })] }))
    expect(short.map((s) => s.kind)).toEqual(['click'])
    const drag = steps(track({ samples: [{ t: 16, x: 0.3, y: 0.3 }, { t: 16.26, x: 0.3, y: 0.33 }, { t: 17, x: 0.3, y: 0.33 }], clicks: [click(16, 0.3, 0.3, { up: 16.26 })] }))
    expect(drag).toHaveLength(1)
    expect(drag[0].kind).toBe('drag')
    expect(drag[0].to!.y).toBeCloseTo(0.33, 5)
    // Held long enough but hardly moved: a click.
    const still = steps(track({ samples: [{ t: 16, x: 0.3, y: 0.3 }, { t: 17, x: 0.3, y: 0.31 }], clicks: [click(16, 0.3, 0.3, { up: 17 })] }))
    expect(still.map((s) => s.kind)).toEqual(['click'])
  })

  it('clicks of one button on one spot in a row are one step "3 times"', () => {
    const out = steps(track({ clicks: [click(10), click(11.2, 0.5 + px(10)), click(12.6, 0.5 + px(11))] }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'click', times: 3, key: 'c10000' })
    // 1.6 s later, or 13 px from the first, is a new step.
    expect(steps(track({ clicks: [click(10), click(11.6)] }))).toHaveLength(2)
    expect(steps(track({ clicks: [click(10), click(11, 0.5 + px(13))] }))).toHaveLength(2)
  })

  it('right and middle buttons have their own kinds; coordinates outside the frame are dropped', () => {
    const out = steps(track({ clicks: [click(1, 0.2, 0.2, { button: 'right' }), click(4, 0.8, 0.8, { button: 'middle' }), click(6, 1.2, 0.5)] }))
    expect(out.map((s) => s.kind)).toEqual(['right', 'middle'])
  })

  it('ignored and stray clicks are gone through the effective track', () => {
    const p = project(60, { inputEdits: { ignoredClicks: [{ ms: 5000 }, { ms: 7000, stray: 'start' }] } })
    const recorded = track({ clicks: [click(5), click(7), click(9)] })
    const out = steps(effectiveTrack(recorded, p), p)
    expect(out.map((s) => s.key)).toEqual(['c9000'])
  })

  it('a click whose time is cut is dropped', () => {
    const p = project(60, { clips: [{ id: 'a', start: 0, end: 10, speed: 1 }, { id: 'b', start: 20, end: 60, speed: 1 }] })
    expect(steps(track({ clicks: [click(5), click(15), click(25)] }), p).map((s) => s.t)).toEqual([5, 25])
  })
})

describe('test 10: typing and key presses', () => {
  it('typing joins a click 4.9 s before it, not one 5.1 s before', () => {
    const joined = steps(track({ clicks: [click(20)], typing: [{ t: 24.9, end: 26 }] }))
    expect(joined).toHaveLength(1)
    expect(joined[0]).toMatchObject({ key: 'c20000', kind: 'click', typing: { t: 24.9, end: 26, place: { x: 0.5, y: 0.5 } } })
    const alone = steps(track({ clicks: [click(20)], typing: [{ t: 25.1, end: 26 }] }))
    expect(alone.map((s) => s.kind)).toEqual(['click', 'type'])
    expect(alone[1].key).toBe('t25100')
    expect(alone[0].typing).toBeUndefined()
    // The click typed into is the field: the lone burst's place.
    expect(alone[1].typing!.place).toEqual({ x: 0.5, y: 0.5 })
  })

  it('typing does not join a click with another click between', () => {
    const out = steps(track({ clicks: [click(20, 0.2, 0.2), click(22, 0.7, 0.7)], typing: [{ t: 24.9, end: 26 }] }))
    expect(out[0].typing).toBeUndefined()
    expect(out[1].typing).toBeDefined()
  })

  it('bursts 5.9 s apart are one burst, 6.1 s apart are two', () => {
    const one = steps(track({ typing: [{ t: 10, end: 11 }, { t: 16.9, end: 18 }] }))
    expect(one).toHaveLength(1)
    expect(one[0].typing).toMatchObject({ t: 10, end: 18 })
    expect(steps(track({ typing: [{ t: 10, end: 11 }, { t: 17.1, end: 18 }] }))).toHaveLength(2)
  })

  it('a lone burst of 0.4 s is dropped, one of 0.5 s is a step', () => {
    expect(steps(track({ typing: [{ t: 10, end: 10.4 }] }))).toEqual([])
    expect(steps(track({ typing: [{ t: 10, end: 10.5 }] })).map((s) => s.kind)).toEqual(['type'])
  })

  it('Enter 1.4 s after a burst joins it; keys inside a burst are not steps', () => {
    const out = steps(track({ typing: [{ t: 10, end: 12 }], keys: [{ t: 11, label: 'Ctrl + A' }, { t: 12.2, label: 'Ctrl + B' }, { t: 13.4, label: 'Enter' }] }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'type', then: 'Enter' })
    // 1.6 s after: its own step.
    const late = steps(track({ typing: [{ t: 10, end: 12 }], keys: [{ t: 13.6, label: 'Enter' }] }))
    expect(late.map((s) => s.kind)).toEqual(['type', 'keys'])
    expect(late[0].then).toBeUndefined()
  })

  it('key presses are steps with their label; the same label repeated is "Press Tab 3 times"', () => {
    const out = steps(track({ keys: [{ t: 30, label: 'Ctrl + S' }, { t: 40, label: 'Tab' }, { t: 41, label: 'Tab' }, { t: 42.4, label: 'Tab' }, { t: 45, label: 'Tab' }] }))
    expect(out.map((s) => [s.key, s.keys, s.times])).toEqual([
      ['k30000', 'Ctrl + S', undefined],
      ['k40000', 'Tab', 3],
      ['k45000', 'Tab', undefined]
    ])
  })
})

describe('test 11: scrolling before a step', () => {
  it('a scroll session 9 s before a click adds "scroll down"; one 11 s before is dropped', () => {
    const near = steps(track({ scrolls: [{ t: 1, x: 0.5, y: 0.5, dx: 0, dy: 3 }], clicks: [click(10)] }))
    expect(near[0].scroll).toBe('down')
    const far = steps(track({ scrolls: [{ t: 1, x: 0.5, y: 0.5, dx: 0, dy: 3 }], clicks: [click(12)] }))
    expect(far[0].scroll).toBeUndefined()
    const up = steps(track({ scrolls: [{ t: 1, x: 0.5, y: 0.5, dx: 0, dy: -2 }], clicks: [click(3)] }))
    expect(up[0].scroll).toBe('up')
  })
})

/** A scan sampled every 0.25 s: quiet, with `changes` (time → % changed) settling after each. */
function scanWith(duration: number, changes: Record<number, number>): SceneScan {
  const t: number[] = []
  const changed: number[] = []
  for (let i = 0; i * 0.25 <= duration; i++) {
    const at = i * 0.25
    t.push(at)
    changed.push(changes[at] ?? 0)
  }
  return { step: 0.25, t, changed, stills: [] }
}

describe('test 12: no usable clicks', () => {
  const scan = scanWith(40, { 5: 40, 12: 62, 21.25: 15, 33: 20 })

  it('an invalid track keeps its key and typing steps and adds one step per settled screen change', () => {
    const invalid = track({ valid: false, clicks: [click(2)], keys: [{ t: 20, label: 'Enter' }, { t: 31, label: 'Ctrl + S' }], typing: [{ t: 25, end: 27 }] })
    const out = steps(invalid, project(), scan)
    expect(out.map((s) => s.key)).toEqual(['s5000', 's12000', 'k20000', 't25000', 'k31000', 's33000'])
  })

  it('a change 1.2 s after an Enter step adds none; one 2 s after adds one', () => {
    const t1 = track({ valid: false, keys: [{ t: 20, label: 'Enter' }] })
    expect(steps(t1, project(), scanWith(40, { 21.25: 40 })).map((s) => s.kind)).toEqual(['keys'])
    expect(steps(t1, project(), scanWith(40, { 22: 40 })).map((s) => s.kind)).toEqual(['keys', 'screen'])
  })

  it('a valid track with no clicks does the same; nothing at all gives no steps', () => {
    const out = steps(track({ keys: [{ t: 20, label: 'Enter' }] }), project(), scan)
    expect(out.map((s) => s.kind)).toEqual(['screen', 'screen', 'keys', 'screen'])
    expect(steps(track(), project(), null)).toEqual([])
    expect(steps(track({ valid: false }), project(), scanWith(40, {}))).toEqual([])
  })

  it('with clicks, screen changes are not steps', () => {
    expect(steps(track({ clicks: [click(2)] }), project(), scan).map((s) => s.kind)).toEqual(['click'])
  })
})

describe('test 13: keys are stable', () => {
  it('cutting the video before a step, or adding a step, keeps the other keys; a step in a cut leaves the list', () => {
    const t = track({ clicks: [click(5), click(15), click(25)], keys: [{ t: 30, label: 'Ctrl + S' }] })
    const before = steps(t).map((s) => s.key)
    const cut = project(60, { clips: [{ id: 'a', start: 0, end: 10, speed: 1 }, { id: 'b', start: 20, end: 60, speed: 1 }] })
    expect(steps(t, cut).map((s) => s.key)).toEqual(before.filter((k) => k !== 'c15000'))
    const added = project(60, { guide: { added: [{ key: 'a12000', t: 12, title: 'Step' }], steps: [{ key: 'c15000', title: 'Mine' }] } })
    expect(steps(t, added).map((s) => s.key)).toEqual(['c5000', 'a12000', 'c15000', 'c25000', 'k30000'])
    // The edit of a cut step stays in the project.
    const both = { ...cut, guide: added.guide }
    expect(steps(t, both).map((s) => s.key)).not.toContain('c15000')
    expect(both.guide!.steps![0].key).toBe('c15000')
  })

  it('at most 200 steps, the first in time', () => {
    const many = track({ clicks: Array.from({ length: 300 }, (_, i) => click(i * 2, (i % 10) / 10, 0.5)) })
    const out = steps(many, project(700))
    expect(out).toHaveLength(STEP_RULES.maxSteps)
    expect(out[199].t).toBe(398)
  })
})

describe('test 111: steps from the step badges', () => {
  const badge = (id: string, start: number, pin?: { x: number; y: number }): Annotation => ({
    id,
    start,
    end: start + 3,
    text: '',
    x: 0.5,
    y: 0.5,
    size: 0.05,
    style: 'badge',
    number: 'auto',
    ...(pin ? { pin } : {})
  })

  it('badges give steps numbered by badgeLabels, keyed b<ms>; the clicks between are listed hidden', () => {
    const p = project(60, { annotations: [badge('a', 4, { x: 0.2, y: 0.3 }), badge('b', 14), badge('c', 24)], guide: { from: 'badges' } })
    const out = steps(track({ clicks: [click(6), click(16)] }), p)
    const labels = badgeLabels(p)
    expect(out.map((s) => s.key)).toEqual(['b4000', 'c6000', 'b14000', 'c16000', 'b24000'])
    expect(out.filter((s) => s.kind === 'badge').map((s) => s.badge!.label)).toEqual(['a', 'b', 'c'].map((id) => labels.get(id)))
    expect(out[0].place).toEqual({ x: 0.2, y: 0.3 })
    expect(out[2].place).toBeUndefined()
    expect(out.filter((s) => s.hiddenByDefault).map((s) => s.key)).toEqual(['c6000', 'c16000'])
    // Without from: 'badges', the clicks.
    expect(steps(track({ clicks: [click(6), click(16)] }), { ...p, guide: undefined }).map((s) => s.key)).toEqual(['c6000', 'c16000'])
  })

  it('a section heading where the labels start again at a chapter; a badge in a cut gives no step', () => {
    const p = project(60, {
      annotations: [badge('a', 4), badge('b', 14), badge('c', 34), badge('d', 44), badge('e', 55)],
      chapters: [
        { id: 'k1', t: 0, title: 'Set up' },
        { id: 'k2', t: 30, title: 'Billing' }
      ],
      clips: [{ id: 'x', start: 0, end: 50, speed: 1 }],
      guide: { from: 'badges' }
    })
    const out = steps(track(), p)
    expect(out.map((s) => s.key)).toEqual(['b4000', 'b14000', 'b34000', 'b44000'])
    expect(out.map((s) => s.badge!.label)).toEqual(['1', '2', '1', '2'])
    expect(out.map((s) => s.badge!.section)).toEqual(['Set up', undefined, 'Billing', undefined])
  })

  it('found chapters waiting for review do not start a section', () => {
    const p = project(60, {
      annotations: [badge('a', 4), badge('b', 34)],
      chapters: [
        { id: 'k1', t: 0, title: 'Set up' },
        { id: 'k2', t: 30, title: 'Billing', auto: { by: 'find', from: ['screen'], name: 'sentence' } }
      ],
      guide: { from: 'badges' }
    })
    expect(steps(track(), p).map((s) => s.badge!.section)).toEqual([undefined, undefined])
  })
})

describe('test 30: performance', () => {
  it('findSteps over 10,000 clicks, 2,000 keys and 500 bursts under 50 ms; typedBefore over 200 steps under 5 ms (× 6 on CI)', () => {
    const clicks: ClickEvent[] = []
    for (let i = 0; i < 10_000; i++) clicks.push(click(i * 0.4, ((i * 37) % 100) / 100, ((i * 53) % 100) / 100, i % 7 === 0 ? { up: i * 0.4 + 0.3 } : {}))
    const samples = Array.from({ length: 40_000 }, (_, i) => ({ t: i * 0.1, x: ((i * 13) % 100) / 100, y: ((i * 29) % 100) / 100 }))
    const keys = Array.from({ length: 2000 }, (_, i) => ({ t: i * 2 + 0.17, label: i % 3 ? 'Tab' : 'Ctrl + S' }))
    const typing = Array.from({ length: 500 }, (_, i) => ({ t: i * 8 + 0.05, end: i * 8 + 1.2 }))
    const big = track({ samples, clicks, keys, typing, scrolls: Array.from({ length: 500 }, (_, i) => ({ t: i * 7.3, x: 0.5, y: 0.5, dx: 0, dy: 1 })) })
    const p = project(4100)
    const limit = process.env.CI ? 300 : 50
    findSteps({ track: big, project: p, scan: null })
    let best = Infinity
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now()
      findSteps({ track: big, project: p, scan: null })
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(limit)

    const twoHundred = Array.from({ length: 200 }, (_, i) =>
      i % 2 ? { key: `c${i * 1000}`, t: i, kind: 'click' as const, x: 0.5, y: 0.5 } : { key: `t${i * 1000}`, t: i, kind: 'type' as const, typing: { t: i, end: i + 0.8, place: { x: 0.5, y: 0.5 } } }
    )
    const shots = new Map(twoHundred.map((s) => [s.key, { t: s.t + 0.9, rect: { x: 400, y: 200, w: 950, h: 534 }, whole: false }]))
    const scan = scanWith(200, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i * 5 + 0.5, 50])))
    typedBefore(twoHundred, shots, scan, { w: W, h: H })
    let bestTyped = Infinity
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now()
      typedBefore(twoHundred, shots, scan, { w: W, h: H })
      bestTyped = Math.min(bestTyped, performance.now() - t0)
    }
    expect(bestTyped).toBeLessThan(process.env.CI ? 30 : 5)
  })
})
