import { describe, expect, it } from 'vitest'
import {
  autoZoomsInFrame,
  clampIntoCrop,
  cropOf,
  cropPixels,
  croppedFrameSize,
  cropProject,
  cropTrack,
  cropView,
  fromCrop,
  geometryFromCrop,
  inCrop,
  readCrop,
  rectFromCrop,
  rectToCrop,
  regenerateInFrame,
  toCrop,
  visibleSize,
  zoomFromView,
  zoomInView
} from '../src/shared/engine/crop'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { DEFAULT_ZOOM_SETTINGS, rebaseAutoZooms } from '../src/shared/engine/zoom'
import type { CursorTrack, NormRect, Project, Shape, Spotlight, ZoomSegment } from '../src/shared/types'

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const FRAME_CONTEXT = '../src/renderer/src/render/frameContext'
const { inVideo } = (await import(/* @vite-ignore */ FRAME_CONTEXT)) as { inVideo: (p: { x: number; y: number }) => boolean }

/** 1280×720 with the bottom 48 px (a Windows taskbar at 100%) cropped off. */
const TASKBAR: NormRect = { x: 0, y: 0, w: 1, h: 672 / 720 }
const AUTO = DEFAULT_ZOOM_SETTINGS.auto

function project(extra: Partial<Project> = {}, width = 1280, height = 720): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 10,
    width,
    height,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' }
  })
  return { ...p, ...extra }
}

function track(extra: Partial<CursorTrack> = {}): CursorTrack {
  return {
    samples: [
      { t: 0, x: 0.5, y: 0.5 },
      { t: 6, x: 0.5, y: 0.97 },
      { t: 10, x: 0.5, y: 0.97 }
    ],
    clicks: [
      { t: 2, x: 0.5, y: 0.5, button: 'left' },
      { t: 6, x: 0.5, y: 0.97, button: 'left', up: 6.1 }
    ],
    keys: [{ t: 3, label: 'Ctrl + C' }],
    shapes: [],
    marks: [],
    typing: [],
    scrolls: [{ t: 4, x: 0.2, y: 0.99, dx: 0, dy: 1 }],
    scale: 1,
    valid: true,
    ...extra
  }
}

const idless = (zs: ZoomSegment[]): Omit<ZoomSegment, 'id'>[] => zs.map(({ id: _id, ...rest }) => rest)

/** A small seeded random generator (mulberry32), so failures reproduce. */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('readCrop and migrateProject', () => {
  it('reads a crop as the design lists it', () => {
    for (const bad of [undefined, 'x', { x: Number.NaN, y: 0, w: 1, h: 1 }]) expect(readCrop(bad, 1280, 720)).toBeUndefined()
    expect(readCrop({ x: 0, y: 0, w: 1, h: 0.933333 }, 1280, 720)).toEqual({ x: 0, y: 0, w: 1, h: 0.933333 })
    expect(readCrop({ x: -0.1, y: 0, w: 0.6, h: 1 }, 1280, 720)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 })
    expect(readCrop({ x: 0.5, y: 0.5, w: 0.02, h: 0.5 }, 1280, 720)).toBeUndefined()
    expect(readCrop({ x: 0.0001, y: 0, w: 0.9999, h: 1 }, 1280, 720)).toBeUndefined()
    const once = readCrop({ x: 0.123456, y: -0.2, w: 0.7, h: 0.9 }, 1280, 720)
    expect(readCrop(once, 1280, 720)).toEqual(once)
  })

  it('migrateProject keeps a valid crop and drops none or a whole-frame one', () => {
    const p = project()
    expect('crop' in migrateProject(p)).toBe(false)
    expect(migrateProject({ ...p, crop: TASKBAR }).crop).toEqual(TASKBAR)
    expect('crop' in migrateProject({ ...p, crop: { x: 0, y: 0, w: 1, h: 1 } })).toBe(false)
  })
})

