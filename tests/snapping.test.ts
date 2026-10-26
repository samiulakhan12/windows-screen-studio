import { describe, expect, it } from 'vitest'
import { dragAnnotationTimes } from '../src/shared/editor/annotations'
import { createShape, createSpotlight } from '../src/shared/editor/shapes'
import {
  buildSnapIndex,
  dragPoints,
  projectFreezeTargets,
  projectSnapSegments,
  projectSnapSources,
  snapAt,
  snapLabel,
  snapPoints,
  snapSpan,
  type SnapIndex,
  type SnapSources,
  type SnapTarget,
  type SnapView
} from '../src/shared/editor/snapping'
import { freezePlan, freezeSnapTargets, planOf } from '../src/shared/engine/freeze'
import type { ClickRow } from '../src/shared/engine/inputData'
import { createProject } from '../src/shared/engine/project'
import { dragZoomTimes } from '../src/shared/engine/zoom'
import type { Chapter, Clip, Freeze } from '../src/shared/types'

const clip = (id: string, start: number, end: number, speed = 1): Clip => ({ id, start, end, speed })

/** Sources with nothing but `clips` over `duration`, plus `more`. */
const sources = (clips: Clip[], duration: number, more: Partial<SnapSources> = {}): SnapSources => ({
  duration,
  clips,
  clicks: [],
  chapters: [],
  segments: [],
  freezes: [],
  playhead: null,
  ...more
})

/** The common fixture: a cut 4–6, a split at 10 (a 2× clip after it), trimmed at 12 of 15 s. */
const F = (more: Partial<SnapSources> = {}): SnapSources => sources([clip('c0', 0, 4), clip('c1', 6, 10), clip('c2', 10, 12, 2)], 15, more)

const view = (current: SnapTarget | null = null, more: Partial<SnapView> = {}): SnapView => ({ pxPerSec: 100, current, ...more })
const at = (idx: SnapIndex, t: number): SnapTarget => idx.targets[[...idx.times].indexOf(t)]
const chapter = (id: string, t: number, title = ''): Chapter => ({ id, t, title })

describe('buildSnapIndex', () => {
  it('labels the clip edges: trims, cuts and splits, between the recording ends', () => {
    const idx = buildSnapIndex(F())
    expect([...idx.times]).toEqual([0, 4, 6, 10, 12, 15])
    expect(idx.targets.map((x) => x.label)).toEqual(['Start', 'Cut', 'Cut', 'Split', 'Trim', 'End'])
    // The kept start at 0 is not strictly inside the recording: it is the recording's start.
    expect(idx.targets[0].kind).toBe('bound')
    expect(at(idx, 12)).toMatchObject({ kind: 'clip', owner: 'trim:end' })
    expect(at(idx, 4)).toMatchObject({ kind: 'clip', owner: 'clips' })
  })

  it('names a trimmed start Trim, owned by trim:start (the trim handle leaves it out)', () => {
    const clips = [clip('c0', 1, 4), clip('c1', 6, 12)]
    const idx = buildSnapIndex(sources(clips, 15))
    expect(at(idx, 1)).toMatchObject({ kind: 'clip', label: 'Trim', owner: 'trim:start' })
    const without = buildSnapIndex(sources(clips, 15), [{ owner: 'trim:start' }])
    expect([...without.times]).toEqual([0, 4, 6, 12, 15])
    expect(without.targets[0].label).toBe('Start')
  })

  it('merges targets closer than SNAP.mergeS, keeping the higher priority one with its own time', () => {
    const idx = buildSnapIndex(F({ segments: [{ owner: 'zoom:z1', label: 'Zoom', start: 4 + 3e-7, end: 5 }] }))
    expect(idx.times.filter((t) => Math.abs(t - 4) < 1e-3)).toEqual(new Float64Array([4]))
    expect(at(idx, 4)).toMatchObject({ t: 4, kind: 'clip', label: 'Cut' })
    expect(at(idx, 5)).toMatchObject({ kind: 'segment', label: 'Zoom end', owner: 'zoom:z1', edge: 'end' })
    // Merged even when the lower priority target comes first in time.
    const before = buildSnapIndex(F({ segments: [{ owner: 'zoom:z1', label: 'Zoom', start: 4 - 3e-7, end: 5 }] }))
    expect(before.targets.filter((x) => Math.abs(x.t - 4) < 1e-3)).toEqual([{ t: 4, kind: 'clip', label: 'Cut', owner: 'clips' }])
  })

  it('leaves out an excluded owner, all of it or one edge', () => {
    const zoom = buildSnapIndex(sources([clip('c0', 0, 12)], 12, { segments: [{ owner: 'zoom:z1', label: 'Zoom', start: 2, end: 3 }] }), [{ owner: 'zoom:z1' }])
    expect([...zoom.times]).toEqual([0, 12])
    const layout = buildSnapIndex(sources([clip('c0', 0, 12)], 12, { segments: [{ owner: 'layout:L0', label: 'Camera layout', start: 2, end: 3 }] }), [
      { owner: 'layout:L0', edge: 'end' }
    ])
    expect([...layout.times]).toEqual([0, 2, 12])
    expect(at(layout, 2).label).toBe('Camera layout start')
  })

  it('drops non-finite times and times outside the recording', () => {
    const idx = buildSnapIndex(F({ clicks: [NaN, -1, 16, 3], freezes: [Infinity, 9], chapters: [chapter('h1', 14, 'Outro')] }))
    expect([...idx.times]).toEqual([0, 3, 4, 6, 9, 10, 12, 14, 15])
    expect(at(idx, 9)).toMatchObject({ kind: 'freeze', label: 'Freeze frame' })
    expect(at(idx, 14)).toMatchObject({ kind: 'chapter', label: 'Chapter · Outro', owner: 'chapter:h1', edge: 'at' })
    expect(at(idx, 3)).toMatchObject({ kind: 'click', label: 'Click' })
  })

  it('adds the playhead only when given', () => {
    expect(at(buildSnapIndex(F({ playhead: 7.5 })), 7.5)).toMatchObject({ kind: 'playhead', label: 'Playhead' })
    expect([...buildSnapIndex(F({ playhead: null })).times]).not.toContain(7.5)
  })
})

