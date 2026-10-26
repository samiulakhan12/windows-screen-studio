import { describe, expect, it } from 'vitest'
import type { Range } from '../src/shared/audio/activity'
import type { DirectorSpeech } from '../src/shared/audio/speech'
import { applyDirectorPlan, clearDirected, planDirector, spliceDirected, withoutDirected, type DirectorInput, type DirectorPlan } from '../src/shared/editor/cameraDirector'
import { INTRO, OUTRO } from '../src/shared/editor/directorTimeline'
import { setCornerAt } from '../src/shared/editor/layoutCommands'
import { cornerOnly, dragLayout, removeLayout, updateLayout } from '../src/shared/editor/layouts'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { directorSettingsOf } from '../src/shared/engine/directorData'
import { layoutRamps } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import { normalizeClips, outputDuration, sourceToOutput } from '../src/shared/engine/timeline'
import { readLayouts } from '../src/shared/engine/webcamData'
import { focusPathFor } from '../src/shared/engine/zoom'
import type { FramingOutcome } from '../src/shared/render/faceFraming'
import type { CameraLayout, Clip, Corner, CursorSample, CursorTrack, DirectorSettings, LayoutSegment, Project, ZoomSegment } from '../src/shared/types'

/*
 * The camera director (docs/design/camera-director.md, steps 2-14 and Apply). The shared fixture
 * is the e2e one, in output = source time: 48 s, one clip, 1280x720, padding 0, webcam 0.24
 * bottom-right; the cursor rests at (0.5, 0.5) until 8.0, moves to (0.92, 0.9) by 8.5 and stays
 * there with left clicks at 13, 16, 19, 22 and 25; the person talks over 0.5-6, 17-22 and 34-46.5.
 */

const seg = (id: string, start: number, end: number, layout: CameraLayout, extra: Partial<LayoutSegment> = {}): LayoutSegment => ({ id, start, end, layout, ...extra })

function e2eProject(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 48,
    width: 1280,
    height: 720,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  p.style = { ...p.style, padding: 0 }
  p.webcam = { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }
  return { ...p, ...over }
}

function e2eCursor(): CursorTrack {
  const samples: CursorSample[] = []
  for (let i = 0; i <= 480; i++) {
    const t = i / 10
    const k = Math.min(1, Math.max(0, (t - 8) / 0.5))
    samples.push({ t, x: 0.5 + 0.42 * k, y: 0.5 + 0.4 * k })
  }
  return { samples, clicks: [13, 16, 19, 22, 25].map((t) => ({ t, x: 0.92, y: 0.9, button: 'left' as const })), valid: true }
}
const CURSOR = e2eCursor()

const SPEECH: DirectorSpeech = {
  source: 'mic',
  refined: false,
  ranges: [
    { start: 0.5, end: 6 },
    { start: 17, end: 22 },
    { start: 34, end: 46.5 }
  ]
}

function counter(prefix = 'a'): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

const input = (project: Project, over: Partial<DirectorInput> = {}): DirectorInput => ({ project, cursor: CURSOR, speech: SPEECH, newId: counter(), ...over })
const direct = (project: Project, over: Partial<DirectorInput> = {}, settings: Partial<DirectorSettings> = {}): DirectorPlan =>
  planDirector(input(project, over), { ...directorSettingsOf(project), ...settings })

const SKIPPED: FramingOutcome = { status: 'skipped' }

/** Compares segments with times to 1e-6. */
function expectLayouts(got: readonly LayoutSegment[], want: LayoutSegment[]): void {
  expect(got.length).toBe(want.length)
  want.forEach((w, i) => {
    const { start, end, ...rest } = got[i]
    const { start: ws, end: we, ...wrest } = w
    expect(rest).toEqual(wrest)
    expect(start).toBeCloseTo(ws, 6)
    expect(end).toBeCloseTo(we, 6)
  })
}

const F1: LayoutSegment[] = [
  seg('a1', 0, 6.5, 'camera-only', { auto: true }),
  seg('a2', 6.5, 16.2, 'screen-only', { auto: true }),
  seg('a3', 16.2, 23.0, 'default', { corner: 'bottom-left', auto: true }),
  seg('a4', 23.0, 33.7, 'screen-only', { auto: true }),
  seg('a5', 33.7, 48, 'camera-only', { auto: true })
]