describe('pixel sizes', () => {
  it('snaps the crop to whole pixels', () => {
    expect(cropPixels(null, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 })
    expect(cropPixels(TASKBAR, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 672 })
    expect(cropPixels({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 1919, 1079)).toEqual({ x: 192, y: 108, w: 959, h: 539 })
    expect(cropOf({ width: 1920, height: 1080, crop: { x: 0.10003, y: 0, w: 0.5, h: 1 } })!.x).toBe(192 / 1920)
    expect(visibleSize({ width: 1280, height: 720, crop: TASKBAR })).toEqual({ width: 1280, height: 672 })
  })

  it('croppedFrameSize falls back while no frame is decoded (not 1×1)', () => {
    expect(croppedFrameSize(TASKBAR, 0, 0, { width: 1280, height: 672 })).toEqual({ width: 1280, height: 672 })
    expect(croppedFrameSize(TASKBAR, 1280, 720, { width: 1, height: 1 })).toEqual({ width: 1280, height: 672 })
    expect(croppedFrameSize(null, 1280, 720, { width: 1, height: 1 })).toEqual({ width: 1280, height: 720 })
  })
})

describe('mapping points and rectangles', () => {
  const c = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }

  it('maps points into the view and back', () => {
    const v = toCrop(c, { x: 0.35, y: 0.4 })
    expect(v.x).toBeCloseTo(0.5, 12)
    expect(v.y).toBeCloseTo(0.5, 12)
    const back = fromCrop(c, v)
    expect(back.x).toBeCloseTo(0.35, 12)
    expect(back.y).toBeCloseTo(0.4, 12)
    const p = { x: 0.3, y: 0.3 }
    expect(toCrop(null, p)).toBe(p)
    expect(fromCrop(null, p)).toBe(p)
  })

  it('maps rectangles, negative sizes (arrows and lines) included', () => {
    const r = rectToCrop(c, { x: 0.6, y: 0.6, w: -0.2, h: -0.1 })
    expect(r.x).toBeCloseTo(1, 12)
    expect(r.y).toBeCloseTo(1, 12)
    expect(r.w).toBeCloseTo(-0.4, 12)
    expect(r.h).toBeCloseTo(-0.25, 12)
    const back = rectFromCrop(c, r)
    expect(back.x).toBeCloseTo(0.6, 12)
    expect(back.w).toBeCloseTo(-0.2, 12)
    const shape = { x: 0.2, y: 0.3, w: 0.1, h: 0.1, color: '#fff' }
    expect(rectToCrop(c, shape).color).toBe('#fff')
    expect(rectToCrop(null, shape)).toBe(shape)
  })

  it('maps a partial geometry patch field by field and keeps the other fields', () => {
    const patch = geometryFromCrop(c, { x: 0.5, w: 0.5, mode: 'region' as const })
    expect(patch).toEqual({ x: 0.35, w: 0.25, mode: 'region' })
    expect('y' in patch).toBe(false)
    const only = { h: 0.5 }
    expect(geometryFromCrop(null, only)).toBe(only)
    expect(geometryFromCrop(c, only).h).toBeCloseTo(0.2, 12)
  })

  it('inCrop is exactly the test the view applies (inVideo of the mapped point)', () => {
    const rnd = random(7)
    for (let i = 0; i < 1000; i++) {
      const crop = cropOf({ width: 1920, height: 1080, crop: { x: rnd() * 0.5, y: rnd() * 0.5, w: 0.1 + rnd() * 0.5, h: 0.1 + rnd() * 0.5 } })!
      // Points near the crop's edges, where rounding would show.
      const p = { x: crop.x + (rnd() * 1.2 - 0.1) * crop.w, y: crop.y + (rnd() < 0.2 ? 1 : rnd() * 1.2 - 0.1) * crop.h }
      const viewed = cropTrack(track({ clicks: [{ t: 1, ...p, button: 'left' }] }), crop).clicks[0]
      expect(inCrop(crop, p)).toBe(inVideo(viewed))
      expect(inCrop(crop, p)).toBe(inVideo(toCrop(crop, p)))
    }
    expect(inCrop(null, { x: 1.2, y: 0.5 })).toBe(false)
  })

  it('clampIntoCrop moves a point into the crop, and keeps one inside as the same object', () => {
    const inside = { x: 0.3, y: 0.3, t: 1 }
    expect(clampIntoCrop(c, inside)).toBe(inside)
    expect(clampIntoCrop(c, { x: 0.9, y: 0.1, t: 1 })).toEqual({ x: 0.6, y: 0.2, t: 1 })
    expect(clampIntoCrop(null, { x: 2, y: 2 })).toEqual({ x: 2, y: 2 })
  })

  it('zoomInView maps fixed points, regions and anchors, and zoomFromView maps them back', () => {
    const fixed: ZoomSegment = { id: 'a', start: 1, end: 3, scale: 2, focus: { mode: 'fixed', x: 0.35, y: 0.4 }, auto: false }
    const region: ZoomSegment = { id: 'b', start: 4, end: 6, scale: 2, focus: { mode: 'region', x: 0.1, y: 0.2, w: 0.25, h: 0.2 }, auto: false }
    const cursor: ZoomSegment = { id: 'c', start: 7, end: 9, scale: 1.8, focus: { mode: 'cursor' }, auto: true, anchor: { t: 7.5, x: 0.35, y: 0.4, until: 8 } }
    const v = zoomInView(c, fixed)
    expect(v.focus).toEqual({ mode: 'fixed', x: expect.closeTo(0.5, 12), y: expect.closeTo(0.5, 12) })
    expect(v.scale).toBe(2)
    expect(zoomInView(c, region).focus).toEqual({ mode: 'region', x: 0, y: 0, w: 0.5, h: 0.5 })
    const a = zoomInView(c, cursor)
    expect(a.anchor).toEqual({ t: 7.5, x: expect.closeTo(0.5, 12), y: expect.closeTo(0.5, 12), until: 8 })
    expect(a.focus).toBe(cursor.focus)
    const plain: ZoomSegment = { ...cursor, anchor: undefined }
    delete plain.anchor
    expect(zoomInView(c, plain)).toBe(plain)
    expect(zoomInView(null, fixed)).toBe(fixed)
    for (const z of [fixed, region, cursor]) {
      const back = zoomFromView(c, zoomInView(c, z))
      expect(back.id).toBe(z.id)
      expect(JSON.stringify(back, (_k, n: unknown) => (typeof n === 'number' ? +n.toFixed(12) : n))).toBe(JSON.stringify(z))
    }
  })
})

