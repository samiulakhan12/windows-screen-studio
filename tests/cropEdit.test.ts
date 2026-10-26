/**
 * The crop tool's maths and the crop edit (docs/design/crop-in-editor.md §4.7–4.9): drags with
 * aspect locks, fitting a lock, snapping, the presets, applying a crop (with the auto zoom rebase,
 * as one undo step), what is left outside, the notice, and zoom edits made in the crop's view.
 */
import { describe, expect, it } from 'vitest'
import {
  browserBarCrop,
  cropNotice,
  cropRatio,
  dragCrop,
  fitCropAspect,
  outsideCrop,
  setCrop,
  setZoomLevelInView,
  setZoomRegionInView,
  snapCrop,
  taskbarCrop,
  type CropOutcome
} from '../src/shared/editor/cropEdit'
import { EditStore } from '../src/shared/editor/editStore'
import { setClicksIgnored } from '../src/shared/editor/inputEdits'
import { setZoomLevel } from '../src/shared/editor/zoomEdit'
import { cropOf, FULL_FRAME, zoomInView } from '../src/shared/engine/crop'
import { createProject } from '../src/shared/engine/project'
import { autoZoomsForTrack, DEFAULT_ZOOM_SETTINGS, zoomTargetScale } from '../src/shared/engine/zoom'
import type { CaptureInfo, CursorTrack, NormRect, Project, Shape, Spotlight, ZoomSegment } from '../src/shared/types'

const HD = { width: 1920, height: 1080 }
/** The bottom 48 px of 1920×1080 cropped off (a Windows taskbar at 100%). */
const TASKBAR: NormRect = { x: 0, y: 0, w: 1, h: 1032 / 1080 }
const SCREEN: CaptureInfo = { method: 'native', cursorInVideo: false, region: null, target: 'screen' }

function project(patch: Partial<Project> = {}, size = HD): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 10,
    width: size.width,
    height: size.height,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: SCREEN
  })
  return { ...p, ...patch }
}

/** Clicks at 2 s in the middle and at 6 s on the taskbar. */
function track(valid = true): CursorTrack {
  return {
    samples: valid ? [{ t: 0, x: 0.5, y: 0.5 }, { t: 10, x: 0.5, y: 0.5 }] : [],
    clicks: [
      { t: 2, x: 0.5, y: 0.5, button: 'left' },
      { t: 6, x: 0.5, y: 0.99, button: 'left' }
    ],
    scale: 1,
    valid
  }
}

/** A project whose zooms are exactly what auto zoom made for `t`. */
const generated = (t: CursorTrack, patch: Partial<Project> = {}): Project => {
  const p = project(patch)
  return { ...p, zooms: autoZoomsForTrack(t, p.duration, DEFAULT_ZOOM_SETTINGS.auto) }
}

const px = (r: NormRect, size = HD) => ({ x: r.x * size.width, y: r.y * size.height, w: r.w * size.width, h: r.h * size.height })
const near = (r: NormRect, want: NormRect): void => {
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(r[k], k).toBeCloseTo(want[k], 9)
}

