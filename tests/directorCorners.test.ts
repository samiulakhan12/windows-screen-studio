import { describe, expect, it } from 'vitest'
import { planDirector } from '../src/shared/editor/cameraDirector'
import { cornerCosts, cornerOrder, planCorners, type CornerProject, type CornerRun, type CornerStretch } from '../src/shared/editor/directorCorners'
import { DEFAULT_DIRECTOR } from '../src/shared/engine/directorData'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import { focusPathFor } from '../src/shared/engine/zoom'
import type { ClickEvent, Corner, CursorSample, CursorTrack, Project, ZoomSegment } from '../src/shared/types'

/*
 * Where the director puts the bubble (docs/design/camera-director.md, step 10, test plan F3):
 * costs measured where the compositor draws things, a minimum stay, the busy cap, ties.
 * Common: 1920x1080 output, padding 0, a 1920x1080 source, webcam 0.24 bottom-right (the BR
 * bubble spans x 0.8425-0.9775, y 0.72-0.96), the smooth cursor drawn, no zooms.
 */

const BR_CENTRE = { x: 0.91, y: 0.84 }

function project(duration: number, over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration,
    width: 1920,
    height: 1080,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  p.style = { ...p.style, padding: 0, aspectRatio: 'auto' }
  p.webcam = { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }
  p.cursor = { ...p.cursor, show: true, hideWhenIdle: false, smoothing: 0 }
  return { ...p, ...over }
}

/** Cursor samples every 0.05 s from `at(t)`. */
function samplesOf(duration: number, at: (t: number) => { x: number; y: number }): CursorSample[] {
  const out: CursorSample[] = []
  for (let i = 0; i <= Math.round(duration * 20); i++) {
    const t = i / 20
    out.push({ t, ...at(t) })
  }
  return out
}

function costsOf(p: Project, track: CursorTrack) {
  const cursorPath = new SmoothedTrack(track.samples, p.duration, p.cursor.smoothing)
  return cornerCosts(p as CornerProject, track, cursorPath, focusPathFor(track.samples, p.duration))
}

const whole = (end: number, over: Partial<CornerStretch> = {}): CornerStretch => ({ start: 0, end, entry: null, enterVisible: false, exit: null, ...over })
/** A stretch from the start of the video, as planDirector builds it: the bubble is shown at home from the first frame. */
const fromStart = (end: number): CornerStretch => whole(end, { entry: 'bottom-right', enterVisible: true })

/** The corners moved to, in order (from the entry corner, or home). */
function moves(runs: readonly CornerRun[], from: Corner): Corner[] {
  const out: Corner[] = []
  let at = from
  for (const r of runs) {
    if (r.corner !== at) out.push(r.corner)
    at = r.corner
  }
  return out
}

function plan(p: Project, track: CursorTrack, stretch: CornerStretch = fromStart(p.duration)): CornerRun[] {
  return planCorners(costsOf(p, track), [stretch], p.webcam.corner)
}

const at = (x: number, y: number) => ({ x, y })
const CENTRE = at(0.5, 0.5)

describe('cornerOrder', () => {
  it('is home, its horizontal neighbour, its vertical neighbour, the diagonal', () => {
    expect(cornerOrder('bottom-right')).toEqual(['bottom-right', 'bottom-left', 'top-right', 'top-left'])
    expect(cornerOrder('top-left')).toEqual(['top-left', 'top-right', 'bottom-left', 'bottom-right'])
  })
})

