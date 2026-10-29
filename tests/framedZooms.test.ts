import { describe, expect, it } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { frameView, viewMagnification } from '../src/shared/engine/frameView'
import { followLimits, framedZooms, MAX_MAGNIFY, ZOOM_STRENGTH, type FollowLimits } from '../src/shared/engine/reframe'
import { DEFAULT_REFRAME } from '../src/shared/engine/reframeData'
import { focusPathFor } from '../src/shared/engine/zoom'
import type { CursorTrack, LayoutSegment, Project, ReframeSettings, ZoomSegment } from '../src/shared/types'

/*
 * Zooms in a followed frame (docs/design/vertical-video.md §5.12; tests 18, 19): the effective
 * level and the limits at the canonical frame, and the framed zooms (half strength, at most
 * MAX_MAGNIFY output px per recorded px, regions framed in the view, pull-backs to the whole
 * recording).
 */

function project(height: number, padding: number, camera: ReframeSettings['camera'], level = 1, webcam = true): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 10,
    width: (height * 16) / 9,
    height,
    hasWebcam: webcam,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  return { ...p, style: { ...p.style, aspectRatio: '9:16', padding }, reframe: { ...DEFAULT_REFRAME, camera, level } }
}

const z = (scale: number, focus: ZoomSegment['focus'] = { mode: 'cursor' }, extra: Partial<ZoomSegment> = {}): ZoomSegment => ({ id: `z${scale}`, start: 1, end: 4, scale, focus, auto: false, ...extra })

describe('followLimits (test 18)', () => {
  // [recording height, padding, camera, mag, cap, fit] of the §5.12 table.
  const ROWS: [number, number, ReframeSettings['camera'], number, number, number][] = [
    [1080, 0.07, 'bubble', 1.64, 1.83, 0.2954],
    [1080, 0.07, 'top', 1.08, 2.77, 0.4464],
    [1080, 0, 'bubble', 1.78, 1.69, 0.3164],
    [2160, 0.07, 'bubble', 0.82, 3.66, 0.2954],
    [720, 0.07, 'bubble', 2.46, 1.22, 0.2954]
  ]
  for (const [height, padding, camera, mag, cap, fit] of ROWS) {
    it(`${height}p, 9:16, padding ${padding}, ${camera}: mag ${mag}, cap ${cap}, fit ${fit}`, () => {
      const l = followLimits(project(height, padding, camera))!
      expect(Math.abs(l.mag - mag)).toBeLessThan(0.005)
      expect(Math.abs(l.cap - cap)).toBeLessThan(0.005)
      expect(Math.abs(l.fit - fit)).toBeLessThan(0.005)
      expect(l.level).toBe(1)
      expect(l.fit).toBe(Math.min(l.base.w, l.base.h))
    })
  }

  it('How close: level 2 on a 720p bubble is limited to 1.22; on 4K it is kept', () => {
    const limited = followLimits(project(720, 0.07, 'bubble', 2))!
    expect(limited.level).toBeCloseTo(1.221, 3)
    expect(limited.mag).toBeCloseTo(MAX_MAGNIFY, 9)
    expect(limited.cap).toBeCloseTo(1, 12)
    const kept = followLimits(project(2160, 0.07, 'bubble', 2))!
    expect(kept.level).toBe(2)
    expect(kept.base.w).toBeCloseTo(0.2954 / 2, 4)
  })

  it('a band project with a screen-only stretch is measured where the band collapses: never past MAX_MAGNIFY, as the Export dialog says', () => {
    const cursor: CursorTrack = { samples: Array.from({ length: 601 }, (_, i) => ({ t: i / 60, x: 0.5, y: 0.5 })), clicks: [], valid: true }
    const layouts: LayoutSegment[] = [{ id: 'l', start: 4, end: 8, layout: 'screen-only' }]
    for (const [height, level] of [[720, 2], [1080, 2], [1080, 1]]) {
      const width = (height * 16) / 9
      const p = { ...project(height, 0.07, 'top', level), layouts, zooms: [z(3, { mode: 'cursor' }, { start: 5, end: 7.5 })] }
      const scene = { project: p, cursor, focusPath: focusPathFor(cursor.samples, p.duration) }
      let peak = 0
      for (const t of [2, 4.5, 6, 6.5, 9]) {
        const v = frameView(scene, 1080, 1920, width, height, t)
        peak = Math.max(peak, (v.layout.screen.w * v.cam.scale) / width)
      }
      expect(peak, `${height}p, level ${level}`).toBeLessThanOrEqual(MAX_MAGNIFY + 1e-9)
      // The dialog's numbers are the stretch where the band collapses.
      const m = viewMagnification(p, 1080, 1920, width, height)!
      const rest = frameView(scene, 1080, 1920, width, height, 4.5)
      expect(m.rest).toBeCloseTo((rest.layout.screen.w * rest.cam.scale) / width, 6)
      expect(m.zoomed).toBeCloseTo(peak, 6)
    }
    // Without the stretch the band's own limits are kept (the §5.12 table).
    const plain = followLimits(project(1080, 0.07, 'top'))!
    expect(followLimits({ ...project(1080, 0.07, 'top'), layouts: [{ id: 'l', start: 4, end: 8, layout: 'camera-large' }] })).toEqual(plain)
    expect(plain.cap).toBeCloseTo(2.77, 2)
  })

  it('null when the project does not follow; cached per project', () => {
    expect(followLimits({ ...project(1080, 0.07, 'top'), reframe: { ...DEFAULT_REFRAME, mode: 'fit' } })).toBeNull()
    const wide = project(1080, 0.07, 'top')
    expect(followLimits({ ...wide, style: { ...wide.style, aspectRatio: '16:9' } })).toBeNull()
    const { reframe: _r, ...plain } = wide
    expect(followLimits(plain as Project)).toBeNull()
    expect(followLimits(wide)).toBe(followLimits(wide))
  })
})