describe('dragCrop', () => {
  it('moves the box inside the frame without resizing it', () => {
    expect(dragCrop({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 'move', 0.3, 0, HD, null)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    near(dragCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 'move', -0.1, 0.4, HD, null), { x: 0.15, y: 0.5, w: 0.5, h: 0.5 })
  })

  it('moves free edges and corners, never under 64 px', () => {
    expect(dragCrop(FULL_FRAME, 'se', -0.5, -0.5, HD, null)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 })
    const tiny = dragCrop(FULL_FRAME, 'se', -0.99, -0.99, HD, null)
    expect(tiny.w).toBeCloseTo(64 / 1920, 12)
    expect(tiny.h).toBeCloseTo(64 / 1080, 12)
    near(dragCrop(FULL_FRAME, 'n', 0, 0.2, HD, null), { x: 0, y: 0.2, w: 1, h: 0.8 })
    // Never past the frame.
    expect(dragCrop({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 'nw', -0.5, -0.5, HD, null)).toEqual({ x: 0, y: 0, w: 0.6, h: 0.6 })
  })

  it('keeps the ratio on a locked corner, as far as the frame allows', () => {
    expect(dragCrop({ x: 0, y: 0, w: 0.5, h: 0.5 }, 'se', 0.1, 0, HD, 1)).toEqual({ x: 0, y: 0, w: 0.5625, h: 1 })
    const r = dragCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 'nw', 0.1, 0.1, HD, 16 / 9)
    const p = px(r)
    expect(p.w / p.h).toBeCloseTo(16 / 9, 9)
    // The opposite corner stays.
    expect(r.x + r.w).toBeCloseTo(0.75, 12)
    expect(r.y + r.h).toBeCloseTo(0.75, 12)
  })

  it('keeps the ratio on a locked edge, around the box centre', () => {
    near(dragCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 'n', 0, -0.1, HD, 16 / 9), { x: 0.2, y: 0.15, w: 0.6, h: 0.6 })
    const r = dragCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 'e', 0.25, 0, HD, 16 / 9)
    // The width stops at the frame's right edge; the height follows around the centre.
    near(r, { x: 0.25, y: 0.125, w: 0.75, h: 0.75 })
  })

  it('never makes a crop under 64 px or outside the frame', () => {
    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'move'] as const
    let r: NormRect = { ...FULL_FRAME }
    for (let i = 0; i < 400; i++) {
      const ratio = i % 3 === 0 ? 16 / 9 : i % 3 === 1 ? 9 / 16 : null
      r = dragCrop(r, handles[i % handles.length], Math.sin(i * 1.7) * 0.8, Math.cos(i * 2.3) * 0.8, HD, ratio)
      const p = px(r)
      expect(p.w).toBeGreaterThanOrEqual(64 - 1e-6)
      expect(p.h).toBeGreaterThanOrEqual(64 - 1e-6)
      expect(r.x).toBeGreaterThanOrEqual(-1e-12)
      expect(r.y).toBeGreaterThanOrEqual(-1e-12)
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-12)
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-12)
    }
  })
})

describe('aspect locks', () => {
  it('locks to pixel ratios; Original is the recording', () => {
    expect(cropRatio('free', 1920, 1080)).toBeNull()
    expect(cropRatio('original', 1920, 1032)).toBeCloseTo(1920 / 1032, 12)
    expect(cropRatio('9:16', 1920, 1080)).toBe(9 / 16)
  })

  it('fitCropAspect is the largest box of the ratio inside, centred', () => {
    const r = px(fitCropAspect(TASKBAR, 16 / 9, HD))
    expect(Math.abs(r.w - 1835)).toBeLessThan(1)
    expect(r.h).toBeCloseTo(1032, 9)
    expect(r.x).toBeCloseTo((1920 - r.w) / 2, 9)
    expect(r.y).toBeCloseTo(0, 9)
    const tall = px(fitCropAspect(FULL_FRAME, 9 / 16, HD))
    expect(tall).toEqual({ x: expect.closeTo(656.25, 9), y: 0, w: expect.closeTo(607.5, 9), h: 1080 })
  })
})

describe('snapCrop', () => {
  const magnet = { x: 8 / 1920, y: 8 / 1080 }

  it('snaps an edge near the frame to it and lands on whole pixels', () => {
    const r = snapCrop({ x: 100.4 / 1920, y: 3 / 1080, w: (1915 - 100.4) / 1920, h: 500.6 / 1080 }, HD, magnet, null)
    expect(r.x + r.w).toBe(1)
    expect(r.y).toBe(0)
    const p = px(r)
    for (const v of [p.x, p.y, p.w, p.h]) expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-9)
    expect(p.x).toBeCloseTo(100, 9)
    expect(p.h).toBeCloseTo(504, 9)
  })

  it('with a ratio, moves the whole box to the edge and keeps the ratio (±1 px)', () => {
    const r = snapCrop({ x: 5 / 1920, y: 200.3 / 1080, w: 960.4 / 1920, h: 540.2 / 1080 }, HD, magnet, 16 / 9)
    const p = px(r)
    expect(p.x).toBe(0)
    expect(p.w).toBeCloseTo(960, 9)
    expect(p.h).toBeCloseTo(540, 9)
    expect(p.y).toBeCloseTo(200, 9)
  })
})

