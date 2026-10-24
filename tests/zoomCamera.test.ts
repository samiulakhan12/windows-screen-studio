import { describe, expect, it } from 'vitest'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { BOUNCY_OVERSHOOT, cubicBezier, ease } from '../src/shared/engine/easing'
import { easeInOutCubic } from '../src/shared/engine/math'
import {
  blendCameras,
  cameraAt,
  cameraFor,
  connectGap,
  regionScale,
  zoomsConnected,
  zoomTimings,
  ZOOM_TRANSITION,
  type Camera,
  type ZoomStyle
} from '../src/shared/engine/zoom'
import type { ZoomEasing, ZoomFocus, ZoomSegment } from '../src/shared/types'

const EASINGS: ZoomEasing[] = ['smooth', 'snappy', 'bouncy', 'linear']

const seg = (id: string, start: number, end: number, extra: Partial<ZoomSegment> = {}): ZoomSegment => ({
  id,
  start,
  end,
  scale: 2,
  focus: { mode: 'fixed', x: 0.5, y: 0.5 },
  auto: false,
  ...extra
})
const fixed = (x: number, y: number): ZoomFocus => ({ mode: 'fixed', x, y })

/** Source rectangle the camera shows (normalised). */
const view = (c: Camera) => ({ x0: c.cx - 0.5 / c.scale, x1: c.cx + 0.5 / c.scale, y0: c.cy - 0.5 / c.scale, y1: c.cy + 0.5 / c.scale })
/** Where normalised source point (x, y) lands in the output card (0..1 of the layout rect). */
const toOut = (c: Camera, x: number, y: number) => ({ x: (x - (c.cx - 0.5 / c.scale)) * c.scale, y: (y - (c.cy - 0.5 / c.scale)) * c.scale })

function sample(zooms: ZoomSegment[], t0: number, t1: number, dt = 0.002, style?: ZoomStyle, focus: SmoothedTrack | null = null): { t: number; cam: Camera }[] {
  const out: { t: number; cam: Camera }[] = []
  for (let t = t0; t <= t1 + 1e-9; t += dt) out.push({ t, cam: cameraAt(zooms, t, focus, style) })
  return out
}

/** Largest jump between consecutive samples (scale and centre). */
function maxJump(s: { cam: Camera }[]): number {
  let m = 0
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1].cam
    const b = s[i].cam
    m = Math.max(m, Math.abs(a.scale - b.scale), Math.abs(a.cx - b.cx), Math.abs(a.cy - b.cy))
  }
  return m
}

/** Zoomed in (scale >= 1), the camera never shows outside the recording. */
const insideRecording = (c: Camera): boolean => {
  if (c.scale < 1 - 1e-9) return false
  const v = view(c)
  return v.x0 >= -1e-9 && v.x1 <= 1 + 1e-9 && v.y0 >= -1e-9 && v.y1 <= 1 + 1e-9
}

describe('easing curves', () => {
  it('start at 0, end at 1 and never dip below 0', () => {
    for (const e of EASINGS) {
      expect(ease(e, 0)).toBe(0)
      expect(ease(e, 1)).toBe(1)
      expect(ease(e, -1)).toBe(0)
      expect(ease(e, 2)).toBe(1)
      for (let x = 0; x <= 1; x += 0.001) {
        expect(ease(e, x)).toBeGreaterThanOrEqual(0)
        expect(ease(e, x)).toBeLessThanOrEqual(1 + BOUNCY_OVERSHOOT)
      }
    }
  })

  it('smooth, snappy and linear are monotonic and never pass 1', () => {
    for (const e of ['smooth', 'snappy', 'linear'] as ZoomEasing[]) {
      let prev = 0
      for (let x = 0; x <= 1; x += 0.001) {
        const v = ease(e, x)
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
        expect(v).toBeLessThanOrEqual(1)
        prev = v
      }
    }
  })

  it('bouncy overshoots slightly and settles; without overshoot it is monotonic', () => {
    let peak = 0
    let prev = 0
    for (let x = 0; x <= 1; x += 0.001) {
      peak = Math.max(peak, ease('bouncy', x))
      const v = ease('bouncy', x, false)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
      expect(v).toBeLessThanOrEqual(1)
      prev = v
    }
    expect(peak).toBeGreaterThan(1.02)
    expect(peak).toBeLessThanOrEqual(1 + BOUNCY_OVERSHOOT)
    expect(ease('bouncy', 0.97)).toBeCloseTo(1, 1)
  })

  it('every curve but linear starts from rest, and snappy gets there sooner than smooth', () => {
    for (const e of ['smooth', 'snappy', 'bouncy'] as ZoomEasing[]) expect(ease(e, 0.01)).toBeLessThan(0.01)
    expect(ease('snappy', 0.3)).toBeGreaterThan(ease('smooth', 0.3) + 0.2)
    expect(ease('smooth', 0.3)).toBeCloseTo(easeInOutCubic(0.3))
    expect(ease(undefined, 0.3)).toBeCloseTo(easeInOutCubic(0.3))
  })

  it('cubicBezier matches the CSS ease curve', () => {
    const cssEase = cubicBezier(0.25, 0.1, 0.25, 1)
    expect(cssEase(0.5)).toBeCloseTo(0.8024, 3)
    expect(cubicBezier(0, 0, 1, 1)(0.37)).toBeCloseTo(0.37, 5)
  })
})