describe('F1: the e2e recording with default settings', () => {
  const p = e2eProject()
  const plan = direct(p)

  it('writes the intro, the hidden parts, the bubble in bottom-left and the outro, touching', () => {
    expectLayouts(plan.layouts, F1)
    for (let i = 1; i < plan.layouts.length; i++) expect(plan.layouts[i].start).toBe(plan.layouts[i - 1].end)
  })

  it('opens and ends on the full camera with no animation; every change is at most 0.4 s', () => {
    const directed = { ...p, layouts: plan.layouts }
    const ramps = plan.layouts.map((s) => layoutRamps(directed, s))
    expect(ramps[0].in).toBe(0)
    expect(ramps[ramps.length - 1].out).toBe(0)
    for (const r of ramps) {
      expect(r.in).toBeLessThanOrEqual(0.4)
      expect(r.out).toBeLessThanOrEqual(0.4)
    }
  })

  it('lists the parts with their reasons', () => {
    expect(plan.parts.map((x) => [x.kind, x.layout, x.corner ?? null, x.ids])).toEqual([
      ['intro', 'camera-only', null, ['a1']],
      ['hidden', 'screen-only', null, ['a2']],
      ['corner', 'default', 'bottom-left', ['a3']],
      ['hidden', 'screen-only', null, ['a4']],
      ['outro', 'camera-only', null, ['a5']]
    ])
    expect(plan.parts.map((x) => x.reason)).toEqual([
      { kind: 'talk-before' },
      { kind: 'silent', seconds: 11 },
      { kind: 'cursor', avoided: 'bottom-right' },
      { kind: 'silent', seconds: 12 },
      { kind: 'talk-after' }
    ])
    expect(plan.parts[2].outStart).toBeCloseTo(16.2, 6)
    expect(plan.parts[2].end).toBeCloseTo(23.0, 6)
  })

  it('describes the plan: strip, camera share, framing cap, notes, diff', () => {
    expect(plan.strip.map((s) => [s.state, s.corner ?? null])).toEqual([
      ['intro', null],
      ['hidden', null],
      ['bubble', 'bottom-left'],
      ['hidden', null],
      ['outro', null]
    ])
    expect(plan.cameraShare).toBeCloseTo((48 - 9.7 - 10.7) / 48, 6)
    expect(plan.framingCap).toBe(1.3)
    expectRangesClose(plan.cameraShown, [
      [0, 6.5],
      [16.2, 23.0],
      [33.7, 48]
    ])
    expect(plan.notes).toEqual([])
    expect(plan.diff).toEqual({ added: 5, removed: 0, unchanged: 0 })
    expect(plan.upToDate).toBe(false)
    expect(plan.kept).toEqual({ changes: 0, positions: 0 })
  })

  it('builds the cursor and focus paths itself, or uses the editor\'s, with the same result', () => {
    const cursorPath = new SmoothedTrack(CURSOR.samples, 48, p.cursor.smoothing)
    const focusPath = focusPathFor(CURSOR.samples, 48)
    expect(direct(p, { cursorPath, focusPath }).layouts).toEqual(plan.layouts)
  })
})

describe('the demo, as the person ends and scrolls through it', () => {
  it('keeps the outro when the mouse goes to the taskbar to stop the recording', () => {
    // The e2e cursor, then a move to (0.5, 0.99) over 47.0-47.5; the stop click at 47.8 is a
    // stray 'end' one, which the effective track the director gets leaves out.
    const samples = CURSOR.samples.map((p) => {
      const j = Math.min(1, Math.max(0, (p.t - 47) / 0.5))
      return { ...p, x: p.x - 0.42 * j, y: p.y + 0.09 * j }
    })
    const plan = direct(e2eProject(), { cursor: { ...CURSOR, samples } })
    expectLayouts(plan.layouts, F1)
    expect(plan.parts.map((x) => x.kind)).toEqual(['intro', 'hidden', 'corner', 'hidden', 'outro'])
  })

  // 60 s, talking throughout, the cursor still; wheel events every 0.25 s.
  const talking: DirectorSpeech = { source: 'mic', refined: false, ranges: [{ start: 0.3, end: 59.5 }] }
  const still: CursorSample[] = Array.from({ length: 601 }, (_, i) => ({ t: i / 10, x: 0.5, y: 0.5 }))
  const wheel = (from: number, to: number): NonNullable<CursorTrack['scrolls']> =>
    Array.from({ length: Math.round((to - from) / 0.25) + 1 }, (_, i) => ({ t: from + i * 0.25, x: 0.5, y: 0.5, dx: 0, dy: -1 }))
  const click = (t: number): CursorTrack['clicks'][number] => ({ t, x: 0.5, y: 0.5, button: 'left' })
  const sixty = (): Project => e2eProject({ duration: 60, clips: [{ id: 'c', start: 0, end: 60, speed: 1 }] })

  it('does not cover scrolling before the first click with the intro', () => {
    const cursor: CursorTrack = { samples: still, clicks: [click(35)], scrolls: wheel(5, 30), valid: true }
    const plan = direct(sixty(), { cursor, speech: talking })
    const intro = plan.parts.find((x) => x.kind === 'intro')!
    expect(intro.outStart).toBe(0)
    expect(intro.outEnd).toBeCloseTo(4, 6)
  })

  it('does not cover scrolling after the last click with the outro', () => {
    const cursor: CursorTrack = { samples: still, clicks: [click(6), click(10)], scrolls: wheel(12, 40), valid: true }
    const plan = direct(sixty(), { cursor, speech: talking })
    const outro = plan.parts.find((x) => x.kind === 'outro')!
    expect(outro.outStart).toBeCloseTo(41.5, 6)
    expect(outro.outEnd).toBe(60)
  })
})

function expectRangesClose(got: readonly Range[], want: [number, number][]): void {
  expect(got.length).toBe(want.length)
  want.forEach(([a, b], i) => {
    expect(got[i].start).toBeCloseTo(a, 6)
    expect(got[i].end).toBeCloseTo(b, 6)
  })
}

describe('F4: recorded camera positions are cut, kept and given back whole', () => {
  const base = [
    seg('rec1', 10, 24, 'default', { corner: 'top-left' }),
    seg('m1', 24, 27, 'side-by-side', { corner: 'top-left' }),
    seg('rec1b', 27, 48, 'default', { corner: 'top-left' })
  ]
  const p = e2eProject({ layouts: base })
  const plan = direct(p)

  it('resolves the corners to keep for a project with camera positions', () => {
    expect(plan.settings.corners).toBe('keep')
    expect(plan.notes).toContain('kept-positions')
  })

  it('writes the cut-outs with the position\'s corner and ids', () => {
    expectLayouts(plan.layouts, [
      seg('a1', 0, 6.5, 'camera-only', { auto: true }),
      seg('a2', 6.5, 10, 'screen-only', { auto: true }),
      seg('a3', 10, 16.2, 'screen-only', { corner: 'top-left', auto: true, cutOut: true }),
      seg('rec1', 16.2, 24, 'default', { corner: 'top-left' }),
      base[1],
      seg('rec1b', 27, 33.7, 'screen-only', { corner: 'top-left', auto: true, cutOut: true }),
      seg('a4', 33.7, 48, 'camera-only', { corner: 'top-left', auto: true, cutOut: true })
    ])
    expect(plan.layouts[4]).toBe(base[1])
    expect(plan.kept).toEqual({ changes: 1, positions: 2 })
  })

  it('withoutDirected gives the base back exactly, ids included', () => {
    expect(withoutDirected(plan.layouts)).toEqual(base)
    expect(clearDirected(applyDirectorPlan(p, plan, SKIPPED)).layouts).toEqual(base)
  })

  it('reports the hidden part inside a position as one part with both its segments', () => {
    const hidden = plan.parts.filter((x) => x.kind === 'hidden')
    expect(hidden.map((x) => x.ids)).toEqual([['a2', 'a3'], ['rec1b']])
    expect(hidden[0].start).toBeCloseTo(6.5, 6)
    expect(hidden[0].end).toBeCloseTo(16.2, 6)
  })

  it('shows the camera positions it keeps as the user\'s in the strip', () => {
    expect(plan.strip.map((s) => s.state)).toEqual(['intro', 'hidden', 'yours', 'hidden', 'outro'])
  })
})

