import { describe, expect, it } from 'vitest'
import {
  anchorWeight,
  blendCameras,
  cameraAt,
  cameraFor,
  clampCamera,
  DEFAULT_ZOOM_SETTINGS,
  DEFAULT_ZOOM_STYLE,
  typingSessionsOf,
  zoomTargetScale,
  type Camera,
  type PathLike,
  type ViewBase
} from '../src/shared/engine/zoom'
import type { CursorTrack, ZoomSegment } from '../src/shared/types'
import { rng, seededTimes, seededTrack, seededZooms } from './verticalFixtures'
import { SmoothedTrack } from '../src/shared/engine/cursor'

/*
 * The zoom camera in a view that follows the action (docs/design/vertical-video.md §5.12; tests
 * 13-17): the optional `base` of cameraAt, clampCamera, cameraFor and blendCameras, the floor of
 * zoomTargetScale, and typingSessionsOf. Without them every value is today's: pinned bit for bit
 * in tests/verticalEquivalence.test.ts (test 13), and checked against explicit undefined here.
 */

const BASE: ViewBase = { cx: 0.5, cy: 0.5, w: 0.452, h: 1 }
const z = (start: number, end: number, scale: number, focus: ZoomSegment['focus'] = { mode: 'cursor' }, extra: Partial<ZoomSegment> = {}): ZoomSegment => ({
  id: `z${start}`,
  start,
  end,
  scale,
  focus,
  auto: false,
  ...extra
})
/** A path that is always at `p` (the plan stub). */
const still = (x: number, y: number): PathLike => ({ at: () => ({ x, y }) })

describe('no base: exactly as before (test 13)', () => {
  const r = rng(77)
  const cam = (): Camera => ({ scale: r() < 0.2 ? 0.5 + r() * 0.5 : 1 + r() * 4, cx: -0.3 + r() * 1.6, cy: -0.3 + r() * 1.6 })

  it('an explicit undefined base and floor give the same numbers as none', () => {
    for (let i = 0; i < 2000; i++) {
      const a = cam()
      const b = cam()
      const w = -0.2 + r() * 1.4
      expect(clampCamera(a, undefined)).toEqual(clampCamera(a))
      expect(cameraFor(a.scale, a.cx, a.cy, undefined)).toEqual(cameraFor(a.scale, a.cx, a.cy))
      expect(blendCameras(a, b, w, undefined)).toEqual(blendCameras(a, b, w))
    }
    const lr = rng(5)
    const zooms = seededZooms(lr, 40, 10)
    const focus = new SmoothedTrack(seededTrack(lr, 40).samples, 40, 1)
    for (const t of seededTimes(9, 300, 40)) expect(cameraAt(zooms, t, focus, DEFAULT_ZOOM_STYLE, undefined)).toEqual(cameraAt(zooms, t, focus, DEFAULT_ZOOM_STYLE))
    for (const zz of zooms) expect(zoomTargetScale(zz, undefined)).toBe(zoomTargetScale(zz))
  })

  it('the camera plan is kept per floor: a list used with and without a base gives each its own levels', () => {
    const zooms = [z(1, 5, 0.5), z(8, 12, 0.3, { mode: 'fixed', x: 0.2, y: 0.5 })]
    const before = cameraAt(zooms, 3, null)
    const followed = cameraAt(zooms, 3, null, DEFAULT_ZOOM_STYLE, BASE)
    expect(before.scale).toBe(0.5)
    expect(followed.scale).toBe(0.5)
    expect(cameraAt(zooms, 10, null).scale).toBe(0.5)
    expect(cameraAt(zooms, 10, null, DEFAULT_ZOOM_STYLE, BASE).scale).toBe(0.452)
    expect(cameraAt(zooms, 10, null).scale).toBe(0.5)
  })
})