describe('camera with easing and transition per zoom', () => {
  const z = seg('a', 1, 5, { focus: fixed(0.5, 0.5) })

  it('the default style is the existing smooth 0.7 s zoom', () => {
    const half = cameraAt([z], 1 + ZOOM_TRANSITION / 2, null)
    expect(half.scale).toBeCloseTo(1.5)
    expect(cameraAt([z], 1 + ZOOM_TRANSITION / 4, null).scale).toBeCloseTo(1 + easeInOutCubic(0.25))
    expect(cameraAt([z], 1 + ZOOM_TRANSITION, null).scale).toBe(2)
    expect(cameraAt([z], 5 - ZOOM_TRANSITION / 4, null).scale).toBeCloseTo(1 + easeInOutCubic(0.25))
  })

  it('uses the zoom easing, else the project style', () => {
    const at = 1 + ZOOM_TRANSITION * 0.3
    const smooth = cameraAt([z], at, null).scale
    const snappy = cameraAt([z], at, null, { easing: 'snappy', transition: ZOOM_TRANSITION }).scale
    const linear = cameraAt([{ ...z, easing: 'linear' }], at, null, { easing: 'snappy', transition: ZOOM_TRANSITION }).scale
    expect(snappy).toBeGreaterThan(smooth + 0.2)
    expect(linear).toBeCloseTo(1.3)
  })

  it('uses the zoom transition, else the project style', () => {
    expect(cameraAt([{ ...z, transition: 0.3 }], 1.3, null).scale).toBe(2)
    expect(cameraAt([z], 1.3, null, { easing: 'smooth', transition: 1.5 }).scale).toBeLessThan(1.2)
    expect(cameraAt([z], 2.5, null, { easing: 'smooth', transition: 1.5 }).scale).toBe(2)
  })

  it('bouncy overshoots the level on the way in but never shows outside the recording', () => {
    const s = sample([{ ...z, easing: 'bouncy', focus: fixed(0.1, 0.9) }], 0, 6)
    expect(Math.max(...s.map((x) => x.cam.scale))).toBeGreaterThan(2.02)
    for (const { cam } of s) expect(insideRecording(cam)).toBe(true)
    // A small zoom returning to the full frame does not spring below it.
    const small = sample([{ ...z, scale: 1.1, easing: 'bouncy' }, seg('b', 6, 9, { scale: 3, easing: 'bouncy' })], 0, 10)
    for (const { cam } of small) expect(insideRecording(cam)).toBe(true)
  })

  it('is continuous for every easing', () => {
    for (const easing of EASINGS) expect(maxJump(sample([{ ...z, easing }], 0, 6, 0.001))).toBeLessThan(0.02)
  })
})