describe('F3a: the cursor works in the bubble for 10 s', () => {
  const p = project(40)
  const track: CursorTrack = { samples: samplesOf(40, (t) => (t >= 10 && t < 20 ? at(0.93, 0.9) : CENTRE)), clicks: [], valid: true }

  it('moves exactly once, to bottom-left, at a bin start in [8.5, 9.5], and never back', () => {
    const runs = plan(p, track)
    expect(moves(runs, 'bottom-right')).toEqual(['bottom-left'])
    const move = runs.find((r) => r.corner === 'bottom-left')!
    expect(move.start).toBeGreaterThanOrEqual(8.5)
    expect(move.start).toBeLessThanOrEqual(9.5)
    expect((move.start / 0.5) % 1).toBeCloseTo(0, 9)
    expect(move.end).toBe(40)
    expect(runs[0]).toEqual({ start: 0, end: move.start, corner: 'bottom-right' })
  })

  it('is deterministic', () => {
    expect(plan(p, track)).toEqual(plan(project(40), { ...track, samples: [...track.samples] }))
  })

  it('never picks the corner of a watermark (bottom-left)', () => {
    const marked = project(40, { watermark: { show: true, kind: 'text', text: 'Flown', position: 'bottom-left', size: 0.035, opacity: 0.85, margin: 0.035 } })
    const runs = plan(marked, track)
    expect(runs.some((r) => r.corner === 'bottom-left')).toBe(false)
    expect(moves(runs, 'bottom-right')).toEqual(['top-right'])
  })

  it('caches the costs per inputs', () => {
    const cursorPath = new SmoothedTrack(track.samples, 40, 0)
    const focusPath = focusPathFor(track.samples, 40)
    const a = cornerCosts(p, track, cursorPath, focusPath)
    expect(cornerCosts({ ...p }, track, cursorPath, focusPath)).toBe(a)
    expect(cornerCosts({ ...p, webcam: { ...p.webcam, size: 0.3 } }, track, cursorPath, focusPath)).not.toBe(a)
    expect(a.length).toBe(400)
    // Dilated: 0.6 s before the cursor arrives and 1.0 s after it leaves.
    expect(a.costs['bottom-right'][93]).toBe(0)
    expect(a.costs['bottom-right'][95]).toBeGreaterThan(0)
    expect(a.costs['bottom-right'][209]).toBeGreaterThan(0)
    expect(a.costs['bottom-right'][211]).toBe(0)
    expect(a.costs['top-left'][150]).toBe(0)
  })
})

describe('F3b: a short moving visit into the bubble', () => {
  const visit = (seconds: number): CursorTrack => ({
    samples: samplesOf(40, (t) =>
      t >= 20 && t < 20 + seconds ? at(BR_CENTRE.x + 0.02 * Math.cos(t * 4 * Math.PI), BR_CENTRE.y + 0.02 * Math.sin(t * 4 * Math.PI)) : CENTRE
    ),
    clicks: [],
    valid: true
  })

  it('does not move for 1.0 s (dilated cost about 2.6 < 3.0)', () => {
    expect(moves(plan(project(40), visit(1.0)), 'bottom-right')).toEqual([])
  })

  it('moves once for 2.0 s', () => {
    expect(moves(plan(project(40), visit(2.0)), 'bottom-right')).toEqual(['bottom-left'])
  })
})

describe('F3c: the cursor alternates between the two bottom corners', () => {
  const track: CursorTrack = {
    samples: samplesOf(30, (t) => (Math.floor(t / 3) % 2 === 0 ? at(0.93, 0.9) : at(0.07, 0.9))),
    clicks: [],
    valid: true
  }

  it('moves exactly once, to top-right, from a visible bubble in bottom-right', () => {
    const runs = plan(project(30), track, whole(30, { entry: 'bottom-right', enterVisible: true }))
    expect(runs).toEqual([{ start: 0, end: 30, corner: 'top-right' }])
    expect(moves(runs, 'bottom-right')).toEqual(['top-right'])
  })

  it('appears in top-right straight away when the bubble was not visible before', () => {
    expect(plan(project(30), track, whole(30))).toEqual([{ start: 0, end: 30, corner: 'top-right' }])
  })
})

describe('F3d: a camera position of the user', () => {
  it('keeps the bubble in it and writes nothing inside it', () => {
    const p = project(40, { layouts: [{ id: 'pos', start: 10, end: 30, layout: 'default', corner: 'top-left' }] })
    const track: CursorTrack = { samples: samplesOf(40, (t) => (t >= 10 && t < 30 ? at(0.08, 0.1) : CENTRE)), clicks: [], valid: true }
    const result = planDirector({ project: p, cursor: track, speech: null }, { ...DEFAULT_DIRECTOR, corners: 'auto' })
    expect(result.layouts.find((s) => s.id === 'pos')).toEqual({ id: 'pos', start: 10, end: 30, layout: 'default', corner: 'top-left' })
    expect(result.layouts.filter((s) => s.id !== 'pos' && s.start < 30 && s.end > 10)).toEqual([])
    expect(result.strip.find((s) => s.start <= 10 && s.end >= 30)).toEqual({ start: 10, end: 30, state: 'yours' })
  })

  it('moves into the position\'s corner at the end of a stretch (exit) without a minimum stay', () => {
    const p = project(20)
    const track: CursorTrack = { samples: samplesOf(20, () => CENTRE), clicks: [], valid: true }
    // Staying home and moving at the end costs 4.5 (diagonal); appearing in top-left costs 0.4.
    expect(plan(p, track, whole(10, { exit: 'top-left' }))).toEqual([{ start: 0, end: 10, corner: 'top-left' }])
    // Visible at home before it: one move either way, so the bubble stays and moves into the position at its start.
    expect(plan(p, track, whole(10, { entry: 'bottom-right', enterVisible: true, exit: 'top-left' }))).toEqual([{ start: 0, end: 10, corner: 'bottom-right' }])
  })
})