describe('a base and no zooms (test 14)', () => {
  it('rests on the view: clampCamera({ 1, cx, cy }, base)', () => {
    for (const [cx, cy] of [
      [0.5, 0.5],
      [0.3, 0.7],
      [0.02, 0.5],
      [0.99, 0.1]
    ]) {
      const base = { ...BASE, cx, cy }
      expect(cameraAt([], 2, null, DEFAULT_ZOOM_STYLE, base)).toEqual(clampCamera({ scale: 1, cx, cy }, base))
    }
    expect(cameraAt([], 2, null, DEFAULT_ZOOM_STYLE, { ...BASE, cx: 0.02 }).cx).toBe(0.452 / 2)
    // Before and after every zoom too.
    const zooms = [z(5, 9, 2)]
    expect(cameraAt(zooms, 1, null, DEFAULT_ZOOM_STYLE, { ...BASE, cx: 0.9 })).toEqual({ scale: 1, cx: 1 - 0.226, cy: 0.5 })
    expect(cameraAt(zooms, 12, null, DEFAULT_ZOOM_STYLE, { ...BASE, cx: 0.3 })).toEqual({ scale: 1, cx: 0.3, cy: 0.5 })
  })

  it('clampCamera with { w: 0.452, h: 1 }: [0.226, 0.774] at scale 1; [0.113, 0.887] x [0.25, 0.75] at 2', () => {
    const at = (scale: number, cx: number, cy: number): Camera => clampCamera({ scale, cx, cy }, BASE)
    expect(at(1, -1, -1)).toEqual({ scale: 1, cx: 0.226, cy: 0.5 })
    expect(at(1, 2, 2)).toEqual({ scale: 1, cx: 0.774, cy: 0.5 })
    expect(at(1, 0.4, 0.3)).toEqual({ scale: 1, cx: 0.4, cy: 0.5 })
    expect(at(2, -1, -1)).toEqual({ scale: 2, cx: 0.113, cy: 0.25 })
    expect(at(2, 2, 2)).toEqual({ scale: 2, cx: 0.887, cy: 0.75 })
    // A unit base is today's clamp, bit for bit.
    for (const c of [
      { scale: 0.7, cx: 0.1, cy: 0.9 },
      { scale: 3.3, cx: 0.95, cy: 0.01 },
      { scale: 0.01, cx: 2, cy: -3 }
    ])
      expect(clampCamera(c, { w: 1, h: 1 })).toEqual(clampCamera(c))
  })

  it('cameraFor centres on the point at every scale, as far as the base allows', () => {
    expect(cameraFor(2, 0.5, 0.6, BASE)).toEqual({ scale: 2, cx: 0.5, cy: 0.6 })
    expect(cameraFor(0.6, 0.3, 0.5, BASE)).toEqual(clampCamera({ scale: 0.6, cx: 0.3, cy: 0.5 }, BASE))
    // Without a base a pull-back shrinks the card around the point instead.
    expect(cameraFor(0.6, 0.3, 0.5).cx).not.toBe(0.3)
  })
})

describe('aims with a base (tests 15, 16)', () => {
  it('a cursor zoom with an anchor aims at the anchor while anchorWeight is 1, at the plan after the release', () => {
    const zoom = z(2, 8, 2, { mode: 'cursor' }, { auto: true, anchor: { t: 3, x: 0.2, y: 0.4 } })
    const plan = still(0.7, 0.55)
    const base = { ...BASE, cx: 0.7, cy: 0.5 }
    expect(anchorWeight(zoom, 3)).toBe(1)
    const atClick = cameraAt([zoom], 3, plan, DEFAULT_ZOOM_STYLE, base)
    expect(atClick).toEqual({ scale: 2, cx: 0.2, cy: 0.4 })
    expect(anchorWeight(zoom, 4)).toBe(0)
    expect(cameraAt([zoom], 4, plan, DEFAULT_ZOOM_STYLE, base)).toEqual({ scale: 2, cx: 0.7, cy: 0.55 })
    // Fixed and region zooms aim as today.
    expect(cameraAt([z(2, 8, 2, { mode: 'fixed', x: 0.3, y: 0.6 })], 5, plan, DEFAULT_ZOOM_STYLE, base)).toEqual({ scale: 2, cx: 0.3, cy: 0.6 })
    const region = cameraAt([z(2, 8, 2, { mode: 'region', x: 0.1, y: 0.2, w: 0.2, h: 0.2 })], 5, plan, DEFAULT_ZOOM_STYLE, base)
    expect(region.cx).toBeCloseTo(0.2, 12)
    expect(region.cy).toBeCloseTo(0.3, 12)
  })

  it('a pull-back aims at the base centre, not 0.5', () => {
    const base = { cx: 0.62, cy: 0.5, w: 0.3164, h: 1 }
    const cam = cameraAt([z(2, 8, 0.75)], 5, still(0.1, 0.1), DEFAULT_ZOOM_STYLE, base)
    expect(cam.scale).toBe(0.75)
    expect(cam.cx).toBe(0.62)
    // Without cursor data a cursor zoom aims at the view's centre too.
    expect(cameraAt([z(2, 8, 1.5)], 5, null, DEFAULT_ZOOM_STYLE, base).cx).toBe(0.62)
    expect(cameraAt([z(2, 8, 1.5)], 5, null).cx).toBe(0.5)
  })

  it('zoomTargetScale keeps a level below 0.5 with a floor; without one it gives 0.5', () => {
    expect(zoomTargetScale({ scale: 0.3, focus: { mode: 'cursor' } }, 0.3)).toBe(0.3)
    expect(zoomTargetScale({ scale: 0.3, focus: { mode: 'cursor' } })).toBe(0.5)
    expect(zoomTargetScale({ scale: 0.2, focus: { mode: 'cursor' } }, 0.3)).toBe(0.3)
    expect(zoomTargetScale({ scale: 9, focus: { mode: 'cursor' } }, 0.3)).toBe(5)
    // Framed region zooms carry their level in `scale`.
    const region = { scale: 1.13, focus: { mode: 'region' as const, x: 0.2, y: 0.3, w: 0.4, h: 0.2 } }
    expect(zoomTargetScale(region, 0.3)).toBe(1.13)
    expect(zoomTargetScale(region)).toBe(2.5)
  })
})