describe('connected zooms pan without zooming out', () => {
  const A = seg('a', 1, 4, { focus: fixed(0.3, 0.3) })
  const B = seg('b', 4, 7, { focus: fixed(0.7, 0.7) })

  it('touching zooms are connected; far apart ones are not', () => {
    expect(zoomsConnected(A, B)).toBe(true)
    expect(zoomsConnected(A, { ...B, start: 4.5 })).toBe(true)
    expect(zoomsConnected(A, { ...B, start: 4 + connectGap(A, B) + 0.01 })).toBe(false)
    const tm = zoomTimings([A, B])
    expect(tm.get('a')).toMatchObject({ toNext: true, tout: 0 })
    expect(tm.get('b')).toMatchObject({ fromPrev: true })
  })

  it('stays zoomed in from the first zoom to the second (no dip), panning in between', () => {
    for (const easing of EASINGS) {
      const s = sample([{ ...A, easing }, { ...B, easing }], 1 + ZOOM_TRANSITION, 7 - ZOOM_TRANSITION)
      expect(Math.min(...s.map((x) => x.cam.scale))).toBeGreaterThanOrEqual(2 - 1e-9)
      for (const { cam } of s) expect(insideRecording(cam)).toBe(true)
      expect(maxJump(s)).toBeLessThan(0.01)
    }
    const s = sample([A, B], 4, 4 + ZOOM_TRANSITION)
    expect(s[0].cam).toMatchObject({ scale: 2, cx: 0.3, cy: 0.3 })
    expect(s[s.length - 1].cam.cx).toBeCloseTo(0.7)
  })

  it('holds the first zoom across a short gap', () => {
    const s = sample([A, { ...B, start: 4.4 }], 3, 5)
    expect(Math.min(...s.map((x) => x.cam.scale))).toBeGreaterThanOrEqual(2 - 1e-9)
    expect(cameraAt([A, { ...B, start: 4.4 }], 4.2, null)).toMatchObject({ scale: 2, cx: 0.3 })
    expect(maxJump(s)).toBeLessThan(0.01)
  })

  it('zooms between different levels without passing below the lower one', () => {
    const s = sample([A, { ...B, scale: 3.5 }], 3, 6)
    expect(Math.min(...s.map((x) => x.cam.scale))).toBeGreaterThanOrEqual(2 - 1e-9)
    let prev = 0
    for (const { cam } of s) {
      expect(cam.scale).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = cam.scale
    }
  })

  it('separate zooms still return to the full frame in between', () => {
    const far = [A, { ...B, start: 6, end: 9 }]
    expect(cameraAt(far, 5, null)).toEqual({ scale: 1, cx: 0.5, cy: 0.5 })
  })

  it('follows the cursor through a chain of three cursor zooms without a dip', () => {
    const samples = []
    for (let t = 0; t <= 12; t += 1 / 30) samples.push({ t, x: 0.5 + 0.4 * Math.sin(t), y: 0.5 + 0.4 * Math.cos(t * 0.8) })
    const track = new SmoothedTrack(samples, 12, 1)
    const chain = [seg('a', 1, 3, { focus: { mode: 'cursor' } }), seg('b', 3, 4.2, { focus: { mode: 'cursor' }, scale: 2.6 }), seg('c', 4.2, 8, { focus: fixed(0.2, 0.8) })]
    const s = sample(chain, 1 + ZOOM_TRANSITION, 8 - ZOOM_TRANSITION, 0.002, undefined, track)
    expect(Math.min(...s.map((x) => x.cam.scale))).toBeGreaterThanOrEqual(2 - 1e-9)
    expect(maxJump(s)).toBeLessThan(0.01)
  })

  it('is continuous and never shows outside the recording for random zoom layouts', () => {
    let seed = 7
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    for (let round = 0; round < 30; round++) {
      const zooms: ZoomSegment[] = []
      let t = rnd()
      for (let i = 0; i < 4; i++) {
        const len = 0.4 + rnd() * 3
        const focus: ZoomFocus = rnd() < 0.5 ? fixed(rnd(), rnd()) : { mode: 'region', x: rnd() * 0.6, y: rnd() * 0.6, w: 0.2 + rnd() * 0.2, h: 0.2 + rnd() * 0.2 }
        zooms.push(seg(`z${i}`, t, t + len, { scale: 1.05 + rnd() * 3.5, focus, easing: EASINGS[Math.floor(rnd() * 4)], transition: 0.3 + rnd() * 1.2 }))
        t += len + (rnd() < 0.5 ? 0 : rnd() * 1.5)
      }
      // Fine steps: a continuous camera moves less than ~0.01 per 0.2 ms; any jump would show.
      const s = sample(zooms, 0, t + 0.5, 0.0002)
      expect(maxJump(s), JSON.stringify(zooms)).toBeLessThan(0.01)
      expect(s.every(({ cam }) => insideRecording(cam)), JSON.stringify(zooms)).toBe(true)
    }
  })
})

