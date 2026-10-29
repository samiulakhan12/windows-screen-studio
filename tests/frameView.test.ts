import { describe, expect, it } from 'vitest'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { drawnForFrame, followGain, frameCamera, frameView, narrowBoxZoom, viewMagnification, type ViewScene } from '../src/shared/engine/frameView'
import { sceneLayout } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import { followCentre, followPlanFor } from '../src/shared/engine/reframe'
import { DEFAULT_REFRAME } from '../src/shared/engine/reframeData'
import { cameraAt, clampCamera, focusPathFor, zoomStyleOf } from '../src/shared/engine/zoom'
import type { CursorSample, CursorTrack, Project, ReframeSettings, ZoomSegment } from '../src/shared/types'
import { sceneFixtures } from './verticalFixtures'

/*
 * What a frame shows (docs/design/vertical-video.md §8.1; tests 41-45): frameView is today's
 * sceneLayout and cameraAt for every project that does not follow, and the virtual rectangle with
 * the camera resting on the follow plan for one that does; the drawn project, click effects'
 * gain, the camera framing in a narrow box and the magnification line of the Export dialog.
 */

const FIXTURES = sceneFixtures()
const scene = (project: Project, cursor: CursorTrack): ViewScene => ({ project, cursor, focusPath: focusPathFor(cursor.samples, project.duration) })

function project(over: Partial<Project> = {}, reframe: Partial<ReframeSettings> = {}, padding = 0.07): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 12,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  return { ...p, clips: [{ id: 'c1', start: 0, end: 12, speed: 1 }], style: { ...p.style, aspectRatio: '9:16', padding }, reframe: { ...DEFAULT_REFRAME, ...reframe }, ...over }
}

const still = (x: number, y: number, end = 12): CursorTrack => ({
  samples: Array.from({ length: end * 60 + 1 }, (_, i): CursorSample => ({ t: i / 60, x, y })),
  clicks: [],
  valid: true
})

describe('not following: exactly as before (test 41)', () => {
  for (const f of FIXTURES) {
    it(`${f.name}: frameView is { sceneLayout, cameraAt } at every sampled time`, () => {
      const s = scene(f.drawn, f.cursor)
      expect(drawnForFrame(f.drawn, f.w, f.h, f.vw, f.vh)).toBe(f.drawn)
      const focus = f.cursor.valid ? s.focusPath : null
      const style = zoomStyleOf(f.drawn)
      for (const t of f.times) {
        const v = frameView(s, f.w, f.h, f.vw, f.vh, t)
        expect(v.project).toBe(f.drawn)
        expect(v.layout).toEqual(sceneLayout(f.drawn, f.w, f.h, f.vw, f.vh, t))
        expect(v.cam).toEqual(cameraAt(f.drawn.zooms, t, focus, style))
        // A motion-blur sub-frame's own time changes nothing either.
        expect(frameCamera(s, v.layout, t, t + 0.01)).toEqual(v.cam)
      }
    })
  }

  it("'fit' settings, and following in a frame that is not narrower, draw as before", () => {
    const wide = FIXTURES.find((f) => f.name === 'wide-corners')!
    const tall = FIXTURES.find((f) => f.name === 'tall-fitted')!
    for (const [f, reframe] of [
      [wide, { ...DEFAULT_REFRAME }],
      [tall, { ...DEFAULT_REFRAME, mode: 'fit' as const }]
    ] as const) {
      const p = { ...f.drawn, reframe }
      const s = scene(p, f.cursor)
      expect(drawnForFrame(p, f.w, f.h, f.vw, f.vh)).toBe(p)
      for (const t of f.times.slice(0, 100)) {
        const v = frameView(s, f.w, f.h, f.vw, f.vh, t)
        expect(v.layout).toEqual(sceneLayout(f.drawn, f.w, f.h, f.vw, f.vh, t))
        expect(v.cam).toEqual(cameraAt(f.drawn.zooms, t, f.cursor.valid ? s.focusPath : null, zoomStyleOf(f.drawn)))
      }
    }
  })
})