describe('a camera position removed or changed after directing', () => {
  const rec1 = seg('rec1', 10, 24, 'default', { corner: 'top-left' })
  const p = e2eProject({ layouts: [rec1] })
  const applied = applyDirectorPlan(p, direct(p), SKIPPED)

  it('cuts the hidden parts out of it and keeps its visible piece', () => {
    expectLayouts(
      applied.layouts!.filter((s) => s.corner === 'top-left'),
      [
        seg('a5', 10, 16.2, 'screen-only', { corner: 'top-left', auto: true, cutOut: true }),
        seg('rec1', 16.2, 23, 'default', { corner: 'top-left' }),
        seg('a6', 23, 24, 'screen-only', { corner: 'top-left', auto: true, cutOut: true })
      ]
    )
  })

  it('takes the cut-outs only it held along when its piece is deleted: nothing comes back', () => {
    const deleted = { ...applied, layouts: removeLayout(applied.layouts, 'rec1') }
    // Drawn the same: the cut-outs stay, as automatic changes.
    const drawn = (list: LayoutSegment[]): unknown[] => list.map((s) => [s.start, s.end, s.layout, s.corner])
    expect(drawn(deleted.layouts)).toEqual(drawn(applied.layouts!.filter((s) => s.id !== 'rec1')))
    expect(deleted.layouts.some((s) => s.cutOut)).toBe(false)
    expect(withoutDirected(deleted.layouts)).toEqual([])
    expect(clearDirected(deleted).layouts).toEqual([])
    const again = direct(deleted, { newId: counter('b') }, { hideAfter: 0 })
    expect(again.kept).toEqual({ changes: 0, positions: 0 })
    expect(again.notes).not.toContain('kept-positions')
    expect(again.layouts.some((s) => s.corner === 'top-left')).toBe(false)
  })

  it('does the same when its corner is reset or moved by hand', () => {
    const reset = updateLayout(applied.layouts, 'rec1', { corner: undefined })
    expect(withoutDirected(reset)).toEqual([seg('rec1', 16.2, 23, 'default')])
    const moved = setCornerAt({ ...applied, layouts: applied.layouts }, 'top-right', 20)
    expect(moved.ok && withoutDirected(moved.layouts)).toEqual([seg('rec1', 16.2, 23, 'default', { corner: 'top-right' })])
    // Changing only its times keeps it a piece of the position, and the cut-outs with it.
    expect(updateLayout(applied.layouts, 'rec1', { end: 22.5 }).filter((s) => s.cutOut).length).toBe(2)
  })

  it('gives a cut-out between two pieces to the piece that is left', () => {
    const base = [seg('P', 10, 40, 'default', { corner: 'top-left' })]
    const cut = spliceDirected(base, [{ start: 20, end: 30, layout: 'screen-only' }], counter())
    expect(cut.map((s) => s.id)).toEqual(['P', 'a2', 'a1'])
    expect(withoutDirected(removeLayout(cut, 'a1'))).toEqual([seg('P', 10, 30, 'default', { corner: 'top-left' })])
    expect(withoutDirected(removeLayout(cut, 'P'))).toEqual([seg('a1', 20, 40, 'default', { corner: 'top-left' })])
  })
})

describe('slivers next to a camera position', () => {
  it('starts a cut-out at the position\'s start when the hidden part would start 0.3 s into it', () => {
    // The position starts at 22.7; the hidden part would start at 23.0.
    const p = e2eProject({ layouts: [seg('pos', 22.7, 30, 'default', { corner: 'top-left' })] })
    const plan = direct(p, {}, { corners: 'keep' })
    const cut = plan.layouts.find((s) => s.cutOut)!
    expect(cut).toMatchObject({ id: 'pos', layout: 'screen-only', corner: 'top-left', start: 22.7, end: 30 })
    expect(withoutDirected(plan.layouts)).toEqual(p.layouts)
  })

  it('moves a hidden part\'s start onto the end of a position 0.3 s away, leaving the position whole', () => {
    const p = e2eProject({ layouts: [seg('pos', 17, 23.3, 'default', { corner: 'top-left' })] })
    const plan = direct(p, {}, { corners: 'keep' })
    expect(plan.layouts.find((s) => s.id === 'pos')).toEqual(p.layouts![0])
    const after = plan.layouts.find((s) => s.start === 23.3)!
    expect(after).toMatchObject({ layout: 'screen-only', auto: true })
    expect(after.end).toBeCloseTo(33.7, 6)
    expect(plan.layouts.some((s) => s.cutOut)).toBe(false)
  })
})