describe('presets', () => {
  it('Hide taskbar moves the bottom edge above the taskbar (DIP × display scale)', () => {
    const p = project()
    expect(taskbarCrop(FULL_FRAME, p, 1)!.h).toBeCloseTo(1032 / 1080, 12)
    expect(taskbarCrop(FULL_FRAME, p, undefined)!.h).toBeCloseTo(1032 / 1080, 12)
    expect(taskbarCrop(FULL_FRAME, project({}, { width: 2560, height: 1440 }), 1.5)!.h).toBeCloseTo(0.95, 12)
    // An area at the bottom of the screen shows the taskbar; one at the top does not.
    const low = taskbarCrop(FULL_FRAME, project({ capture: { ...SCREEN, target: 'area', region: { x: 0, y: 0.5, w: 0.5, h: 0.5 } } }, { width: 960, height: 540 }), 1)!
    expect(1 - low.h).toBeCloseTo(0.0889, 4)
    expect(taskbarCrop(FULL_FRAME, project({ capture: { ...SCREEN, target: 'area', region: { x: 0, y: 0, w: 0.5, h: 0.5 } } }, { width: 960, height: 540 }), 1)).toBeNull()
    // Older projects: an area when a region is set.
    expect(taskbarCrop(FULL_FRAME, project({ capture: { method: 'chromium', cursorInVideo: true, region: { x: 0, y: 0, w: 0.5, h: 0.5 } } }), 1)).toBeNull()
    expect(taskbarCrop(FULL_FRAME, project({ capture: { ...SCREEN, target: 'window' } }), 1)).toBeNull()
  })

  it('moves one edge of the draft only', () => {
    const draft = { x: 0.1, y: 0.2, w: 0.6, h: 0.8 }
    const r = taskbarCrop(draft, project(), 1)!
    expect(r).toEqual({ x: 0.1, y: 0.2, w: 0.6, h: expect.closeTo(1032 / 1080 - 0.2, 12) })
    const b = browserBarCrop(draft, project(), 1)!
    expect(b).toEqual({ x: 0.1, y: expect.closeTo(88 / 1080, 12), w: 0.6, h: expect.closeTo(1 - 88 / 1080, 12) })
  })

  it('Hide browser bar moves the top edge below the tabs and address bar', () => {
    expect(browserBarCrop(FULL_FRAME, project(), 1)!.y).toBeCloseTo(0.081481, 6)
    expect(browserBarCrop(FULL_FRAME, project({ capture: { ...SCREEN, target: 'window' } }), 1)).not.toBeNull()
    expect(browserBarCrop(FULL_FRAME, project({ capture: { ...SCREEN, target: 'area', region: { x: 0.2, y: 0, w: 0.5, h: 0.5 } } }), 1)).not.toBeNull()
    expect(browserBarCrop(FULL_FRAME, project({ capture: { ...SCREEN, target: 'area', region: { x: 0.2, y: 0.1, w: 0.5, h: 0.5 } } }), 1)).toBeNull()
    // Not on a recording too short for a browser bar to be a small part of it.
    expect(browserBarCrop(FULL_FRAME, project({}, { width: 800, height: 300 }), 1)).toBeNull()
  })
})