describe('region zoom', () => {
  it('frames exactly a rectangle with the recording shape', () => {
    const r = { mode: 'region' as const, x: 0.1, y: 0.2, w: 0.3, h: 0.3 }
    expect(regionScale(r)).toBeCloseTo(1 / 0.3)
    const cam = cameraAt([seg('r', 0, 4, { focus: r, scale: 99 })], 2, null)
    expect(cam.scale).toBeCloseTo(1 / 0.3)
    expect(cam.cx).toBeCloseTo(0.25)
    expect(cam.cy).toBeCloseTo(0.35)
    const v = view(cam)
    expect([v.x0, v.x1, v.y0, v.y1].map((n) => +n.toFixed(6))).toEqual([0.1, 0.4, 0.2, 0.5])
  })

  it('fits a wide rectangle by its width and keeps all of it in view', () => {
    const r = { mode: 'region' as const, x: 0.1, y: 0.1, w: 0.4, h: 0.2 }
    const cam = cameraAt([seg('r', 0, 4, { focus: r })], 2, null)
    expect(cam.scale).toBeCloseTo(2.5)
    const v = view(cam)
    expect(v.x0).toBeCloseTo(0.1)
    expect(v.x1).toBeCloseTo(0.5)
    expect(v.y0).toBeLessThanOrEqual(0.1 + 1e-9)
    expect(v.y1).toBeGreaterThanOrEqual(0.3 - 1e-9)
  })

  it('is clamped like other zooms near the edge, still showing the whole rectangle', () => {
    const r = { mode: 'region' as const, x: 0.7, y: 0.8, w: 0.3, h: 0.2 }
    const cam = cameraAt([seg('r', 0, 4, { focus: r })], 2, null)
    expect(insideRecording(cam)).toBe(true)
    const v = view(cam)
    expect(v.x0).toBeLessThanOrEqual(0.7 + 1e-9)
    expect(v.y0).toBeLessThanOrEqual(0.8 + 1e-9)
    expect(v.x1).toBeCloseTo(1)
    expect(v.y1).toBeCloseTo(1)
  })

  it('caps tiny rectangles at the maximum zoom', () => {
    expect(regionScale({ w: 0.01, h: 0.01 })).toBe(5)
  })
})

describe('pull back (zoom out below 1x)', () => {
  it('shrinks the card around the centre when following the cursor', () => {
    const cam = cameraAt([seg('p', 0, 4, { scale: 0.6, focus: { mode: 'cursor' } })], 2, new SmoothedTrack([{ t: 0, x: 0.9, y: 0.1 }], 4, 1))
    expect(cam).toEqual({ scale: 0.6, cx: 0.5, cy: 0.5 })
    // The whole recording is in view, inside the card's frame.
    const tl = toOut(cam, 0, 0)
    const br = toOut(cam, 1, 1)
    expect(tl.x).toBeCloseTo(0.2)
    expect(br.x).toBeCloseTo(0.8)
    expect(tl.y).toBeCloseTo(0.2)
  })

  it('keeps a fixed point still while shrinking towards it, all the way in and out', () => {
    const z = seg('p', 1, 4, { scale: 0.5, focus: fixed(0.9, 0.2) })
    for (const easing of EASINGS) {
      for (const { cam } of sample([{ ...z, easing }], 0, 5, 0.01)) {
        const p = toOut(cam, 0.9, 0.2)
        expect(p.x).toBeCloseTo(0.9, 6)
        expect(p.y).toBeCloseTo(0.2, 6)
        if (cam.scale <= 1) {
          // The card never leaves the frame.
          expect(toOut(cam, 0, 0).x).toBeGreaterThanOrEqual(-1e-9)
          expect(toOut(cam, 1, 1).x).toBeLessThanOrEqual(1 + 1e-9)
        } else {
          // Bouncy springs slightly past the full frame on the way back: still all recording.
          expect(easing).toBe('bouncy')
          expect(insideRecording(cam)).toBe(true)
        }
      }
    }
    expect(cameraAt([z], 2.5, null).scale).toBe(0.5)
  })

  it('moves continuously between a pull-back and a zoom-in that are connected', () => {
    const zooms = [seg('p', 1, 3, { scale: 0.6 }), seg('z', 3, 6, { scale: 2.5, focus: fixed(0.2, 0.3) })]
    const s = sample(zooms, 0, 7, 0.0005)
    expect(maxJump(s)).toBeLessThan(0.01)
    expect(cameraAt(zooms, 2.5, null).scale).toBeCloseTo(0.6)
    expect(cameraAt(zooms, 4.5, null).scale).toBeCloseTo(2.5)
    // Straight from 0.6x to 2.5x: monotonic, never back to a resting full frame first.
    let prev = 0
    for (const { cam } of sample(zooms, 3, 3 + ZOOM_TRANSITION)) {
      expect(cam.scale).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = cam.scale
    }
  })

  it('cameraFor and blendCameras agree at the ends', () => {
    const a = cameraFor(0.5, 0.2, 0.7)
    const b = cameraFor(2, 0.6, 0.4)
    expect(blendCameras(a, b, 0)).toEqual(a)
    const end = blendCameras(a, b, 1)
    expect(end.scale).toBeCloseTo(b.scale)
    expect(end.cx).toBeCloseTo(b.cx)
    expect(end.cy).toBeCloseTo(b.cy)
  })
})