describe('following (tests 42, 43)', () => {
  it('no zooms: the camera rests on the clamped plan at scale 1 (test 42)', () => {
    const p = project()
    const cursor: CursorTrack = { samples: Array.from({ length: 721 }, (_, i) => ({ t: i / 60, x: i < 300 ? 0.05 : 0.6, y: 0.5 })), clicks: [], valid: true }
    const s = scene(p, cursor)
    const plan = followPlanFor(p, cursor)
    for (const t of [0, 2, 5.3, 6, 9.9]) {
      const v = frameView(s, 1080, 1920, 1920, 1080, t)
      const c = followCentre(plan, t)
      expect(v.cam).toEqual(clampCamera({ scale: 1, cx: c.x, cy: c.y }, v.layout.follow!.base))
      expect(v.cam.scale).toBe(1)
    }
    expect(frameView(s, 1080, 1920, 1920, 1080, 2).cam.cx).toBeCloseTo(0.2954 / 2, 4)
    expect(frameView(s, 1080, 1920, 1920, 1080, 11).cam.cx).toBeCloseTo(0.6, 6)
  })

  it('drawnForFrame drops the device frame and the tilt, frames the zooms, keeps the stored project unchanged', () => {
    const zooms: ZoomSegment[] = [{ id: 'z', start: 2, end: 6, scale: 2, focus: { mode: 'cursor' }, auto: false }]
    const stored = project({ zooms, tilt: { enabled: true, rotateX: 8, rotateY: -12, perspective: 0.5, animate: 'none' }, style: { ...project().style, frame: { kind: 'browser', theme: 'dark' } } })
    const before = structuredClone(stored)
    const d = drawnForFrame(stored, 1080, 1920, 1920, 1080)
    expect(d).not.toBe(stored)
    expect(d).not.toHaveProperty('tilt')
    expect(d.style).not.toHaveProperty('frame')
    expect(d.zooms[0].scale).toBe(1.5)
    expect(d.reframe).toBe(stored.reframe)
    expect(stored).toEqual(before)
    // Memoised, and never framed twice.
    expect(drawnForFrame(stored, 1080, 1920, 1920, 1080)).toBe(d)
    expect(drawnForFrame(d, 1080, 1920, 1920, 1080)).toBe(d)
    // The frame that does not follow draws the stored project.
    expect(drawnForFrame(stored, 1920, 1080, 1920, 1080)).toBe(stored)
    // A camera asked with the drawn project is the one of the stored project.
    const t = still(0.5, 0.5)
    const layout = sceneLayout(d, 1080, 1920, 1920, 1080, 4)
    expect(frameCamera(scene(d, t), layout, 4)).toEqual(frameCamera(scene(stored, t), layout, 4))
  })

  it('a zoom ramp from the follow rest is a pure change of scale when it aims where the view is (test 43)', () => {
    const zooms: ZoomSegment[] = [
      { id: 'a', start: 3, end: 6, scale: 2, focus: { mode: 'cursor' }, auto: false },
      { id: 'b', start: 8, end: 11, scale: 1.8, focus: { mode: 'fixed', x: 0.4, y: 0.5 }, auto: false }
    ]
    const p = project({ zooms })
    const s = scene(p, still(0.4, 0.5))
    let scaled = false
    for (let t = 2.5; t < 11.5; t += 1 / 60) {
      const v = frameView(s, 1080, 1920, 1920, 1080, t)
      const view = v.layout.follow!.base.w / v.cam.scale
      expect(Math.abs(v.cam.cx - 0.4)).toBeLessThan(0.01 * view)
      if (v.cam.scale > 1.2) scaled = true
    }
    expect(scaled).toBe(true)
  })

  it('a sub-frame past the end of a clip samples that clip’s view (the frame’s own time picks the clip)', () => {
    const p = project({ clips: [{ id: 'a', start: 0, end: 5, speed: 1 }, { id: 'b', start: 8, end: 12, speed: 1 }] })
    const cursor: CursorTrack = { samples: Array.from({ length: 721 }, (_, i) => ({ t: i / 60, x: i < 390 ? 0.2 : 0.8, y: 0.5 })), clicks: [], valid: true }
    const s = scene(p, cursor)
    const layout = sceneLayout(p, 1080, 1920, 1920, 1080, 4.99)
    expect(frameCamera(s, layout, 5.02, 4.99).cx).toBeCloseTo(0.2, 6)
    expect(frameCamera(s, layout, 8.02).cx).toBeCloseTo(0.8, 6)
  })
})