describe('setCrop', () => {
  it('returns the project itself for an unchanged crop', () => {
    const p = project({ crop: TASKBAR })
    expect(setCrop(p, TASKBAR, track()).project).toBe(p)
    // The same pixels, as the tool hands them back.
    expect(setCrop(p, { ...TASKBAR, h: TASKBAR.h + 1e-7 }, track()).project).toBe(p)
    const q = project()
    expect(setCrop(q, null, track()).project).toBe(q)
    expect(setCrop(q, FULL_FRAME, track()).project).toBe(q)
  })

  it('removes the key for a whole-frame crop', () => {
    const r = setCrop(project({ crop: TASKBAR }), { x: 0, y: 0, w: 1, h: 1 }, null)
    expect('crop' in r.project).toBe(false)
    expect('crop' in setCrop(project({ crop: TASKBAR }), null, null).project).toBe(false)
  })

  it('removes the automatic zoom of a hidden click, and brings it back when widened', () => {
    const t = track()
    const p = generated(t)
    expect(p.zooms).toHaveLength(2)
    const cropped = setCrop(p, TASKBAR, t)
    expect(cropped.removedAutoZooms).toBe(1)
    expect(cropped.restoredAutoZooms).toBe(0)
    expect(cropped.project.crop).toEqual(TASKBAR)
    expect(cropped.project.zooms).toEqual([p.zooms[0]])
    expect(cropped.project.zooms[0]).toBe(p.zooms[0])
    const back = setCrop(cropped.project, null, t)
    expect(back.restoredAutoZooms).toBe(1)
    expect(back.removedAutoZooms).toBe(0)
    expect(back.project.zooms.map(({ id: _id, ...z }) => z)).toEqual(p.zooms.map(({ id: _id, ...z }) => z))
  })

  it('keeps a manual zoom aimed under the crop and counts it as outside', () => {
    const t = track()
    const manual: ZoomSegment = { id: 'm', start: 8.5, end: 9.5, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.97 }, auto: false }
    const p = generated(t)
    const r = setCrop({ ...p, zooms: [...p.zooms, manual] }, TASKBAR, t)
    expect(r.project.zooms).toContain(manual)
    expect(r.outside).toEqual({ zooms: 1, shapes: 0, spotlights: 0 })
  })

  it('rebases a project without cursor data too (fixed focus on the click)', () => {
    const t = track(false)
    const p = generated(t)
    expect(p.zooms[1].focus).toEqual({ mode: 'fixed', x: 0.5, y: 0.99 })
    const r = setCrop(p, TASKBAR, t)
    expect(r.removedAutoZooms).toBe(1)
    expect(r.project.zooms).toEqual([p.zooms[0]])
  })

  it('leaves the zooms alone with auto zoom off or without a track', () => {
    const t = track()
    const p = generated(t)
    expect(setCrop(p, TASKBAR, null).project.zooms).toBe(p.zooms)
    const off = { ...p, autoZoom: false, zoomSettings: { ...p.zoomSettings!, auto: { ...p.zoomSettings!.auto, enabled: false } } }
    expect(setCrop(off, TASKBAR, t).project.zooms).toBe(p.zooms)
  })

  it('ignoring and using clicks rebases in the crop frame too (setClicksIgnored)', () => {
    const t = track()
    const cropped = setCrop(generated(t), TASKBAR, t).project
    // The hidden click makes no zoom, ignored or used.
    const hidden = setClicksIgnored(cropped, t, { ignore: [{ ms: 6000 }] })
    expect(hidden.zooms).toBe(cropped.zooms)
    expect(setClicksIgnored(hidden, t, { use: [6000] }).zooms).toBe(cropped.zooms)
    expect(setClicksIgnored(cropped, t, { ignore: [{ ms: 2000 }] }).zooms).toEqual([])
  })

  it('is one undo step through the edit store, and undo restores the crop and the zooms', () => {
    const t = track()
    const p = generated(t)
    const store = new EditStore(p)
    store.update((q) => setCrop(q, TASKBAR, t).project)
    expect(store.state.crop).toEqual(TASKBAR)
    expect(store.state.zooms).toHaveLength(1)
    // Done again with the same rectangle adds nothing.
    store.update((q) => setCrop(q, TASKBAR, t).project)
    expect(store.undo()).toBe(true)
    expect(store.state).toBe(p)
    expect(store.canUndo).toBe(false)
  })
})

describe('outsideCrop', () => {
  const shape = (x: number, y: number, w: number, h: number): Shape => ({ id: `s${x}${y}`, start: 0, end: 1, kind: 'arrow', x, y, w, h, color: '#ff0000', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 })
  const spot = (mode: Spotlight['mode'], y: number): Spotlight => ({ id: `l${mode}${y}`, start: 0, end: 1, mode, x: 0.2, y, w: 0.2, h: 0.02, shape: 'rect', dim: 0.6, feather: 0 })

  it('counts zooms, shapes and region spotlights the crop does not show', () => {
    const zooms: ZoomSegment[] = [
      { id: 'a', start: 0, end: 1, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.98 }, auto: false },
      { id: 'b', start: 1, end: 2, scale: 2, focus: { mode: 'region', x: 0.1, y: 0.96, w: 0.2, h: 0.03 }, auto: false },
      { id: 'c', start: 2, end: 3, scale: 2, focus: { mode: 'region', x: 0.1, y: 0.9, w: 0.2, h: 0.08 }, auto: false },
      { id: 'd', start: 3, end: 4, scale: 2, focus: { mode: 'cursor' }, auto: false, anchor: { t: 3.5, x: 0.5, y: 0.99 } },
      { id: 'e', start: 4, end: 5, scale: 2, focus: { mode: 'cursor' }, auto: true }
    ]
    const p = project({
      zooms,
      // An arrow drawn upwards from the taskbar to just under it, and one reaching into the crop.
      shapes: [shape(0.3, 0.99, 0.1, -0.02), shape(0.3, 0.99, 0.1, -0.2)],
      spotlights: [spot('region', 0.97), spot('region', 0.5), spot('cursor', 0.97)]
    })
    expect(outsideCrop(p, cropOf({ ...p, crop: TASKBAR }))).toEqual({ zooms: 3, shapes: 1, spotlights: 1 })
    expect(outsideCrop(p, null)).toEqual({ zooms: 0, shapes: 0, spotlights: 0 })
  })
})