describe('Direct again', () => {
  it('keeps a block trimmed by hand; the 1 s left joins the hidden part after it', () => {
    const p = e2eProject()
    const applied = applyDirectorPlan(p, direct(p), SKIPPED)
    const bubble = applied.layouts!.find((s) => s.corner === 'bottom-left')!
    const edited = { ...applied, layouts: dragLayout(applied.layouts, bubble.id, { start: 16.2, end: 22.0 }) }
    const again = direct(edited, { newId: counter('b') })
    expectLayouts(again.layouts, [
      F1[0],
      F1[1],
      seg('a3', 16.2, 22.0, 'default', { corner: 'bottom-left' }),
      seg(again.layouts[3].id, 22.0, 33.7, 'screen-only', { auto: true }),
      F1[4]
    ])
    expect(again.layouts[3].id).toMatch(/^b/)
    for (let i = 1; i < again.layouts.length; i++) expect(again.layouts[i].start).toBeGreaterThanOrEqual(again.layouts[i - 1].end)
    expect(again.diff).toEqual({ added: 1, removed: 1, unchanged: 3 })
    expect(again.kept).toEqual({ changes: 0, positions: 1 })
  })

  it('is a no-op on an unchanged project: up to date, same ids, the same project object', () => {
    const p = e2eProject()
    const applied = applyDirectorPlan(p, direct(p), SKIPPED)
    const again = direct(applied, { newId: counter('b') })
    expect(again.upToDate).toBe(true)
    expect(again.diff).toEqual({ added: 0, removed: 0, unchanged: 5 })
    expect(again.layouts).toBe(applied.layouts)
    expect(again.parts.flatMap((x) => x.ids)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5'])
    expect(applyDirectorPlan(applied, again, SKIPPED)).toBe(applied)
  })

  it('brings back an automatic change that was deleted', () => {
    const p = e2eProject()
    const applied = applyDirectorPlan(p, direct(p), SKIPPED)
    const removed = { ...applied, layouts: applied.layouts!.filter((s) => s.id !== 'a2') }
    const again = direct(removed, { newId: counter('b') })
    expect(again.diff).toEqual({ added: 1, removed: 0, unchanged: 4 })
    expect(again.layouts.map((s) => s.id)).toEqual(['a1', again.layouts[1].id, 'a3', 'a4', 'a5'])
    expect(again.layouts[1].id).toMatch(/^b/)
  })
})

describe('without sound or cursor', () => {
  it('without speech: the note no-sound, and only the bubble moved to bottom-left from about 7.5 s', () => {
    const plan = direct(e2eProject(), { speech: null })
    expect(plan.notes).toContain('no-sound')
    expect(plan.parts.map((x) => x.kind)).toEqual(['corner'])
    expect(plan.layouts.length).toBe(1)
    expect(plan.layouts[0]).toMatchObject({ layout: 'default', corner: 'bottom-left', end: 48, auto: true })
    expect(Math.abs(plan.layouts[0].start - 7.5)).toBeLessThanOrEqual(0.5)
  })

  it('under 2 s of speech in all: the note no-speech, treated as no speech', () => {
    const plan = direct(e2eProject(), { speech: { source: 'mic', refined: false, ranges: [{ start: 1, end: 2.5 }] } })
    expect(plan.notes).toContain('no-speech')
    expect(plan.parts.map((x) => x.kind)).toEqual(['corner'])
  })

  it('names a mixed track and the transcript', () => {
    expect(direct(e2eProject(), { speech: { ...SPEECH, source: 'mix' } }).notes).toEqual(['mixed-sound'])
    expect(direct(e2eProject(), { speech: { ...SPEECH, source: 'mix', refined: true } }).notes).toEqual(['transcript'])
    expect(direct(e2eProject(), { speech: { ...SPEECH, source: 'transcript' } }).notes).toEqual(['transcript'])
  })

  it('without cursor data: no-input and no-demo; no corners, no intro or outro, only hidden parts', () => {
    const plan = direct(e2eProject(), { cursor: { ...CURSOR, valid: false } })
    expect(plan.notes).toEqual(['no-input', 'no-demo'])
    expect(plan.parts.map((x) => x.kind)).toEqual(['hidden', 'hidden'])
    expect(plan.parts[0].outStart).toBeCloseTo(7.0, 6)
    expect(plan.parts[0].outEnd).toBeCloseTo(16.2, 6)
    expect(plan.parts[1].outStart).toBeCloseTo(23.0, 6)
    expect(plan.parts[1].outEnd).toBeCloseTo(33.2, 6)
  })

  it('without cursor data, a zoom still makes the demo', () => {
    const zoom: ZoomSegment = { id: 'z', start: 8, end: 26, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }
    const plan = direct(e2eProject({ zooms: [zoom] }), { cursor: { ...CURSOR, valid: false } })
    expect(plan.notes).toEqual(['no-input'])
    expect(plan.parts.map((x) => x.kind)).toEqual(['intro', 'hidden', 'hidden', 'outro'])
  })

  it('with the camera hidden: an empty plan with camera-hidden', () => {
    const p = e2eProject({ layouts: [seg('x', 1, 2, 'screen-only')] })
    p.webcam = { ...p.webcam, show: false }
    const plan = direct(p)
    expect(plan.notes).toEqual(['camera-hidden'])
    expect(plan.layouts).toBe(p.layouts)
    expect(plan.parts).toEqual([])
    expect(plan.upToDate).toBe(true)
  })

  it('says when there is nothing to change', () => {
    const plan = direct(e2eProject(), { speech: null, cursor: { ...CURSOR, samples: CURSOR.samples.map((s) => ({ ...s, x: 0.5, y: 0.5 })), clicks: [] } })
    expect(plan.notes).toEqual(['no-sound', 'no-demo', 'nothing'])
    expect(plan.layouts).toEqual([])
    expect(plan.upToDate).toBe(true)
  })

  it('does not say nothing to change when the plan removes the director\'s earlier segments (dir-plan-5)', () => {
    const p = e2eProject()
    const directed = applyDirectorPlan(p, direct(p), SKIPPED)
    const plan = direct(directed, { speech: null, cursor: { ...CURSOR, samples: CURSOR.samples.map((s) => ({ ...s, x: 0.5, y: 0.5 })), clicks: [] } })
    expect(plan.parts).toEqual([])
    expect(plan.diff).toEqual({ added: 0, removed: 5, unchanged: 0 })
    expect(plan.upToDate).toBe(false)
    expect(plan.notes).toEqual(['no-sound', 'no-demo'])
  })

  it('says the options are all off, not nothing to change, when they leave nothing to direct (dir-plan-5)', () => {
    const off = { intro: 'off', hideAfter: 0, corners: 'keep' } as const
    const p = e2eProject()
    const fresh = direct(p, {}, off)
    expect(fresh.parts).toEqual([])
    expect(fresh.upToDate).toBe(true)
    expect(fresh.notes).toEqual(['options-off'])
    const again = direct(applyDirectorPlan(p, direct(p), SKIPPED), {}, off)
    expect(again.diff).toEqual({ added: 0, removed: 5, unchanged: 0 })
    expect(again.notes).toEqual(['options-off'])
  })

  it('says when the user\'s own changes cover the video', () => {
    const plan = direct(e2eProject({ layouts: [seg('mine', 0, 47, 'side-by-side')] }))
    expect(plan.notes).toContain('all-yours')
    expect(plan.layouts[0]).toEqual(seg('mine', 0, 47, 'side-by-side'))
  })
})

describe('settings', () => {
  it('intro off: no intro or outro; hidden parts from 1 s after the words', () => {
    const plan = direct(e2eProject(), {}, { intro: 'off' })
    expect(plan.parts.some((x) => x.kind === 'intro' || x.kind === 'outro')).toBe(false)
    const hidden = plan.parts.filter((x) => x.kind === 'hidden')
    expect(hidden.map((x) => [x.outStart, x.outEnd].map((v) => +v.toFixed(6)))).toEqual([
      [7, 16.2],
      [23, 33.2]
    ])
  })

  it('camera-large: the large camera takes the corner of the neighbouring bubble', () => {
    const plan = direct(e2eProject(), {}, { intro: 'camera-large' })
    expect(plan.layouts[0]).toMatchObject({ layout: 'camera-large', corner: 'bottom-left', start: 0 })
    expect(plan.layouts[plan.layouts.length - 1]).toMatchObject({ layout: 'camera-large', corner: 'bottom-left', end: 48 })
    expect(plan.parts[0]).toMatchObject({ kind: 'intro', layout: 'camera-large', corner: 'bottom-left' })
    expect(plan.framingCap).toBe(1.3)
  })

  it('camera-large next to a bubble at home has no corner', () => {
    const plan = direct(e2eProject(), {}, { intro: 'camera-large', corners: 'keep' })
    expect(plan.layouts[0]).toEqual(seg('a1', 0, 6.5, 'camera-large', { auto: true }))
  })

  it('hideAfter 0: never hidden; the bubble goes bottom-left for the whole demo', () => {
    const plan = direct(e2eProject(), {}, { hideAfter: 0 })
    expectLayouts(plan.layouts, [F1[0], seg('a2', 6.5, 33.7, 'default', { corner: 'bottom-left', auto: true }), seg('a3', 33.7, 48, 'camera-only', { auto: true })])
  })

  it('corners keep: the bubble stays home', () => {
    const plan = direct(e2eProject(), {}, { corners: 'keep' })
    expectLayouts(plan.layouts, [F1[0], F1[1], { ...F1[3], id: 'a3' }, { ...F1[4], id: 'a4' }])
    expect(plan.parts.some((x) => x.kind === 'corner')).toBe(false)
    expect(plan.strip[2]).toMatchObject({ state: 'bubble', corner: 'bottom-right' })
  })

  it('no large layouts: a framing cap of 1.6', () => {
    expect(direct(e2eProject(), {}, { intro: 'off' }).framingCap).toBe(1.6)
  })
})

describe('cuts and speed', () => {
  // clips [{0, 10, x1}, {15, 30, x2}]: output 10 is source 15.
  const clips: Clip[] = [
    { id: 'c1', start: 0, end: 10, speed: 1 },
    { id: 'c2', start: 15, end: 30, speed: 2 }
  ]
  const p = e2eProject({ duration: 30, clips })
  const cursor: CursorTrack = { samples: [{ t: 0, x: 0.5, y: 0.5 }], clicks: [{ t: 17, x: 0.5, y: 0.5, button: 'left' }], valid: true }
  const plan = direct(p, { cursor, speech: { source: 'mic', refined: false, ranges: [{ start: 0.5, end: 9.5 }] } }, { hideAfter: 5 })

  it('lands a boundary at output 10 on source 15, the next clip\'s start; neighbours touch', () => {
    expect(plan.layouts).toEqual([seg('a1', 0, 15, 'camera-only', { auto: true }), seg('a2', 15, 30, 'screen-only', { auto: true })])
    expect(plan.parts.map((x) => [x.kind, x.outStart, x.outEnd])).toEqual([
      ['intro', 0, 10],
      ['hidden', 10, 17.5]
    ])
  })

  it('writes no segment wholly inside a cut', () => {
    for (const s of plan.layouts) expect(s.end <= 10 || s.start >= 15 || (s.start < 10 && s.end > 15) || s.end === 15).toBe(true)
    expect(plan.layouts.every((s) => sourceToOutput(clips, s.start) !== null)).toBe(true)
  })
})

describe('applying and removing', () => {
  const framed: FramingOutcome = { status: 'framed', zoom: 1.25, cropX: 0.62, cropY: 0.4, found: 12, sampled: 12, steady: true }

  it('writes the framing and director.framed for a found framing while the option is on', () => {
    const p = e2eProject()
    const plan = direct(p)
    const out = applyDirectorPlan(p, plan, framed)
    expect(out.webcam).toMatchObject({ zoom: 1.25, cropX: 0.62, cropY: 0.4 })
    expect(out.director).toEqual({ intro: 'camera-only', corners: 'auto', hideAfter: 10, frameFace: true, framed: { zoom: 1.25, cropX: 0.62, cropY: 0.4 } })
    expect(out.layouts).toBe(plan.layouts)
  })

  it('writes no framing with the option off or for the other outcomes', () => {
    const p = e2eProject()
    const plan = direct(p)
    for (const outcome of [framed, { status: 'not-found', found: 1, sampled: 12 }, { status: 'unavailable', reason: 'no WebGL' }, SKIPPED] as FramingOutcome[]) {
      const off = outcome === framed ? { ...plan, settings: { ...plan.settings, frameFace: false } } : plan
      const out = applyDirectorPlan(p, off, outcome)
      expect(out.webcam).toBe(p.webcam)
      expect(out.director?.framed).toBeUndefined()
    }
  })

  it('keeps a framing within 0.05 zoom and 0.01 crop of the found one', () => {
    const p = e2eProject()
    p.webcam = { ...p.webcam, zoom: 1.22, cropX: 0.615, cropY: 0.405 }
    const out = applyDirectorPlan(p, direct(p, {}, { frameFace: true }), framed)
    expect(out.webcam).toBe(p.webcam)
    expect(out.director?.framed).toBeUndefined()
  })

  it('keeps director.framed while the webcam still shows it, and drops it once the user changed it', () => {
    const p = e2eProject()
    const once = applyDirectorPlan(p, direct(p), framed)
    const twice = applyDirectorPlan(once, direct(once), SKIPPED)
    expect(twice).toBe(once)
    const nudged = { ...once, webcam: { ...once.webcam, zoom: 1.4 } }
    const again = applyDirectorPlan(nudged, direct(nudged), SKIPPED)
    expect(again.director?.framed).toBeUndefined()
    expect(again.webcam).toBe(nudged.webcam)
  })

  it('returns the same project when nothing changes', () => {
    const p = e2eProject()
    const applied = applyDirectorPlan(p, direct(p), SKIPPED)
    expect(applyDirectorPlan(applied, direct(applied), SKIPPED)).toBe(applied)
    const quiet = e2eProject({ director: { intro: 'camera-only', corners: 'auto', hideAfter: 10, frameFace: true } })
    const nothing = direct(quiet, { speech: null, cursor: { ...CURSOR, valid: false } })
    expect(applyDirectorPlan(quiet, nothing, SKIPPED)).toBe(quiet)
  })

  it('clearDirected removes the segments, resets the director\'s framing and drops framed; options stay', () => {
    const p = e2eProject()
    const applied = applyDirectorPlan(p, direct(p), framed)
    const cleared = clearDirected(applied)
    expect(cleared.layouts).toEqual([])
    expect(cleared.webcam).toEqual({ show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' })
    expect(cleared.director).toEqual({ intro: 'camera-only', corners: 'auto', hideAfter: 10, frameFace: true })
    expect(clearDirected(cleared)).toBe(cleared)
  })

  it('clearDirected keeps a framing the user changed afterwards', () => {
    const p = e2eProject()
    const applied = applyDirectorPlan(p, direct(p), framed)
    const mine = { ...applied, webcam: { ...applied.webcam, cropX: 0.5 } }
    const cleared = clearDirected(mine)
    expect(cleared.webcam).toBe(mine.webcam)
    expect(cleared.director?.framed).toBeUndefined()
  })
})

describe('spliceDirected and withoutDirected', () => {
  it('joins pieces of a position too short for their own change to the cut-out', () => {
    const base = [seg('P', 10, 30, 'default', { corner: 'top-right' })]
    // 0.3 s before (< 0.4) joins the first cut-out; 0.5 s between (< 0.8) joins the one before it; 0.5 s after joins the last.
    const out = spliceDirected(base, [{ start: 10.3, end: 20, layout: 'screen-only' }, { start: 20.5, end: 29.5, layout: 'camera-only' }], counter())
    expect(out).toEqual([
      seg('P', 10, 20.5, 'screen-only', { corner: 'top-right', auto: true, cutOut: true }),
      seg('a1', 20.5, 30, 'camera-only', { corner: 'top-right', auto: true, cutOut: true })
    ])
    expect(withoutDirected(out)).toEqual(base)
  })

  it('keeps the position\'s id on its first remaining piece and joins touching runs alike', () => {
    const base = [seg('P', 10, 30, 'default', { corner: 'top-right' }), seg('L', 40, 45, 'camera-only')]
    const out = spliceDirected(
      base,
      [
        { start: 5, end: 15, layout: 'screen-only' },
        { start: 32, end: 36, layout: 'default', corner: 'bottom-left' },
        { start: 36, end: 40, layout: 'default', corner: 'bottom-left' }
      ],
      counter()
    )
    expect(out).toEqual([
      seg('a1', 5, 10, 'screen-only', { auto: true }),
      seg('a3', 10, 15, 'screen-only', { corner: 'top-right', auto: true, cutOut: true }),
      seg('P', 15, 30, 'default', { corner: 'top-right' }),
      seg('a2', 32, 40, 'default', { corner: 'bottom-left', auto: true }),
      base[1]
    ])
    expect(withoutDirected(out)).toEqual(base)
  })

  it('withoutDirected leaves the user\'s segments alone, touching positions included', () => {
    const list = [seg('A', 0, 5, 'default', { corner: 'top-left' }), seg('B', 5, 9, 'default', { corner: 'top-left' }), seg('C', 9, 12, 'screen-only')]
    expect(withoutDirected(list)).toEqual(list)
    expect(withoutDirected(undefined)).toEqual([])
  })
})

/* ---------- property test ---------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const LAYOUTS: CameraLayout[] = ['default', 'default', 'camera-only', 'screen-only', 'side-by-side', 'camera-large']

function randomCase(seed: number): { project: Project; cursor: CursorTrack; speech: DirectorSpeech | null; settings: DirectorSettings } {
  const rnd = mulberry32(seed)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]
  const duration = Math.round((20 + rnd() * 280) * 100) / 100
  const [width, height] = pick([
    [1920, 1080],
    [1280, 720],
    [2560, 1440],
    [1080, 1920]
  ])
  const p = createProject({
    id: `p${seed}`,
    name: 'p',
    duration,
    width,
    height,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: pick(['native', 'chromium'] as const), cursorInVideo: rnd() < 0.3, region: null }
  })
  // Kept clips: cuts and speeds 0.25-8x.
  const clips: Clip[] = []
  let t = rnd() < 0.3 ? rnd() * 5 : 0
  const count = 1 + Math.floor(rnd() * 4)
  for (let i = 0; i < count && t < duration - 1; i++) {
    const end = Math.min(duration, t + (duration / count) * (0.4 + rnd() * 0.6))
    clips.push({ id: `c${i}`, start: t, end, speed: pick([0.25, 0.5, 1, 1, 1, 1.5, 2, 4, 8]) })
    t = end + (rnd() < 0.5 ? rnd() * 6 : 0)
  }
  p.clips = normalizeClips(clips, duration)
  // Speech.
  let speech: DirectorSpeech | null = null
  if (rnd() > 0.15) {
    const ranges: Range[] = []
    for (let s = rnd() * 3; s < duration; ) {
      const e = Math.min(duration, s + 0.6 + rnd() * 12)
      ranges.push({ start: s, end: e })
      s = e + (rnd() < 0.6 ? 0.2 + rnd() * 3 : rnd() * 35)
    }
    speech = { source: pick(['mic', 'mix', 'transcript'] as const), refined: rnd() < 0.3, ranges }
  }
  // A cursor walk with jumps, clicks, typing and keys.
  const samples: CursorSample[] = []
  let x = rnd()
  let y = rnd()
  for (let i = 0; i <= duration * 10; i++) {
    if (rnd() < 0.02) {
      x = rnd() * 1.2 - 0.1
      y = rnd() * 1.2 - 0.1
    } else if (rnd() < 0.5) {
      x = Math.min(1.1, Math.max(-0.1, x + (rnd() - 0.5) * 0.05))
      y = Math.min(1.1, Math.max(-0.1, y + (rnd() - 0.5) * 0.05))
    }
    samples.push({ t: i / 10, x, y })
  }
  const clicks = Array.from({ length: Math.floor(rnd() * (duration / 6)) }, () => ({
    t: rnd() * duration,
    x: rnd() * 1.1 - 0.05,
    y: rnd() * 1.1 - 0.05,
    button: pick(['left', 'left', 'right'] as const)
  })).sort((a, b) => a.t - b.t)
  const typing = Array.from({ length: Math.floor(rnd() * 3) }, () => {
    const s = rnd() * duration
    return { t: s, end: Math.min(duration, s + rnd() * 6) }
  }).sort((a, b) => a.t - b.t)
  const cursor: CursorTrack = { samples, clicks, typing, keys: rnd() < 0.3 ? [{ t: rnd() * duration, label: 'Ctrl+S' }] : [], valid: rnd() < 0.85 }
  // Zooms.
  p.zooms = Array.from({ length: Math.floor(rnd() * 4) }, (_, i): ZoomSegment => {
    const s = rnd() * (duration - 3)
    const z: ZoomSegment = {
      id: `z${i}`,
      start: s,
      end: Math.min(duration, s + 1 + rnd() * 8),
      scale: 1.5 + rnd(),
      focus: rnd() < 0.5 ? { mode: 'cursor' } : { mode: 'fixed', x: rnd(), y: rnd() },
      auto: rnd() < 0.5
    }
    if (z.auto && rnd() < 0.5) z.anchor = { t: s + 0.5, x: rnd(), y: rnd() }
    return z
  }).sort((a, b) => a.start - b.start)
  // The user's segments: camera positions and layout changes, as loading leaves them.
  const raw = Array.from({ length: Math.floor(rnd() * 7) }, (_, i) => {
    const s = rnd() * duration
    const layout = pick(LAYOUTS)
    return { id: `u${i}`, start: s, end: s + 0.3 + rnd() * 30, layout, ...(layout === 'default' || rnd() < 0.5 ? { corner: pick(CORNERS) } : {}) }
  })
  const layouts: LayoutSegment[] = []
  for (const s of readLayouts(raw, duration)) {
    const prev = layouts[layouts.length - 1]
    // Recordings never make two touching positions in the same corner.
    if (prev && cornerOnly(prev) && cornerOnly(s) && prev.corner === s.corner && Math.abs(prev.end - s.start) <= 1e-6) continue
    layouts.push(s)
  }
  p.layouts = layouts
  p.webcam = { show: true, corner: pick(CORNERS), size: 0.15 + rnd() * 0.2, shape: 'circle' }
  p.style = { ...p.style, padding: pick([0, 0.05, 0.1]), aspectRatio: pick(['auto', '16:9', '9:16', '1:1', '4:3'] as const) }
  p.cursor = { ...p.cursor, show: rnd() < 0.8, hideWhenIdle: rnd() < 0.5, smoothing: rnd() }
  if (rnd() < 0.2) p.watermark = { show: true, kind: 'text', text: 'Flown', position: pick([...CORNERS, 'center'] as const), size: 0.035, opacity: 0.8, margin: 0.035 }
  const settings: DirectorSettings = {
    intro: pick(['camera-only', 'camera-large', 'off'] as const),
    corners: pick(['auto', 'keep'] as const),
    hideAfter: pick([0, 5, 10, 20] as const),
    frameFace: rnd() < 0.5
  }
  return { project: p, cursor, speech, settings }
}

describe('property: 200 random projects', () => {
  it('plans without throwing; never touches the user\'s segments; exact inverse; minimum lengths; directing twice is a no-op', () => {
    let directedSegments = 0
    for (let seed = 1; seed <= 200; seed++) {
      const { project, cursor, speech, settings } = randomCase(seed)
      const ctx = `seed ${seed}`
      const base = withoutDirected(project.layouts)
      const plan = planDirector({ project, cursor, speech, newId: counter() }, settings)
      const out = plan.layouts
      directedSegments += out.filter((s) => s.auto).length

      // Sorted, not overlapping, inside the recording, unique ids; loading keeps it as it is.
      for (let i = 0; i < out.length; i++) {
        expect(out[i].start, ctx).toBeGreaterThanOrEqual(0)
        expect(out[i].end, ctx).toBeLessThanOrEqual(project.duration)
        if (i > 0) expect(out[i].start, ctx).toBeGreaterThanOrEqual(out[i - 1].end - 1e-9)
      }
      expect(new Set(out.map((s) => s.id)).size, ctx).toBe(out.length)
      expect(readLayouts(out, project.duration), ctx).toEqual(out)

      // Every layout change of the user's intact; the user's segments come back exactly.
      for (const s of base.filter((x) => !cornerOnly(x))) expect(out, ctx).toContainEqual(s)
      expect(withoutDirected(out), ctx).toEqual(base)

      // Director segments: at least 0.05 s, changes animate over at most 0.4 s.
      const directed = { ...project, layouts: out }
      for (const s of out.filter((x) => x.auto)) {
        expect(s.end - s.start, ctx).toBeGreaterThanOrEqual(0.05 - 1e-9)
        const r = layoutRamps(directed, s)
        expect(Math.max(r.in, r.out), ctx).toBeLessThanOrEqual(0.4)
      }

      // Minimum lengths (output seconds; a snap to a position's edge takes at most 0.4 s off each end).
      for (const part of plan.parts) {
        const len = part.outEnd - part.outStart
        if (part.kind === 'intro') expect(len, ctx).toBeGreaterThanOrEqual(INTRO.min - 0.4 - 1e-6)
        if (part.kind === 'outro') expect(len, ctx).toBeGreaterThanOrEqual(OUTRO.min - 0.4 - 1e-6)
        if (part.kind === 'hidden') expect(len, ctx).toBeGreaterThanOrEqual(5.0 - 0.8 - 1e-6)
      }
      // Changes the director adds (between two of its own states) are at least 2.2 s of output apart.
      const strip = plan.strip
      for (let i = 1; i < strip.length - 1; i++) {
        if (strip[i].state === 'yours' || strip[i - 1].state === 'yours' || strip[i + 1].state === 'yours') continue
        expect(strip[i].end - strip[i].start, `${ctx} strip ${i}`).toBeGreaterThanOrEqual(2.2 - 1e-6)
      }
      // The strip covers the output timeline.
      if (strip.length) {
        expect(strip[0].start).toBe(0)
        expect(strip[strip.length - 1].end).toBeCloseTo(outputDuration(project.clips), 6)
      }

      // Directing twice is a no-op: up to date, the same project object.
      const applied = applyDirectorPlan(project, plan, SKIPPED)
      const again = planDirector({ project: applied, cursor, speech, newId: counter('b') }, settings)
      expect(again.upToDate, ctx).toBe(true)
      expect(again.diff.added + again.diff.removed, ctx).toBe(0)
      expect(applyDirectorPlan(applied, again, SKIPPED), ctx).toBe(applied)
    }
    // The cases do exercise the director.
    expect(directedSegments).toBeGreaterThan(200)
  })
})

describe('performance', () => {
  it('plans a 30-minute recording well under a second', () => {
    const duration = 1800
    const rnd = mulberry32(7)
    const samples: CursorSample[] = []
    let x = 0.5
    let y = 0.5
    for (let i = 0; i <= duration * 60; i++) {
      if (rnd() < 0.01) {
        x = rnd()
        y = rnd()
      }
      samples.push({ t: i / 60, x, y })
    }
    const clicks = Array.from({ length: 360 }, (_, i) => ({ t: i * 5 + rnd() * 4, x: rnd(), y: rnd(), button: 'left' as const }))
    const ranges: Range[] = []
    for (let s = 1; s < duration; s += 8 + rnd() * 40) ranges.push({ start: s, end: Math.min(duration, s + 2 + rnd() * 6) })
    const p = e2eProject({ duration, clips: [{ id: 'c', start: 0, end: duration, speed: 1 }], layouts: [seg('pos', 600, 700, 'default', { corner: 'top-left' })] })
    const cursor: CursorTrack = { samples, clicks, valid: true }
    const speech: DirectorSpeech = { source: 'mic', refined: false, ranges }
    const settings = { ...directorSettingsOf(p), corners: 'auto' as const }
    const t0 = performance.now()
    const first = planDirector({ project: p, cursor, speech }, settings)
    const t1 = performance.now()
    const second = planDirector({ project: p, cursor, speech }, settings)
    const t2 = performance.now()
    expect(first.parts.length).toBeGreaterThan(10)
    expect(second.layouts.map((s) => [s.start, s.end, s.layout, s.corner])).toEqual(first.layouts.map((s) => [s.start, s.end, s.layout, s.corner]))
    expect(t1 - t0).toBeLessThan(1000)
    // The corner costs are cached: re-planning is cheaper.
    expect(t2 - t1).toBeLessThan(t1 - t0)
    console.info(`30-minute plan: first ${(t1 - t0).toFixed(0)} ms (paths and costs built), again ${(t2 - t1).toFixed(0)} ms`)
  })
})