describe('F3e: the zoom path decides where things are seen', () => {
  const zoom: ZoomSegment = { id: 'z', start: 10, end: 30, scale: 2, focus: { mode: 'fixed', x: 0.3, y: 0.3 }, auto: false }
  const corner = (t: number) => (t >= 10 && t < 30 ? at(0.9, 0.85) : CENTRE)

  it('moves for a cursor in the bubble without zooms', () => {
    const track: CursorTrack = { samples: samplesOf(40, corner), clicks: [], valid: true }
    expect(moves(plan(project(40), track), 'bottom-right')).toEqual(['bottom-left'])
  })

  it('does not move when a zoom puts that point off the card', () => {
    const track: CursorTrack = { samples: samplesOf(40, corner), clicks: [], valid: true }
    expect(moves(plan(project(40, { zooms: [zoom] }), track), 'bottom-right')).toEqual([])
  })

  it('does not move for a cursor resting in the middle without zooms', () => {
    const track: CursorTrack = { samples: samplesOf(40, () => CENTRE), clicks: [], valid: true }
    expect(moves(plan(project(40), track), 'bottom-right')).toEqual([])
  })

  it('moves away from bottom-right when the zoom draws the resting cursor at (0.9, 0.9) of the card', () => {
    const track: CursorTrack = { samples: samplesOf(40, () => CENTRE), clicks: [], valid: true }
    const runs = plan(project(40, { zooms: [zoom] }), track)
    expect(moves(runs, 'bottom-right').length).toBeGreaterThanOrEqual(1)
    const during = runs.filter((r) => r.start < 29 && r.end > 11)
    expect(during.every((r) => r.corner !== 'bottom-right')).toBe(true)
  })
})

describe('the busy cap', () => {
  it('holds clicks cycling through the four corners every 6.5 s to at most 2 moves a minute', () => {
    const spots: Record<Corner, { x: number; y: number }> = {
      'top-left': at(0.09, 0.15),
      'top-right': at(0.91, 0.15),
      'bottom-right': at(0.91, 0.85),
      'bottom-left': at(0.09, 0.85)
    }
    const cycle: Corner[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
    const spot = (t: number) => spots[cycle[Math.floor(t / 6.5) % 4]]
    const clicks: ClickEvent[] = []
    for (let t = 0.5; t < 120; t += 6.5) clicks.push({ t, ...spot(t), button: 'left' })
    const track: CursorTrack = { samples: samplesOf(120, spot), clicks, valid: true }
    const runs = plan(project(120), track)
    const count = moves(runs, 'bottom-right').length - (runs[0].corner === 'bottom-right' ? 0 : 1)
    expect(count).toBeLessThanOrEqual(4)
    for (let i = 1; i < runs.length - 1; i++) expect(runs[i].end - runs[i].start).toBeGreaterThanOrEqual(6 - 1e-9)
  })
})

describe('minimum stay and ties', () => {
  it('holds every corner at least 6 s inside a stretch and keeps a stretch shorter than that in one corner', () => {
    const track: CursorTrack = { samples: samplesOf(40, (t) => (t >= 3 && t < 5 ? at(0.93, 0.9) : CENTRE)), clicks: [], valid: true }
    const short = plan(project(40), track, fromStart(5.5))
    expect(short.length).toBe(1)
  })

  it('stays home on a tie', () => {
    const track: CursorTrack = { samples: samplesOf(20, () => CENTRE), clicks: [], valid: true }
    expect(plan(project(20), track)).toEqual([{ start: 0, end: 20, corner: 'bottom-right' }])
  })

  it('appears where the bubble was last seen after a gap (the previous stretch\'s last corner)', () => {
    const track: CursorTrack = { samples: samplesOf(60, (t) => (t >= 10 && t < 20 ? at(0.93, 0.9) : CENTRE)), clicks: [], valid: true }
    const runs = planCorners(costsOf(project(60), track), [fromStart(25), { ...whole(60), start: 35 }], 'bottom-right')
    expect(runs[runs.length - 1]).toEqual({ start: 35, end: 60, corner: 'bottom-left' })
  })
})