describe('cropTrack', () => {
  it('is the track itself without a crop', () => {
    const t = track()
    expect(cropTrack(t, null)).toBe(t)
  })

  it('maps samples, clicks (release kept) and scrolls, and shares everything else', () => {
    const t = track()
    const v = cropTrack(t, TASKBAR)
    expect(v.samples[1]).toEqual({ t: 6, x: 0.5, y: expect.closeTo(0.97 / (672 / 720), 12) })
    expect(v.clicks[1]).toEqual({ t: 6, x: 0.5, y: expect.closeTo(1.039286, 6), button: 'left', up: 6.1 })
    expect(v.scrolls![0].y).toBeCloseTo(0.99 / (672 / 720), 12)
    expect(v.scrolls![0].dy).toBe(1)
    expect(v.keys).toBe(t.keys)
    expect(v.typing).toBe(t.typing)
    expect(v.marks).toBe(t.marks)
    expect(v.valid).toBe(true)
    expect(cropTrack(t, { ...TASKBAR })).toBe(v)
  })

  it('keeps the mapped samples when only the clicks change (no smoothed path is rebuilt)', () => {
    const t = track()
    const v = cropTrack(t, TASKBAR)
    const ignored = { ...t, clicks: t.clicks.slice(0, 1) }
    const w = cropTrack(ignored, TASKBAR)
    expect(w.samples).toBe(v.samples)
    expect(w.clicks).not.toBe(v.clicks)
    expect(w.clicks).toHaveLength(1)
  })

  it('leaves out scrolls a track never recorded', () => {
    const t = track()
    delete t.scrolls
    expect('scrolls' in cropTrack(t, TASKBAR)).toBe(false)
  })
})

