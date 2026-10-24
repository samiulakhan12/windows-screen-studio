import { describe, expect, it } from 'vitest'
import { addLayoutAt, createLayoutSegment, dragLayoutTimes, layoutAt, layoutDragBounds, layoutSegmentAt, updateLayout } from '../src/shared/editor/layouts'
import { applyStyleDefaults, lookOf, sanitizeStyleDefaults } from '../src/shared/editor/styleDefaults'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { cameraSourceRect, layoutGeometry, sceneContentRect, styleContentRect } from '../src/shared/engine/layout'
import { DEFAULT_WEBCAM_BORDER, framingAt, MIN_LAYOUT_LENGTH, openedWithoutCamera, readLayouts, readWebcam, webcamLook, withRecordedCamera } from '../src/shared/engine/webcamData'
import type { LayoutSegment, Project } from '../src/shared/types'

const seg = (id: string, start: number, end: number, layout: LayoutSegment['layout'] = 'camera-only'): LayoutSegment => ({ id, start, end, layout })

describe('camera settings', () => {
  it('reads an older project exactly as it was (no fields added)', () => {
    const old = { show: true, corner: 'top-left', size: 0.3, shape: 'rounded' }
    expect(readWebcam(old, true)).toEqual(old)
    const look = webcamLook(readWebcam(old, true))
    // The original look: mirrored, a translucent white ring, the same drop shadow, no crop or blur.
    expect(look).toEqual({ border: DEFAULT_WEBCAM_BORDER, mirror: true, shadow: 0.6, backgroundBlur: 0, zoom: 1, cropX: 0.5, cropY: 0.5 })
  })

  it('sanitises stored values', () => {
    const w = readWebcam(
      {
        show: 'yes',
        corner: 'middle',
        size: 7,
        shape: 'hexagon',
        border: { width: 99, color: '#ff0000' },
        mirror: 0,
        backgroundBlur: 3,
        zoom: 0.2,
        cropX: -1,
        cropY: NaN,
        shadow: -2
      },
      false
    )
    expect(w).toEqual({ show: false, corner: 'bottom-right', size: 1, shape: 'circle', border: { width: 16, color: '#ff0000' }, backgroundBlur: 1, zoom: 1, cropX: 0, shadow: 0 })
    expect(readWebcam(null, true)).toEqual({ show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' })
    expect(readWebcam({ border: { width: 4, color: 'url(x)' } }, true).border).toBeUndefined()
    expect(readWebcam({ border: { width: 4, color: 'rgba(255, 0, 0, 0.5)' } }, true).border).toEqual({ width: 4, color: 'rgba(255, 0, 0, 0.5)' })
    expect(readWebcam({ shape: 'square', mirror: false }, true)).toMatchObject({ shape: 'square', mirror: false })
  })

  it('migrates a project: the camera sanitised, layouts read safely', () => {
    const base = createProject({
      id: 'p',
      name: 'P',
      duration: 20,
      width: 1280,
      height: 720,
      hasWebcam: true,
      hasAudio: false,
      webcamOffset: 0,
      zooms: [],
      cursorValid: false,
      capture: { method: 'chromium', cursorInVideo: true, region: null }
    })
    const { layouts: _l, ...older } = base
    void _l
    const migrated = migrateProject({ ...older, webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' } })
    expect(migrated.webcam).toEqual({ show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' })
    expect(migrated.layouts).toEqual([])
    const withLayouts = migrateProject({ ...base, layouts: [seg('a', 2, 5), null, 4, seg('b', 30, 40), seg('a', 6, 8)] })
    expect(withLayouts.layouts).toEqual([seg('a', 2, 5)])
  })
})

describe('readLayouts', () => {
  it('drops malformed entries, clamps to the recording and trims overlaps', () => {
    const list = [
      seg('c', 8, 12, 'side-by-side'),
      { id: 'bad-layout', start: 1, end: 2, layout: 'picture-in-picture' },
      { id: '', start: 1, end: 2, layout: 'default' },
      { id: 'nan', start: NaN, end: 2, layout: 'default' },
      seg('a', -2, 4),
      seg('b', 3, 9, 'camera-large'),
      seg('a', 15, 16),
      seg('tiny', 10, 11),
      seg('late', 18, 30, 'screen-only'),
      'nope'
    ]
    expect(readLayouts(list, 20)).toEqual([seg('a', 0, 4), seg('b', 4, 9, 'camera-large'), seg('c', 9, 12, 'side-by-side'), seg('late', 18, 20, 'screen-only')])
    expect(readLayouts('nope', 20)).toEqual([])
  })
})

describe('layout editing', () => {
  it('finds the layout at a time', () => {
    const p = { layouts: [seg('a', 2, 4, 'side-by-side')] }
    expect(layoutAt(p, 3)).toBe('side-by-side')
    expect(layoutAt(p, 4)).toBe('default')
    expect(layoutSegmentAt(p.layouts, 2)?.id).toBe('a')
    expect(layoutSegmentAt(undefined, 2)).toBeNull()
  })

  it('creates segments inside the recording', () => {
    const s = createLayoutSegment('camera-only', 18, 20)
    expect([s.start, s.end]).toEqual([18, 20])
    expect(createLayoutSegment('camera-only', 25, 20).start).toBeCloseTo(19.9)
  })

  it('adds a segment into the free time, never over another one', () => {
    const list = [seg('a', 2, 4), seg('b', 8, 12)]
    const added = addLayoutAt({ layouts: list, duration: 20 }, 'side-by-side', 5)
    if (!added.ok) throw new Error(added.reason)
    expect([added.segment.start, added.segment.end]).toEqual([5, 8])
    expect(added.layouts.map((s) => s.id)).toEqual(['a', added.segment.id, 'b'])
    expect(addLayoutAt({ layouts: list, duration: 20 }, 'side-by-side', 3)).toEqual({ ok: false, reason: 'inside', id: 'a' })
    // Right before the next one: no room for a change that could play.
    expect(addLayoutAt({ layouts: list, duration: 20 }, 'camera-large', 7.95)).toEqual({ ok: false, reason: 'no-room', id: null })
    expect(addLayoutAt({ layouts: [seg('a', 0, 4), seg('b', 4.1, 6)], duration: 20 }, 'camera-large', 4.05)).toMatchObject({ ok: false, reason: 'no-room' })
    expect(addLayoutAt({ layouts: undefined, duration: 20 }, 'camera-only', 1)).toMatchObject({ ok: true, segment: { start: 1, end: 6, layout: 'camera-only' } })
    expect(addLayoutAt({ layouts: [], duration: 0 }, 'camera-only', 1)).toMatchObject({ ok: false })
  })

  it('moves and trims between the neighbours', () => {
    const list = [seg('a', 2, 4), seg('b', 6, 8), seg('c', 10, 12)]
    const bounds = layoutDragBounds(list, 'b', 20)
    expect(bounds).toEqual({ lower: 4, upper: 10 })
    expect(dragLayoutTimes({ start: 6, end: 8 }, 'move', -5, bounds)).toEqual({ start: 4, end: 6 })
    expect(dragLayoutTimes({ start: 6, end: 8 }, 'move', 5, bounds)).toEqual({ start: 8, end: 10 })
    expect(dragLayoutTimes({ start: 6, end: 8 }, 'start', 5, bounds)).toEqual({ start: 8 - MIN_LAYOUT_LENGTH, end: 8 })
    expect(dragLayoutTimes({ start: 6, end: 8 }, 'end', 5, bounds)).toEqual({ start: 6, end: 10 })
    expect(dragLayoutTimes({ start: 6, end: 8 }, 'start', -5, bounds)).toEqual({ start: 4, end: 8 })
    expect(layoutDragBounds(list, 'zzz', 20)).toEqual({ lower: 0, upper: 20 })
  })

  it('updates one segment and keeps the list in order', () => {
    const list = [seg('a', 2, 4), seg('b', 6, 8)]
    expect(updateLayout(list, 'b', { start: 0, end: 1, layout: 'screen-only' }).map((s) => s.id)).toEqual(['b', 'a'])
    expect(updateLayout(list, 'a', { layout: 'side-by-side' })[0].layout).toBe('side-by-side')
  })
})

describe('saved default look', () => {
  it('keeps the camera look but not the framing of one recording', () => {
    const p = createProject({
      id: 'p',
      name: 'P',
      duration: 5,
      width: 1280,
      height: 720,
      hasWebcam: true,
      hasAudio: false,
      webcamOffset: 0,
      zooms: [],
      cursorValid: false,
      capture: { method: 'chromium', cursorInVideo: true, region: null }
    })
    const look = { ...p, webcam: { ...p.webcam, shape: 'square' as const, border: { width: 6, color: '#22d3ee' }, mirror: false, shadow: 0.3, backgroundBlur: 0.5, zoom: 2, cropX: 0.2 } }
    const saved = sanitizeStyleDefaults(JSON.parse(JSON.stringify(lookOf(look))))!
    expect(saved.webcam).toEqual({ corner: 'bottom-right', size: 0.24, shape: 'square', border: { width: 6, color: '#22d3ee' }, mirror: false, shadow: 0.3, backgroundBlur: 0.5 })
    const next = applyStyleDefaults(p, saved)
    expect(next.webcam).toMatchObject({ shape: 'square', mirror: false, backgroundBlur: 0.5 })
    expect(next.webcam.zoom).toBeUndefined()
  })
})

const cameraProject = (): Project =>
  createProject({
    id: 'p',
    name: 'P',
    duration: 10,
    width: 1280,
    height: 720,
    hasWebcam: true,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })

describe('framing pad', () => {
  /** The visible share of a 16:9 camera picture in `layout` of a 1080p frame of a 1280x720 recording. */
  const visible = (layout: LayoutSegment['layout'], zoom = 1): { w: number; h: number } => {
    const p = cameraProject()
    const box = layoutGeometry(layout, p, 1920, 1080, 1280, 720).camera.rect
    const src = cameraSourceRect(1280, 720, box.w, box.h, { zoom, cropX: 0.5, cropY: 0.5 })
    return { w: src.w / 1280, h: src.h / 720 }
  }

  it('keeps the point pressed, also beyond what this layout can centre on', () => {
    const bubble = visible('default')
    expect(bubble.w).toBeCloseTo(0.5625, 3)
    expect(bubble.h).toBeCloseTo(1, 6)
    // Unmirrored: x as pressed; y untouched, since the bubble shows the picture's whole height.
    expect(framingAt(0.1, 0.8, { cropX: 0.5, cropY: 0.3, mirror: false }, bubble)).toEqual({ cropX: 0.1, cropY: 0.3 })
    // Mirrored: the picture shows flipped, so a press on its left is the camera's right.
    expect(framingAt(0.1, 0.8, { cropX: 0.5, cropY: 0.3, mirror: true }, bubble)).toEqual({ cropX: 0.9, cropY: 0.3 })
    // Zoomed in, both axes move; presses outside the pad stay on the picture.
    expect(framingAt(-0.2, 1.4, { cropX: 0.5, cropY: 0.5, mirror: false }, visible('default', 2))).toEqual({ cropX: 0, cropY: 1 })
  })

  it('leaves the framing of other layouts alone where this one shows the whole picture', () => {
    // A 16:9 camera filling the (wider) padded 16:9 frame shows its whole width: x stays, y moves.
    const card = visible('camera-only')
    expect(card.w).toBeCloseTo(1, 6)
    expect(card.h).toBeLessThan(0.999)
    expect(framingAt(0.8, 0.2, { cropX: 0.3, cropY: 0.6, mirror: false }, card)).toEqual({ cropX: 0.3, cropY: 0.2 })
    // Showing the whole picture, a press changes nothing.
    expect(framingAt(0.8, 0.2, { cropX: 0.3, cropY: 0.6, mirror: true }, { w: 1, h: 1 })).toEqual({ cropX: 0.3, cropY: 0.6 })
    // A layout showing part of the width moves it there.
    const side = visible('side-by-side')
    expect(side.w).toBeLessThan(0.5)
    expect(framingAt(0.25, 0.5, { cropX: 0.3, cropY: 0.6, mirror: false }, side)).toEqual({ cropX: 0.25, cropY: 0.6 })
  })
})

describe('a recording whose camera file is missing', () => {
  it('opens without its camera, so its layouts leave the screen where it is', () => {
    const p = { ...cameraProject(), layouts: [seg('a', 0, 10, 'side-by-side')] }
    const opened = openedWithoutCamera(p, true)
    expect(opened.hasWebcam).toBe(false)
    expect(opened.layouts).toEqual(p.layouts)
    const base = styleContentRect(1920, 1080, 1280, 720, p.style)
    expect(sceneContentRect(p, 1920, 1080, 1280, 720, 5)).not.toEqual(base)
    expect(sceneContentRect(opened, 1920, 1080, 1280, 720, 5)).toEqual(base)
    // With the file there, or without a camera at all, nothing changes.
    expect(openedWithoutCamera(p, false)).toBe(p)
    const none = { ...p, hasWebcam: false }
    expect(openedWithoutCamera(none, true)).toBe(none)
  })

  it('saves with its camera, so it is used again once the file is back', () => {
    const stored = cameraProject()
    const edited = { ...openedWithoutCamera(stored, true), name: 'Renamed' }
    const saved = withRecordedCamera(edited, stored)
    expect(saved.hasWebcam).toBe(true)
    expect(saved.name).toBe('Renamed')
    // Opened with its camera, or recorded without one: saved as edited.
    const plain = { ...stored, name: 'X' }
    expect(withRecordedCamera(plain, stored)).toBe(plain)
    const noCamera = { ...stored, hasWebcam: false }
    expect(withRecordedCamera(noCamera, noCamera)).toBe(noCamera)
  })
})