describe('blendCameras with a base (test 17)', () => {
  const r = rng(17)

  it('a unit base gives today’s formula, bit for bit', () => {
    for (let i = 0; i < 5000; i++) {
      const a = { scale: 0.3 + r() * 3, cx: r(), cy: r() }
      const b = { scale: 0.3 + r() * 3, cx: r(), cy: r() }
      const w = -0.2 + r() * 1.4
      expect(blendCameras(a, b, w, { w: 1, h: 1 })).toEqual(blendCameras(a, b, w))
    }
  })

  it('with a base the source’s edges move linearly in view units while pulled back', () => {
    const base = { w: 0.3164, h: 1 }
    const a = { scale: 0.4, cx: 0.5, cy: 0.5 }
    const b = { scale: 1, cx: 0.8, cy: 0.5 }
    const edge = (c: Camera): number => 0.5 - (c.cx * c.scale) / base.w
    const steps = [0, 0.25, 0.5, 0.75, 1].map((w) => blendCameras(a, b, w, base))
    for (const [i, w] of [0, 0.25, 0.5, 0.75, 1].entries()) {
      expect(steps[i].scale).toBeCloseTo(0.4 + 0.6 * w, 12)
      expect(edge(steps[i])).toBeCloseTo(edge(a) + (edge(b) - edge(a)) * w, 9)
    }
    // Zoomed in on both sides: the centres move in a straight line, clamped with the base.
    const c = blendCameras({ scale: 2, cx: 0.2, cy: 0.5 }, { scale: 2, cx: 0.8, cy: 0.5 }, 0.5, base)
    expect(c).toEqual({ scale: 2, cx: 0.5, cy: 0.5 })
    expect(blendCameras({ scale: 1, cx: 0.1, cy: 0.5 }, { scale: 1, cx: 0.1, cy: 0.5 }, 0.5, base).cx).toBe(0.1582)
  })

  it('cameraAt moves in and out of a zoom relative to the view', () => {
    const base = { cx: 0.3, cy: 0.5, w: 0.3164, h: 1 }
    const zooms = [z(2, 8, 1.5, { mode: 'fixed', x: 0.3, y: 0.5 })]
    expect(cameraAt(zooms, 1.9, null, DEFAULT_ZOOM_STYLE, base)).toEqual({ scale: 1, cx: 0.3, cy: 0.5 })
    expect(cameraAt(zooms, 5, null, DEFAULT_ZOOM_STYLE, base)).toEqual({ scale: 1.5, cx: 0.3, cy: 0.5 })
    // Zooming in where the view rests is a pure change of scale.
    for (let t = 2; t <= 8; t += 0.05) expect(cameraAt(zooms, t, null, DEFAULT_ZOOM_STYLE, base).cx).toBeCloseTo(0.3, 12)
  })
})

describe('typingSessionsOf', () => {
  const track = (over: Partial<CursorTrack>): CursorTrack => ({ samples: [{ t: 0, x: 0.6, y: 0.7 }], clicks: [], valid: true, ...over })
  const auto = DEFAULT_ZOOM_SETTINGS.auto

  it('the sessions auto zoom finds: from the click into the field, at the field', () => {
    const t = track({ clicks: [{ t: 4, x: 0.3, y: 0.2, button: 'left' }], typing: [{ t: 5, end: 7 }] })
    expect(typingSessionsOf(t, auto)).toEqual([{ t0: 4, t1: 7, place: { x: 0.3, y: 0.2 } }])
  })

  it('bursts a pause of up to max(TYPING_PAUSE, clusterGap) apart are one session; short typing is none', () => {
    const t = track({ typing: [{ t: 1, end: 2 }, { t: 7.5, end: 9 }, { t: 30, end: 30.2 }] })
    expect(typingSessionsOf(t, auto)).toEqual([{ t0: 1, t1: 9, place: { x: 0.6, y: 0.7 } }])
    expect(typingSessionsOf(t, { ...auto, clusterGap: 3 })).toHaveLength(1)
    expect(typingSessionsOf(track({ typing: [{ t: 1, end: 2 }, { t: 9, end: 10 }] }), auto)).toHaveLength(2)
    expect(typingSessionsOf(track({ typing: [{ t: 1, end: 2 }, { t: 9, end: 10 }] }), { ...auto, clusterGap: 8 })).toHaveLength(1)
  })

  it('right clicks count only when auto zoom takes them; a session is not gated by auto zoom being on', () => {
    const t = track({ clicks: [{ t: 4, x: 0.3, y: 0.2, button: 'right' }], typing: [{ t: 5, end: 7 }] })
    expect(typingSessionsOf(t, auto)[0].place).toEqual({ x: 0.6, y: 0.7 })
    expect(typingSessionsOf(t, { ...auto, rightClicks: true })[0].place).toEqual({ x: 0.3, y: 0.2 })
    expect(typingSessionsOf(t, { ...auto, enabled: false, onTyping: false })).toHaveLength(1)
  })
})