describe('cropProject', () => {
  const zooms: ZoomSegment[] = [
    { id: 'f', start: 1, end: 2, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false },
    { id: 'r', start: 3, end: 4, scale: 2, focus: { mode: 'region', x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, auto: false },
    { id: 'a', start: 5, end: 7, scale: 1.8, focus: { mode: 'cursor' }, auto: true, anchor: { t: 6, x: 0.5, y: 0.97 } }
  ]
  const shape: Shape = { id: 's', start: 0, end: 2, kind: 'rect', x: 0.25, y: 0.5, w: 0.5, h: 0.2, color: '#ff0000', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }
  const spot = (extra: Partial<Spotlight>): Spotlight => ({ id: 'l', start: 0, end: 2, mode: 'region', x: 0.3, y: 0.3, w: 0.4, h: 0.4, shape: 'ellipse', dim: 0.6, feather: 0.4, ...extra })

  it('is the project itself without a crop', () => {
    const p = project({ zooms })
    expect(cropProject(p)).toBe(p)
  })

  it('draws the crop: its pixel size, no crop key, positions in view space', () => {
    const p = project({ crop: TASKBAR, zooms, shapes: [shape], spotlights: [spot({ id: 'c', mode: 'cursor', w: 0.135, h: 0.24 }), spot({ id: 'out', y: 0.95, h: 0.04, feather: 0 })] })
    const v = cropProject(p)
    expect(v.width).toBe(1280)
    expect(v.height).toBe(672)
    expect('crop' in v).toBe(false)
    expect(v.zooms[0].focus).toEqual({ mode: 'fixed', x: 0.5, y: expect.closeTo(0.535714, 6) })
    expect(v.zooms[1].focus).toEqual({ mode: 'region', x: 0.25, y: expect.closeTo(0.267857, 6), w: 0.5, h: expect.closeTo(0.535714, 6) })
    expect(v.zooms[2].anchor).toEqual({ t: 6, x: 0.5, y: expect.closeTo(1.039286, 6) })
    expect(v.shapes![0]).toEqual({ ...shape, y: expect.closeTo(0.535714, 6), h: expect.closeTo(0.214286, 6) })
    expect(v.spotlights![0].h).toBeCloseTo(0.257143, 6)
    expect(v.spotlights![0].w).toBe(0.135)
    // Entirely under the cropped taskbar: off the view, so it lights nothing that is shown.
    expect(v.spotlights![1]).toMatchObject({ x: 1.5, y: 1.5, w: 0.005, h: 0.005 })
    // Everything else is shared.
    expect(v.style).toBe(p.style)
    expect(v.clips).toBe(p.clips)
    expect(cropProject(p)).toBe(v)
  })

  it('keeps a region spotlight its soft edge still shows', () => {
    // Its box ends 6 px below the crop; the outer half of its soft edge reaches into it.
    const v = cropProject(project({ crop: TASKBAR, spotlights: [spot({ y: 678 / 720, h: 0.1, feather: 1 })] }))
    expect(v.spotlights![0].y).toBeCloseTo(678 / 672, 9)
  })

  it('shares the mapped lists between projects with the same lists', () => {
    const a = project({ crop: TASKBAR, zooms, shapes: [shape] })
    const b = { ...a, name: 'renamed' }
    expect(cropProject(b)).not.toBe(cropProject(a))
    expect(cropProject(b).zooms).toBe(cropProject(a).zooms)
    expect(cropProject(b).shapes).toBe(cropProject(a).shapes)
    // Another crop maps them again.
    expect(cropProject({ ...a, crop: { x: 0, y: 0, w: 0.5, h: 1 } }).zooms).not.toBe(cropProject(a).zooms)
  })
})

describe('cropView', () => {
  it('is the project and track themselves without a crop', () => {
    const p = project()
    const t = track()
    expect(cropView(p, t)).toEqual({ project: p, cursor: t, crop: null })
    expect(cropView(p, t).project).toBe(p)
  })

  it('is memoised per project and track, with the snapped crop', () => {
    const p = project({ crop: { x: 0.10003, y: 0, w: 0.5, h: 1 } }, 1920, 1080)
    const t = track()
    const v = cropView(p, t)
    expect(v.crop).toEqual({ x: 0.1, y: 0, w: 0.5, h: 1 })
    expect(cropView(p, t)).toBe(v)
    expect(v.project).toBe(cropProject(p))
    expect(v.cursor).toBe(cropTrack(t, v.crop))
    const other = { ...t, keys: [] }
    expect(cropView(p, other)).not.toBe(v)
  })
})

describe('automatic zooms in the cropped frame', () => {
  it('drops the zooms for hidden clicks, the others deep-equal to those without a crop', () => {
    const t = track({ scrolls: [] })
    const whole = autoZoomsInFrame(t, project(), AUTO)
    expect(whole).toHaveLength(2)
    const cropped = autoZoomsInFrame(t, project({ crop: TASKBAR }), AUTO)
    expect(cropped).toHaveLength(1)
    expect(idless(cropped)).toEqual(idless(whole.slice(0, 1)))
  })

  it('without a crop it is exactly autoZoomsForTrack', () => {
    const t = track({ scrolls: [] })
    expect(idless(autoZoomsInFrame(t, project(), AUTO))).toEqual(idless(regenerateInFrame([], t, project(), AUTO).zooms))
  })

  it('clamps anchors into the crop (typing beside the crop, a mark under it)', () => {
    const t = track({ clicks: [], scrolls: [], typing: [{ t: 2, end: 4 }], samples: [{ t: 0, x: 0.95, y: 0.5 }, { t: 10, x: 0.95, y: 0.5 }] })
    const zs = autoZoomsInFrame(t, project({ crop: { x: 0, y: 0, w: 0.5, h: 1 } }), AUTO)
    expect(zs).toHaveLength(1)
    expect(zs[0].anchor).toMatchObject({ x: 0.5, y: 0.5, until: 4 })
  })

  it('is exact for points inside: fixed focus kept, and rebaseAutoZooms changes nothing (valid: false)', () => {
    const t = track({ valid: false, samples: [], scrolls: [], clicks: [{ t: 2, x: 0.3, y: 0.3, button: 'left' }] })
    const crop = { x: 0.1, y: 0.1, w: 0.7, h: 0.7 }
    const before = autoZoomsInFrame(t, project({}, 1000, 1000), AUTO)
    const after = autoZoomsInFrame(t, project({ crop }, 1000, 1000), AUTO)
    expect(after[0].focus).toEqual({ mode: 'fixed', x: 0.3, y: 0.3 })
    expect(after[0].anchor).toEqual({ t: 2, x: 0.3, y: 0.3 })
    const zooms = before.map((z) => ({ ...z }))
    expect(rebaseAutoZooms(zooms, before, after)).toBe(zooms)
  })

  it('clamps a fixed focus copied from an anchor outside the crop (valid: false)', () => {
    const t = track({ valid: false, samples: [], scrolls: [], clicks: [], marks: [{ t: 2 }] })
    const zs = autoZoomsInFrame(t, project({ crop: { x: 0.6, y: 0.6, w: 0.4, h: 0.4 } }), AUTO)
    // Without cursor data a mark aims at the centre, which this crop hides.
    expect(zs[0].anchor).toMatchObject({ x: 0.6, y: 0.6 })
    expect(zs[0].focus).toEqual({ mode: 'fixed', x: 0.6, y: 0.6 })
  })

  it('regenerateInFrame keeps manual zooms as the same objects and drops hidden clicks', () => {
    const manual: ZoomSegment = { id: 'm', start: 8.5, end: 9.5, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.99 }, auto: false }
    const stale: ZoomSegment = { id: 'old', start: 5, end: 7, scale: 2, focus: { mode: 'cursor' }, auto: true }
    const t = track({ scrolls: [] })
    const r = regenerateInFrame([stale, manual], t, project({ crop: TASKBAR }), AUTO)
    expect(r.zooms).toHaveLength(2)
    expect(r.zooms[1]).toBe(manual)
    expect(r.zooms[0].anchor).toEqual({ t: 2, x: 0.5, y: 0.5 })
    expect(r).toMatchObject({ removed: 1, added: 1, kept: 1 })
  })
})
