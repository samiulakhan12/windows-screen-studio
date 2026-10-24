import { describe, expect, it } from 'vitest'
import { addLayoutAt, createLayoutSegment, dragLayoutTimes, layoutAt, layoutDragBounds, layoutSegmentAt, updateLayout } from '../src/shared/editor/layouts'
import { applyStyleDefaults, lookOf, sanitizeStyleDefaults } from '../src/shared/editor/styleDefaults'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { DEFAULT_WEBCAM_BORDER, MIN_LAYOUT_LENGTH, readLayouts, readWebcam, webcamLook } from '../src/shared/engine/webcamData'
import type { LayoutSegment } from '../src/shared/types'

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
    const added = addLayoutAt(list, 'side-by-side', 5, 20)!
    expect([added.segment.start, added.segment.end]).toEqual([5, 8])
    expect(added.layouts.map((s) => s.id)).toEqual(['a', added.segment.id, 'b'])
    expect(addLayoutAt(list, 'side-by-side', 3, 20)).toBeNull()
    // Right before the next one: it starts earlier so it is long enough.
    const tight = addLayoutAt(list, 'camera-large', 7.95, 20)!
    expect(tight.segment.end).toBe(8)
    expect(tight.segment.end - tight.segment.start).toBeCloseTo(MIN_LAYOUT_LENGTH)
    expect(addLayoutAt([seg('a', 0, 4), seg('b', 4.1, 6)], 'camera-large', 4.05, 20)).toBeNull()
    expect(addLayoutAt(undefined, 'camera-only', 1, 20)!.segment).toMatchObject({ start: 1, end: 6, layout: 'camera-only' })
    expect(addLayoutAt([], 'camera-only', 1, 0)).toBeNull()
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