describe('the camera framing, click effects and the magnification (tests 44, 45)', () => {
  it('narrowBoxZoom (test 44)', () => {
    expect(narrowBoxZoom(1.6, 0.5625)).toBe(1)
    expect(narrowBoxZoom(1.6, 1.75)).toBe(1.6)
    expect(narrowBoxZoom(1.2, 1)).toBe(1.2)
    expect(narrowBoxZoom(2, 0.8)).toBe(1.6)
    expect(narrowBoxZoom(1.4, Number.NaN)).toBe(1.4)
  })

  it('followGain is 1.904 at 1080x1920, padding 0.07, no band; 1 when not following (test 45)', () => {
    const p = project({}, { camera: 'bubble' })
    const layout = sceneLayout(p, 1080, 1920, 1920, 1080, 1)
    expect(followGain(layout, 1080, 1920, 1920, 1080, 0.07)).toBeCloseTo(1.904, 3)
    const fit = sceneLayout({ ...p, reframe: { ...DEFAULT_REFRAME, mode: 'fit' } }, 1080, 1920, 1920, 1080, 1)
    expect(followGain(fit, 1080, 1920, 1920, 1080, 0.07)).toBe(1)
    // The same at a preview size: it is a ratio of magnifications.
    expect(followGain(sceneLayout(p, 405, 720, 1920, 1080, 1), 405, 720, 1920, 1080, 0.07)).toBeCloseTo(1.904, 2)
  })

  it('viewMagnification: 1.64 at rest and 2.29 in a 1.8x auto zoom for a padded 1080p bubble; null when not following (test 45)', () => {
    const zooms: ZoomSegment[] = [{ id: 'z', start: 2, end: 6, scale: 1.8, focus: { mode: 'cursor' }, auto: true }]
    const m = viewMagnification(project({ zooms }, { camera: 'bubble' }), 1080, 1920, 1920, 1080)!
    expect(m.rest).toBeCloseTo(1.64, 2)
    expect(m.zoomed).toBeCloseTo(2.29, 2)
    expect(viewMagnification(project({}, { camera: 'bubble' }), 1080, 1920, 1920, 1080)).toEqual({ rest: m.rest, zoomed: m.rest })
    expect(viewMagnification(project({ zooms }), 1920, 1080, 1920, 1080)).toBeNull()
    expect(viewMagnification(project({ zooms }, { mode: 'fit' }), 1080, 1920, 1920, 1080)).toBeNull()
  })
})

describe('the drawn cursor path (sanity)', () => {
  it('frameCamera uses the focus path only when not following, and only with cursor data', () => {
    const p = { ...project(), reframe: undefined }
    const zooms: ZoomSegment[] = [{ id: 'z', start: 2, end: 6, scale: 2, focus: { mode: 'cursor' }, auto: false }]
    const q = { ...p, style: { ...p.style, aspectRatio: '16:9' as const }, zooms }
    const cursor = still(0.8, 0.3)
    const path = new SmoothedTrack(cursor.samples, 12, 1)
    const layout = sceneLayout(q, 1920, 1080, 1920, 1080, 4)
    expect(frameCamera({ project: q, cursor, focusPath: path }, layout, 4)).toEqual(cameraAt(zooms, 4, path))
    expect(frameCamera({ project: q, cursor: { ...cursor, valid: false }, focusPath: path }, layout, 4)).toEqual(cameraAt(zooms, 4, null))
  })
})