describe('projectSnapSources and projectSnapSegments', () => {
  const base = createProject({
    id: 'p',
    name: 'p',
    duration: 20,
    width: 1920,
    height: 1080,
    hasWebcam: true,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [{ id: 'z1', start: 1, end: 2, scale: 2, focus: { mode: 'cursor' }, auto: false }],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  const project = {
    ...base,
    annotations: [{ id: 'a1', start: 3, end: 4, text: 'x', x: 0.5, y: 0.5, size: 0.05, style: 'pill' as const }],
    shapes: [{ ...createShape('arrow', 5, 20), id: 's1', start: 5, end: 6 }],
    spotlights: [
      { ...createSpotlight('cursor', 7, 20), id: 'p1', start: 7, end: 8 },
      { ...createSpotlight('region', 7, 20), id: 'p2', start: 7.5, end: 8.5 }
    ],
    titles: [{ id: 't1', start: 9, end: 10, title: 'Hi', style: 'centered' as const }],
    transcript: { segments: [{ id: 'k1', start: 11, end: 12, text: 'hello' }] },
    layouts: [{ id: 'L0', start: 13, end: 14, layout: 'side-by-side' as const }],
    chapters: [chapter('h1', 15, 'Intro')]
  } as typeof base
  const row = (t: number, ignored: boolean): ClickRow => ({ click: { t, x: 0.5, y: 0.5, button: 'left' }, ms: Math.round(t * 1000), ignored: ignored ? { ms: Math.round(t * 1000) } : null })

  it('lists every track block with its owner and label; camera layouts only when their track shows', () => {
    expect(projectSnapSegments(project, { layouts: true })).toEqual([
      { owner: 'zoom:z1', label: 'Zoom', start: 1, end: 2 },
      { owner: 'annotation:a1', label: 'Text', start: 3, end: 4 },
      { owner: 'shape:s1', label: 'Arrow', start: 5, end: 6 },
      { owner: 'spotlight:p1', label: 'Cursor spotlight', start: 7, end: 8 },
      { owner: 'spotlight:p2', label: 'Spotlight', start: 7.5, end: 8.5 },
      { owner: 'title:t1', label: 'Title card', start: 9, end: 10 },
      { owner: 'caption:k1', label: 'Caption', start: 11, end: 12 },
      { owner: 'layout:L0', label: 'Camera layout', start: 13, end: 14 }
    ])
    expect(projectSnapSegments(project, { layouts: false }).map((s) => s.owner)).not.toContain('layout:L0')
  })

  it('keeps only used clicks, and reads chapters, clips and the playhead', () => {
    const src = projectSnapSources(project, [row(2.5, true), row(3, false)], { playhead: 4.2, layouts: false })
    expect(src.clicks).toEqual([3])
    expect(src.chapters).toBe(project.chapters)
    expect(src.clips).toBe(project.clips)
    expect(src.duration).toBe(20)
    expect(src.playhead).toBe(4.2)
  })

  it('takes freeze frames from the options, else from the project (none here)', () => {
    expect(projectSnapSources(project, [], { playhead: null, layouts: false, freezes: [6.5] }).freezes).toEqual([6.5])
    expect(projectSnapSources(project, [], { playhead: null, layouts: false }).freezes).toEqual([])
  })

  it('leaves a dragged freeze out of the freeze targets (its plan is the other freezes)', () => {
    const freeze = (id: string, at: number): Freeze => ({ id, at, length: 3, sound: 'pause' })
    const p = { clips: [clip('c0', 0, 20)], freezes: [freeze('f1', 3), freeze('f2', 7)] }
    expect(projectFreezeTargets(p)).toEqual(freezeSnapTargets(p.clips, planOf(p)))
    const others = projectFreezeTargets(p, [{ owner: 'freeze:f1' }, { owner: 'zoom:f2' }])
    expect(others).toEqual(freezeSnapTargets(p.clips, freezePlan(p.clips, [freeze('f2', 7)])))
    expect(others).not.toContain(3)
  })
})

describe('snapPoints', () => {
  const idx = buildSnapIndex(F())
  const cut4 = at(idx, 4)

  it('catches a target within 8 px and ignores one further away', () => {
    const r = snapPoints(idx, [4.05], view())
    expect(r.target).toBe(cut4)
    expect(r.delta).toBeCloseTo(-0.05, 12)
    expect(r.point).toBe(0)
    expect(snapPoints(idx, [4.09], view())).toEqual({ delta: 0, target: null, point: -1 })
  })

  it('holds the current target out to 12 px', () => {
    expect(snapPoints(idx, [4.11], view(cut4)).target).toBe(cut4)
    expect(snapPoints(idx, [4.13], view(cut4)).target).toBeNull()
  })

  it('picks the nearest target in pixels', () => {
    const near = buildSnapIndex(F({ clicks: [4.03] }))
    expect(snapPoints(near, [4.025], view()).target).toMatchObject({ kind: 'click', t: 4.03 })
  })

  it('breaks ties within 0.5 px by kind priority', () => {
    const two = buildSnapIndex(F({ clicks: [4.1] }))
    expect(snapPoints(two, [4.05], view()).target).toMatchObject({ kind: 'clip', t: 4 })
    expect(snapPoints(two, [4.052], view()).target).toMatchObject({ kind: 'clip', t: 4 })
    expect(snapPoints(two, [4.06], view()).target).toMatchObject({ kind: 'click', t: 4.1 })
  })

  it('lets the current target win a tie', () => {
    const two = buildSnapIndex(F({ clicks: [4.1] }))
    const click = at(two, 4.1)
    expect(snapPoints(two, [4.05], view(click)).target).toBe(click)
    // An equal target from another index counts as the current one.
    expect(snapPoints(two, [4.05], view({ ...click })).target).toEqual(click)
  })

  it('moves with whichever edge is nearer a target', () => {
    expect(dragPoints({ start: 2, end: 3.5 }, 'move', 1.96)).toEqual([3.96, 5.46])
    const withChapter = buildSnapIndex(F({ chapters: [chapter('h1', 5.48)] }))
    const r = snapPoints(withChapter, dragPoints({ start: 2, end: 3.5 }, 'move', 1.96), view())
    expect(r.target).toMatchObject({ kind: 'chapter', t: 5.48 })
    expect(r.delta).toBeCloseTo(0.02, 12)
    expect(r.point).toBe(1)
  })

  it('gives the dragged edges of each mode', () => {
    expect(dragPoints({ start: 1, end: 2 }, 'start', 0.5)).toEqual([1.5])
    expect(dragPoints({ start: 1, end: 2 }, 'end', 0.5)).toEqual([2.5])
    expect(dragPoints({ start: 1, end: 2 }, 'move', 0.5)).toEqual([1.5, 2.5])
  })

  it('catches nothing with an edge outside the visible window', () => {
    expect(snapPoints(idx, [12.05], view(null, { visible: { start: 0, end: 12 } })).target).toBeNull()
    expect(snapPoints(idx, [12.05], view(null, { visible: null })).target).toMatchObject({ label: 'Trim', t: 12 })
  })

  it('converts the thresholds with the scale (fit view of a long recording)', () => {
    const fit = buildSnapIndex(sources([clip('c0', 0, 30)], 30, { chapters: [chapter('h1', 10)] }))
    expect(snapPoints(fit, [13], { pxPerSec: 2, current: null }).target).toMatchObject({ kind: 'chapter', t: 10 })
    expect(snapPoints(fit, [14.5], { pxPerSec: 2, current: null }).target).toBeNull()
  })

  it('returns nothing without targets', () => {
    expect(snapPoints({ times: new Float64Array(0), targets: [] }, [5], view())).toEqual({ delta: 0, target: null, point: -1 })
  })

  it('ignores targets outside the limit, the current one included', () => {
    expect(snapPoints(idx, [11.95], view(), { min: 0, max: 11.9 }).target).toBeNull()
    expect(snapPoints(idx, [11.95], view(at(idx, 12)), { min: 0, max: 11.9 }).target).toBeNull()
  })

  it('follows the worked example (a zoom moved by its middle onto a cut)', () => {
    const zidx = buildSnapIndex(sources([clip('c0', 0, 4), clip('c1', 6, 12)], 12))
    const initial = { start: 1, end: 2 }
    const resolve = (d: number): { start: number; end: number } => dragZoomTimes(initial, 'move', d, { lower: 0, upper: 12 })
    let current: SnapTarget | null = null
    const step = (px: number): { start: number; end: number } => {
      const r = snapSpan(zidx, initial, 'move', px / 100, view(current), resolve)
      current = r.target
      return r.times
    }
    expect(step(204)).toEqual({ start: 3, end: 4 })
    expect(step(211)).toEqual({ start: 3, end: 4 })
    expect(current).toMatchObject({ label: 'Cut', t: 4 })
    const free = step(213)
    expect(current).toBeNull()
    expect(free.start).toBeCloseTo(3.13, 12)
    expect(step(207)).toEqual({ start: 3, end: 4 })
  })
})

describe('snapSpan and snapAt', () => {
  const idx = buildSnapIndex(sources([clip('c0', 0, 4), clip('c1', 6, 12)], 12))

  it('writes a moved span exactly on its target, keeping its length', () => {
    const initial = { start: 1, end: 2 }
    const r = snapSpan(idx, initial, 'move', 2.04, view(), (d) => dragZoomTimes(initial, 'move', d, { lower: 0, upper: 12 }))
    expect(r.times.start).toBe(3)
    expect(r.times.end).toBe(4)
    expect(r.target).toMatchObject({ label: 'Cut', t: 4 })
  })

  it('writes a trimmed start exactly on its target', () => {
    const initial = { start: 4.5, end: 8 }
    const r = snapSpan(idx, initial, 'start', 1.44, view(), (d) => dragAnnotationTimes(initial, 'start', d, 12))
    expect(r.times).toEqual({ start: 6, end: 8 })
    expect(r.times.start).toBe(6)
    expect(r.target).toMatchObject({ label: 'Cut', t: 6 })
  })

  it('falls back to the unsnapped drag when the clamp moves the edge off its target', () => {
    const initial = { start: 1, end: 2 }
    const r = snapSpan(idx, initial, 'move', 2.04, view(), (d) => dragZoomTimes(initial, 'move', d, { lower: 0, upper: 3.95 }))
    expect(r.times.start).toBeCloseTo(2.95, 12)
    expect(r.times.end).toBeCloseTo(3.95, 12)
    expect(r.target).toBeNull()
  })

  it('passes the drag through when nothing catches', () => {
    const initial = { start: 1, end: 2 }
    const r = snapSpan(idx, initial, 'end', 0.5, view(), (d) => dragZoomTimes(initial, 'end', d, { lower: 0, upper: 12 }))
    expect(r).toEqual({ times: { start: 1, end: 2.5 }, target: null })
  })

  it('snaps a point only to targets inside its limit', () => {
    const fidx = buildSnapIndex(F())
    expect(snapAt(fidx, 11.95, view(), { min: 0, max: 11.9 })).toEqual({ t: 11.95, target: null })
    expect(snapAt(fidx, 11.95, view())).toMatchObject({ t: 12, target: { label: 'Trim' } })
  })

  it('stays fast with many targets', () => {
    const clicks = Array.from({ length: 20000 }, (_, i) => (i * 600) / 20000 + 0.013)
    const begin = Date.now()
    const big = buildSnapIndex(sources([clip('c0', 0, 600)], 600, { clicks }))
    for (let i = 0; i < 1000; i++) snapPoints(big, [i * 0.6 + 0.01, i * 0.6 + 0.5], view())
    expect(big.times.length).toBe(20002)
    expect(Date.now() - begin).toBeLessThan(250)
  })
})

describe('snapLabel', () => {
  it('names the target and its time, tenths floored', () => {
    expect(snapLabel({ t: 4, kind: 'clip', label: 'Cut' })).toBe('Cut · 0:04.0')
    expect(snapLabel({ t: 12, kind: 'chapter', label: 'Chapter · Intro' })).toBe('Chapter · Intro · 0:12.0')
    const idx = buildSnapIndex(F({ chapters: [chapter('h1', 12.09)] }))
    expect(snapLabel(at(idx, 12.09))).toBe('Chapter · 0:12.0')
  })
})
