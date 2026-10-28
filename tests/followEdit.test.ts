import { describe, expect, it } from 'vitest'
import { dragView, holdViewAt } from '../src/shared/editor/followEdit'
import { fromCrop } from '../src/shared/engine/crop'
import { createProject } from '../src/shared/engine/project'
import { DEFAULT_REFRAME } from '../src/shared/engine/reframeData'
import type { NormRect, Project, ZoomSegment } from '../src/shared/types'

/*
 * Steering the view that follows the action (docs/design/vertical-video.md §2.6, tests 54 and 55):
 * Hold the view here writes a 1× zoom with a fixed point (or fixes the zoom at the playhead), and
 * dragging the picture moves that point (a region its rectangle), or the rest point without cursor
 * data. Positions are given in view space (after the crop) and stored in the full frame.
 */

const capture = { method: 'native', cursorInVideo: false, region: null, target: 'screen' } as const

function project(zooms: ZoomSegment[] = [], extra: Partial<Project> = {}): Project {
  const p = createProject({ id: 'p', name: 'p', duration: 20, width: 1920, height: 1080, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms, cursorValid: true, capture })
  return { ...p, style: { ...p.style, aspectRatio: '9:16' }, reframe: { ...DEFAULT_REFRAME }, ...extra }
}

const zoom = (id: string, start: number, end: number, focus: ZoomSegment['focus'], extra: Partial<ZoomSegment> = {}): ZoomSegment => ({ id, start, end, scale: 2, focus, auto: true, ...extra })

/** Deeply frozen, so an edit that mutates its input throws. */
function frozen<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) frozen((v as Record<string, unknown>)[k])
    Object.freeze(v)
  }
  return v
}

const LEFT_HALF: NormRect = { x: 0, y: 0, w: 0.5, h: 1 }
const RIGHT_HALF: NormRect = { x: 0.5, y: 0, w: 0.5, h: 1 }

describe('holdViewAt (test 54)', () => {
  it('outside a zoom: a 1× zoom with a fixed point at the centre, 3 s from the playhead', () => {
    const p = frozen(project())
    const r = holdViewAt(p, 5, { x: 0.767, y: 0.5 }, null)
    if (!r.project) throw new Error('no room')
    expect(r.project.zooms).toHaveLength(1)
    const z = r.project.zooms[0]
    expect(z).toMatchObject({ id: r.zoomId, start: 5, end: 8, scale: 1, focus: { mode: 'fixed', x: 0.767, y: 0.5 }, auto: false })
    // Nothing else changes.
    expect({ ...r.project, zooms: p.zooms }).toEqual(p)
  })

  it('stores the centre in the full frame (through fromCrop)', () => {
    const r = holdViewAt(project(), 5, { x: 0.5, y: 0.25 }, RIGHT_HALF)
    if (!r.project) throw new Error('no room')
    expect(r.project.zooms[0].focus).toEqual({ mode: 'fixed', ...fromCrop(RIGHT_HALF, { x: 0.5, y: 0.25 }) })
    expect(r.project.zooms[0].focus).toEqual({ mode: 'fixed', x: 0.75, y: 0.25 })
    // A centre off the view is kept on it.
    const off = holdViewAt(project(), 5, { x: 1.4, y: -0.2 }, LEFT_HALF)
    expect(off.project?.zooms[0].focus).toEqual({ mode: 'fixed', x: 0.5, y: 0 })
  })

  it('is fitted into the free gap like a new zoom, and needs at least 1 s', () => {
    const next = zoom('n', 6, 10, { mode: 'cursor' })
    const before = zoom('b', 0, 4.5, { mode: 'cursor' })
    // Close to the next zoom: it grows backwards into the free space.
    let r = holdViewAt(project([before, next]), 5, { x: 0.5, y: 0.5 }, null)
    expect(r.project?.zooms.find((z) => z.id === (r as { zoomId: string }).zoomId)).toMatchObject({ start: 4.5, end: 6 })
    // 1.1 s of room is enough.
    r = holdViewAt(project([zoom('b', 0, 4.5, { mode: 'cursor' }), zoom('n', 5.6, 10, { mode: 'cursor' })]), 5, { x: 0.5, y: 0.5 }, null)
    expect(r.project?.zooms).toHaveLength(3)
    // 0.8 s is not.
    r = holdViewAt(project([zoom('b', 0, 4.6, { mode: 'cursor' }), zoom('n', 5.4, 10, { mode: 'cursor' })]), 5, { x: 0.5, y: 0.5 }, null)
    expect(r).toEqual({ project: null, reason: 'no-room' })
    // Near the end of the recording.
    r = holdViewAt(project(), 19.5, { x: 0.5, y: 0.5 }, null)
    expect(r.project?.zooms[0]).toMatchObject({ start: 17, end: 20 })
  })

  it('inside a zoom that follows the cursor: its focus fixed at the centre, times and level kept', () => {
    const z = zoom('z', 2, 6, { mode: 'cursor' }, { anchor: { t: 3, x: 0.2, y: 0.3 } })
    const p = frozen(project([z]))
    const r = holdViewAt(p, 4, { x: 0.4, y: 0.6 }, null)
    expect(r).toMatchObject({ zoomId: 'z' })
    expect(r.project?.zooms).toEqual([{ ...z, focus: { mode: 'fixed', x: 0.4, y: 0.6 }, auto: false }])
  })

  it('inside a fixed zoom: its point moves to the centre (full frame)', () => {
    const r = holdViewAt(project([zoom('z', 2, 6, { mode: 'fixed', x: 0.1, y: 0.1 })]), 2, { x: 0.5, y: 0.5 }, LEFT_HALF)
    expect(r.project?.zooms[0].focus).toEqual({ mode: 'fixed', x: 0.25, y: 0.5 })
  })

  it('inside a region zoom: its rectangle is kept', () => {
    const p = project([zoom('r', 2, 6, { mode: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.3 })])
    const r = holdViewAt(p, 3, { x: 0.8, y: 0.8 }, null)
    expect(r).toEqual({ project: p, zoomId: 'r' })
  })
})