describe('cropNotice', () => {
  const outcome = (o: Partial<CropOutcome>): CropOutcome => ({
    project: project({ crop: TASKBAR }),
    removedAutoZooms: 0,
    restoredAutoZooms: 0,
    outside: { zooms: 0, shapes: 0, spotlights: 0 },
    ...o
  })

  it('says the new size and what happened to zooms and items', () => {
    expect(cropNotice(outcome({}))).toBe('Cropped to 1920 × 1032.')
    expect(cropNotice(outcome({ removedAutoZooms: 1 }))).toBe('Cropped to 1920 × 1032. 1 automatic zoom for a click outside it was removed.')
    expect(cropNotice(outcome({ removedAutoZooms: 2, outside: { zooms: 0, shapes: 2, spotlights: 0 } }))).toBe(
      'Cropped to 1920 × 1032. 2 automatic zooms for clicks outside it were removed. 2 shapes are outside it; they come back if you widen the crop.'
    )
    expect(cropNotice(outcome({ restoredAutoZooms: 2 }))).toBe('Cropped to 1920 × 1032. 2 automatic zooms came back.')
    expect(cropNotice(outcome({ removedAutoZooms: 2, restoredAutoZooms: 1 }))).toBe(
      'Cropped to 1920 × 1032. 1 automatic zoom for a click outside it was removed. 1 automatic zoom was adjusted.'
    )
    expect(cropNotice(outcome({ outside: { zooms: 1, shapes: 0, spotlights: 0 } }))).toBe('Cropped to 1920 × 1032. 1 zoom is outside it; it comes back if you widen the crop.')
    expect(cropNotice(outcome({ outside: { zooms: 1, shapes: 2, spotlights: 1 } }))).toBe(
      'Cropped to 1920 × 1032. 1 zoom, 2 shapes and 1 spotlight are outside it; they come back if you widen the crop.'
    )
  })

  it('says when the whole recording shows again', () => {
    expect(cropNotice(outcome({ project: project(), restoredAutoZooms: 1 }))).toBe('Showing the whole recording. 1 automatic zoom came back.')
  })
})

describe('zoom edits in the crop view', () => {
  // The left half of the frame: the view is half as wide as the frame, as tall.
  const crop = cropOf({ ...HD, crop: { x: 0, y: 0, w: 0.5, h: 1 } })!
  const region: ZoomSegment = { id: 'r', start: 0, end: 2, scale: 2.5, focus: { mode: 'region', x: 0.1, y: 0.25, w: 0.4, h: 0.3 }, auto: false }

  it('sets a region zoom to the level asked for, as the crop shows it', () => {
    expect(zoomTargetScale(zoomInView(crop, region))).toBeCloseTo(1.25, 9)
    for (const level of [1.5, 2, 3, 5]) {
      const z = setZoomLevelInView(crop, region, level)
      expect(zoomTargetScale(zoomInView(crop, z)), String(level)).toBeCloseTo(level, 9)
      expect(z.focus.mode).toBe('region')
    }
    const fixed: ZoomSegment = { id: 'f', start: 0, end: 2, scale: 2, focus: { mode: 'fixed', x: 0.2, y: 0.5 }, auto: true }
    expect(setZoomLevelInView(crop, fixed, 3)).toEqual({ ...fixed, scale: 3, auto: false })
    expect(setZoomLevelInView(null, region, 2)).toEqual(setZoomLevel(region, 2))
  })

  it('stores a region drawn in the view inside the crop, up to the view maximum', () => {
    const z = setZoomRegionInView(crop, region, { x: 0.4, y: 0.4, w: 0.1, h: 0.05 })
    // Grown in the view (not in the full frame) to what the view's maximum level frames.
    expect(z.focus).toEqual({ mode: 'region', x: expect.closeTo(0.175, 9), y: expect.closeTo(0.375, 9), w: expect.closeTo(0.1, 9), h: expect.closeTo(0.1, 9) })
    expect(zoomTargetScale(zoomInView(crop, z))).toBeCloseTo(5, 9)
    expect(z.auto).toBe(false)
    // Without a crop: exactly what setZoomRegion stores.
    expect(setZoomRegionInView(null, region, { x: 0.4, y: 0.4, w: 0.1, h: 0.05 }).focus).toEqual({ mode: 'region', x: expect.closeTo(0.35, 12), y: expect.closeTo(0.375, 12), w: 0.2, h: 0.1 })
  })
})