describe('framedZooms (test 19)', () => {
  const bubble = followLimits(project(1080, 0.07, 'bubble'))!

  it('levels at half strength, capped: 2 → 1.5, 1.8 → 1.4, 3 → 1.83', () => {
    const out = framedZooms([z(2), z(1.8), z(3), z(1)], bubble)
    expect(out[0].scale).toBe(1.5)
    expect(out[1].scale).toBeCloseTo(1.4, 12)
    expect(out[2].scale).toBeCloseTo(1.83, 2)
    expect(out[2].scale).toBe(bubble.cap)
    expect(out[3].scale).toBe(1)
    expect(1 + (2 - 1) * ZOOM_STRENGTH).toBe(1.5)
  })

  it('pull-backs: 0.5 shows the whole recording, 0.75 → 0.648 in a padded 9:16 bubble', () => {
    const out = framedZooms([z(0.5), z(0.75), z(0.2), z(Number.NaN)], bubble)
    expect(out[0].scale).toBe(bubble.fit)
    expect(out[1].scale).toBeCloseTo(0.648, 3)
    // Below 0.5 reads as 0.5, as zoomTargetScale has it; an unreadable level as 2.
    expect(out[2].scale).toBe(bubble.fit)
    expect(out[3].scale).toBe(1.5)
  })

  it('regions are framed in the view: { 0.2, 0.3, 0.4, 0.2 } in a 0.452 x 1 view → 1.13; 0.5 wide in 0.3164 → 0.633', () => {
    const limits: FollowLimits = { base: { w: 0.452, h: 1 }, level: 1, mag: 1, fit: 0.452, cap: 3 }
    const region = z(2, { mode: 'region', x: 0.2, y: 0.3, w: 0.4, h: 0.2 })
    const [framed] = framedZooms([region], limits)
    expect(framed.scale).toBeCloseTo(1.13, 9)
    expect(framed.focus).toBe(region.focus)
    const narrow: FollowLimits = { base: { w: 0.3164, h: 1 }, level: 1, mag: 1.78, fit: 0.3164, cap: 1.69 }
    expect(framedZooms([z(2, { mode: 'region', x: 0.25, y: 0.4, w: 0.5, h: 0.2 })], narrow)[0].scale).toBeCloseTo(0.633, 3)
    // Never past the cap, never wider than the whole recording.
    expect(framedZooms([z(2, { mode: 'region', x: 0.45, y: 0.45, w: 0.01, h: 0.01 })], narrow)[0].scale).toBe(1.69)
    expect(framedZooms([z(2, { mode: 'region', x: 0, y: 0, w: 1, h: 1 })], narrow)[0].scale).toBe(0.3164)
  })

  it('the same output array for the same inputs; ids, times, easing and anchors kept; the input untouched', () => {
    const zooms = Object.freeze([
      Object.freeze(z(2, { mode: 'cursor' }, { auto: true, anchor: { t: 2, x: 0.3, y: 0.4 }, easing: 'snappy', transition: 0.5 })),
      Object.freeze(z(1.5, { mode: 'fixed', x: 0.6, y: 0.2 }))
    ]) as ZoomSegment[]
    const a = framedZooms(zooms, bubble)
    expect(framedZooms(zooms, bubble)).toBe(a)
    expect(framedZooms(zooms, { ...bubble })).toBe(a)
    expect(framedZooms(zooms, followLimits(project(1080, 0, 'bubble'))!)).not.toBe(a)
    expect(a[0]).toEqual({ ...zooms[0], scale: 1.5 })
    expect(a[1]).toEqual({ ...zooms[1], scale: 1.25 })
    expect(zooms[0].scale).toBe(2)
  })
})