describe('dragView (test 55)', () => {
  it('moves a fixed point against the drag: the content follows the pointer', () => {
    const p = frozen(project([zoom('z', 4, 8, { mode: 'fixed', x: 0.767, y: 0.5 }, { scale: 1 })]))
    // Dragged right by 20% of a band view 0.4653 wide (e2e step 7).
    const q = dragView(p, 6, { x: 0.2 * 0.4653, y: 0 }, null, false)
    const f = q.zooms[0].focus
    expect(f.mode).toBe('fixed')
    expect(f.mode === 'fixed' && f.x).toBeCloseTo(0.674, 3)
    expect(f.mode === 'fixed' && f.y).toBe(0.5)
    expect(q.zooms[0]).toMatchObject({ start: 4, end: 8, scale: 1, auto: false })
    // Down and left: the point goes up and right; it stays on the recording.
    const r = dragView(p, 6, { x: -0.5, y: 0.1 }, null, false)
    expect(r.zooms[0].focus).toEqual({ mode: 'fixed', x: 1, y: 0.4 })
  })

  it('drags in view units: with a crop the stored point moves by the drag times the crop', () => {
    const p = project([zoom('z', 4, 8, { mode: 'fixed', x: 0.25, y: 0.5 })])
    const q = dragView(p, 5, { x: 0.1, y: 0 }, LEFT_HALF, false)
    expect(q.zooms[0].focus).toEqual({ mode: 'fixed', x: 0.2, y: 0.5 })
  })

  it('moves a region zoom by the same amount, kept inside the recording', () => {
    const p = project([zoom('r', 4, 8, { mode: 'region', x: 0.3, y: 0.2, w: 0.2, h: 0.2 })])
    const q = dragView(p, 5, { x: 0.1, y: -0.05 }, null, false)
    const f = q.zooms[0].focus
    expect(f).toMatchObject({ mode: 'region', w: 0.2, h: 0.2, y: 0.25 })
    expect(f.mode === 'region' && f.x).toBeCloseTo(0.2, 12)
    expect(q.zooms[0].scale).toBe(2)
    expect(dragView(p, 5, { x: 0.9, y: 0 }, null, false).zooms[0].focus).toMatchObject({ x: 0 })
  })

  it('without cursor data and without a zoom: the rest point moves (from the centre of what is shown)', () => {
    const p = frozen(project())
    const q = dragView(p, 5, { x: 0.1, y: -0.2 }, null, true)
    expect(q.reframe).toEqual({ ...DEFAULT_REFRAME, rest: { x: 0.4, y: 0.7 } })
    expect(q.zooms).toBe(p.zooms)
    // Again from there; cropped to the right half, the default rest is that half's centre.
    expect(dragView(q, 5, { x: 0.1, y: 0 }, null, true).reframe?.rest?.x).toBeCloseTo(0.3, 12)
    expect(dragView(p, 5, { x: 0.2, y: 0 }, RIGHT_HALF, true).reframe?.rest).toEqual({ x: 0.65, y: 0.5 })
    // Kept on the recording.
    expect(dragView(p, 5, { x: 2, y: 2 }, null, true).reframe?.rest).toEqual({ x: 0, y: 0 })
  })

  it('a zoom without cursor data still moves the zoom, not the rest point', () => {
    const p = project([zoom('z', 4, 8, { mode: 'fixed', x: 0.5, y: 0.5 })])
    const q = dragView(p, 5, { x: 0.1, y: 0 }, null, true)
    expect(q.zooms[0].focus).toEqual({ mode: 'fixed', x: 0.4, y: 0.5 })
    expect(q.reframe).toBe(p.reframe)
  })

  it('nothing to move with cursor data and no point: the project as it is (the caller holds the view first)', () => {
    const p = project([zoom('c', 4, 8, { mode: 'cursor' })])
    expect(dragView(p, 2, { x: 0.1, y: 0 }, null, false)).toBe(p)
    expect(dragView(p, 5, { x: 0.1, y: 0 }, null, false)).toBe(p)
  })

  it('a drag is one update: Hold the view here at the start, then the point dragged (as the preview does it)', () => {
    const history: Project[] = []
    let state = project([zoom('c', 4, 8, { mode: 'cursor' })])
    const start = state
    const held = holdViewAt(start, 5, { x: 0.6, y: 0.5 }, null)
    if (!held.project) throw new Error('no room')
    // Each move replaces the gesture's one change, computed from the state the drag started from.
    for (const dx of [0.02, 0.05, 0.1]) state = dragView(held.project, 5, { x: dx, y: 0 }, null, false)
    history.push(start, state)
    expect(state.zooms[0].focus.mode).toBe('fixed')
    const f = state.zooms[0].focus
    expect(f.mode === 'fixed' && f.x).toBeCloseTo(0.5, 12)
    expect(history).toHaveLength(2)
  })
})
