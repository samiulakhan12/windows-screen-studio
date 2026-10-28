import { describe, expect, it } from 'vitest'
import {
  bandSide,
  baseView,
  cameraBoxShown,
  followGeometry,
  followLevel,
  intersectRect,
  LAYOUT_TRANSITION,
  layoutMoving,
  sceneCameraBox,
  sceneContentRect,
  sceneLayout,
  virtualRect,
  webcamRect,
  type Rect,
  type SceneProject
} from '../src/shared/engine/layout'
import { toOutput } from '../src/shared/engine/outputPoint'
import { DEFAULT_REFRAME } from '../src/shared/engine/reframeData'
import type { AspectRatio, CameraLayout, LayoutSegment, ReframeSettings, StyleSettings } from '../src/shared/types'
import { sceneFixtures } from './verticalFixtures'

/*
 * The layout of a frame that follows the action (docs/design/vertical-video.md §5.2, §5.3; tests
 * 4-12): the camera band and the slot, the view's base and the virtual rectangle, and layout
 * changes while following. Old projects are pinned in tests/verticalEquivalence.test.ts.
 */

const STYLE: StyleSettings = { background: { type: 'color', color: '#000000' }, padding: 0.07, cornerRadius: 14, shadow: 0.6, aspectRatio: '9:16' }
const FOLLOW: ReframeSettings = { ...DEFAULT_REFRAME }

function project(over: Partial<SceneProject> = {}, reframe: Partial<ReframeSettings> = {}, style: Partial<StyleSettings> = {}): SceneProject {
  return {
    style: { ...STYLE, ...style },
    hasWebcam: true,
    webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    layouts: [],
    clips: [{ id: 'c', start: 0, end: 30, speed: 1 }],
    duration: 30,
    reframe: { ...FOLLOW, ...reframe },
    ...over
  }
}

const seg = (id: string, start: number, end: number, layout: CameraLayout): LayoutSegment => ({ id, start, end, layout })
const W = 1080
const H = 1920
const VW = 1920
const VH = 1080

const expectRect = (a: Rect, b: Rect, digits = 6): void => {
  expect(a.x).toBeCloseTo(b.x, digits)
  expect(a.y).toBeCloseTo(b.y, digits)
  expect(a.w).toBeCloseTo(b.w, digits)
  expect(a.h).toBeCloseTo(b.h, digits)
}
const centre = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
/** Output px per recorded px across and down a slot showing `base` of a vw x vh recording. */
const magnification = (slot: Rect, base: { w: number; h: number }, vw: number, vh: number): [number, number] => [slot.w / (base.w * vw), slot.h / (base.h * vh)]

describe('the camera band (tests 4-8)', () => {
  it('top band, 1080x1920, padding 0.07, band 0.32: the band and the slot below it, 32.4 px apart', () => {
    const g = followGeometry('default', project(), W, H, VW, VH)
    expectRect(g.camera.rect, { x: 75.6, y: 75.6, w: 928.8, h: 566.016 })
    expectRect(g.slot, { x: 75.6, y: 674.016, w: 928.8, h: 1170.384 })
    expect(g.slot.y - (g.camera.rect.y + g.camera.rect.h)).toBeCloseTo(32.4, 9)
    expect(g.camera.radius).toBeCloseTo(14, 9)
    expect(g.camera.opacity).toBe(1)
    expect(g.band).toEqual(g.camera.rect)
    // Rounded as the spec gives them.
    expect([g.camera.rect.h, g.slot.y, g.slot.h].map((v) => Math.round(v * 10) / 10)).toEqual([566, 674, 1170.4])
  })

  it('bottom band: mirrored', () => {
    const g = followGeometry('default', project({}, { camera: 'bottom' }), W, H, VW, VH)
    expectRect(g.camera.rect, { x: 75.6, y: H - 75.6 - 566.016, w: 928.8, h: 566.016 })
    expectRect(g.slot, { x: 75.6, y: 75.6, w: 928.8, h: 1170.384 })
    expect(g.camera.rect.y - (g.slot.y + g.slot.h)).toBeCloseTo(32.4, 9)
  })

  it('padding 0: no gap, the band touching the slot (test 5)', () => {
    const g = followGeometry('default', project({}, {}, { padding: 0 }), W, H, VW, VH)
    expectRect(g.camera.rect, { x: 0, y: 0, w: 1080, h: 614.4 })
    expectRect(g.slot, { x: 0, y: 614.4, w: 1080, h: 1305.6 })
  })

  it("'camera-large' takes a taller band, up to 0.65 of the area", () => {
    expect(followGeometry('camera-large', project(), W, H, VW, VH).camera.rect.h).toBeCloseTo(0.512 * 1768.8, 9)
    expect(followGeometry('camera-large', project({}, { band: 0.5 }), W, H, VW, VH).camera.rect.h).toBeCloseTo(0.65 * 1768.8, 9)
    expect(followGeometry('side-by-side', project(), W, H, VW, VH)).toEqual(followGeometry('default', project(), W, H, VW, VH))
  })

  it("'screen-only': the slot is the area; the band collapsed to height 0, transparent, not shown (test 6)", () => {
    const g = followGeometry('screen-only', project(), W, H, VW, VH)
    expectRect(g.slot, { x: 75.6, y: 75.6, w: 928.8, h: 1768.8 })
    expect(g.camera.rect.h).toBe(0)
    expect(g.camera.rect.y).toBeCloseTo(75.6, 9)
    expect(g.camera.opacity).toBe(0)
    expect(cameraBoxShown(g.camera)).toBe(false)
    expect(followGeometry('screen-only', project({}, { camera: 'bottom' }), W, H, VW, VH).camera.rect.y).toBeCloseTo(H - 75.6, 9)
    // Through sceneLayout, in the middle of a screen-only segment.
    const p = project({ layouts: [seg('l', 5, 15, 'screen-only')] })
    expect(sceneCameraBox(p, W, H, VW, VH, 10)!.rect.h).toBe(0)
    expect(sceneLayout(p, W, H, VW, VH, 10).follow!.slot).toEqual(g.slot)
  })

  it("'camera-only': the camera fills the area; the band slot, halved about its centre, keeps the same base (test 7)", () => {
    const band = followGeometry('default', project(), W, H, VW, VH)
    const g = followGeometry('camera-only', project(), W, H, VW, VH)
    expectRect(g.camera.rect, { x: 75.6, y: 75.6, w: 928.8, h: 1768.8 })
    expect(g.band).toBeNull()
    expectRect(g.slot, { x: band.slot.x + band.slot.w / 4, y: band.slot.y + band.slot.h / 4, w: band.slot.w / 2, h: band.slot.h / 2 })
    expect(centre(g.slot).x).toBeCloseTo(centre(band.slot).x, 9)
    expect(centre(g.slot).y).toBeCloseTo(centre(band.slot).y, 9)
    const a = baseView(band.slot, VW, VH, 1)
    const b = baseView(g.slot, VW, VH, 1)
    expect(b.w).toBeCloseTo(a.w, 12)
    expect(b.h).toBeCloseTo(a.h, 12)
  })

  it('the bubble, and any square frame even with a band chosen: the slot is the area, the camera the bubble (test 8)', () => {
    const area = { x: 75.6, y: 75.6, w: 928.8, h: 1768.8 }
    const bubble = followGeometry('default', project({}, { camera: 'bubble' }), W, H, VW, VH)
    expectRect(bubble.slot, area)
    expect(bubble.camera.rect).toEqual(webcamRect(W, H, { corner: 'bottom-right', size: 0.24 }))
    expect(bubble.camera.radius).toBeCloseTo(bubble.camera.rect.w / 2, 9)
    expect(bubble.band).toBeNull()
    const square = followGeometry('default', project({}, { camera: 'top' }, { aspectRatio: '1:1' }), 1080, 1080, VW, VH)
    expectRect(square.slot, { x: 75.6, y: 75.6, w: 928.8, h: 928.8 })
    expect(square.camera.rect).toEqual(webcamRect(1080, 1080, { corner: 'bottom-right', size: 0.24 }))
    expect(square.band).toBeNull()
    // A segment's corner moves the bubble.
    expect(followGeometry('default', project({}, { camera: 'bubble' }), W, H, VW, VH, 'top-left').camera.rect).toEqual(webcamRect(W, H, { corner: 'top-left', size: 0.24 }))
    // No camera shown: no band either.
    expectRect(followGeometry('default', project({ hasWebcam: false }), W, H, VW, VH).slot, area)
  })

  it('the bubble in a tall frame puts side by side in a band on its corner side; other frames keep the card beside the screen', () => {
    const p = project({}, { camera: 'bubble' })
    expect(followGeometry('side-by-side', p, W, H, VW, VH, 'top-left').band!.y).toBeCloseTo(75.6, 9)
    expect(followGeometry('side-by-side', p, W, H, VW, VH, 'bottom-left').band!.y).toBeCloseTo(H - 75.6 - 566.016, 9)
    const square = followGeometry('side-by-side', project({}, { camera: 'bubble' }, { aspectRatio: '1:1' }), 1080, 1080, VW, VH)
    expect(square.band).toBeNull()
    expect(square.slot.w / square.slot.h).toBeCloseTo(VW / VH, 9)
    // A 16:9 screen is stacked over the camera card of a bottom corner.
    expect(square.camera.rect.y).toBeGreaterThan(square.slot.y + square.slot.h)
  })

  it('bandSide: the band of a followed tall frame with a shown camera, else null', () => {
    expect(bandSide(project(), W, H, VW, VH)).toBe('top')
    expect(bandSide(project({}, { camera: 'bottom' }), W, H, VW, VH)).toBe('bottom')
    expect(bandSide(project({}, { camera: 'bubble' }), W, H, VW, VH)).toBeNull()
    expect(bandSide(project({}, { mode: 'fit' }), W, H, VW, VH)).toBeNull()
    expect(bandSide(project({}, {}, { aspectRatio: '1:1' }), 1080, 1080, VW, VH)).toBeNull()
    expect(bandSide(project({ hasWebcam: false }), W, H, VW, VH)).toBeNull()
    expect(bandSide(project({ webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' } }), W, H, VW, VH)).toBeNull()
    expect(bandSide(project(), W, H, 1080, 1920)).toBeNull()
  })
})

describe('the view: base and virtual rectangle (tests 9, 10)', () => {
  // [frame w, h, padding, camera, level, base.w, recorded px across, magnification] of §5.2.
  const ROWS: [number, number, number, ReframeSettings['camera'] | 'none', number, number, number, number][] = [
    [1080, 1920, 0, 'none', 1, 0.3164, 608, 1.78],
    [1080, 1920, 0.07, 'none', 1, 0.2954, 567, 1.64],
    [1080, 1920, 0, 'top', 1, 0.4653, 893, 1.21],
    [1080, 1920, 0.07, 'top', 1, 0.4464, 857, 1.08],
    [1080, 1080, 0, 'none', 1, 0.5625, 1080, 1.0],
    [1440, 1080, 0, 'none', 1, 0.75, 1440, 1.0],
    [1080, 1920, 0, 'top', 1.5, 0.3102, 596, 1.81]
  ]

  for (const [w, h, padding, camera, level, bw, across, mag] of ROWS) {
    it(`${w}x${h}, padding ${padding}, ${camera}, level ${level}: base.w ${bw}, ${across} px across at ${mag}x`, () => {
      const aspect: AspectRatio = w === h ? '1:1' : w > h ? '4:3' : '9:16'
      const p = project({ hasWebcam: camera !== 'none' }, { camera: camera === 'none' ? 'top' : camera, level }, { padding, aspectRatio: aspect })
      const layout = sceneLayout(p, w, h, VW, VH, 3)
      const { slot, base } = layout.follow!
      expect(base.w).toBeCloseTo(bw, 4)
      expect(Math.round(base.w * VW)).toBe(across)
      const [mx, my] = magnification(slot, base, VW, VH)
      expect(mx).toBeCloseTo(mag, 2)
      // No stretch (test 10): the same magnification on both axes.
      expect(Math.abs(mx - my) / mx).toBeLessThan(1e-9)
      expect(base).toEqual(baseView(slot, VW, VH, level))
      if (level !== 1) expect(base.h).toBeCloseTo(1 / level, 9)
    })
  }

  it('a 2560x1440 recording in a padding-free 9:16 frame shows 810 px across at 1.33x', () => {
    const p = project({ hasWebcam: false }, {}, { padding: 0 })
    const { slot, base } = sceneLayout(p, W, H, 2560, 1440, 1).follow!
    expect(Math.round(base.w * 2560)).toBe(810)
    expect(magnification(slot, base, 2560, 1440)[0]).toBeCloseTo(1.333, 3)
  })

  it('the camera centre lands on the slot centre and the slot shows cx ± base.w/2 (test 9)', () => {
    const p = project()
    const { screen, follow } = sceneLayout(p, W, H, VW, VH, 3)
    const { slot, base } = follow!
    expect(screen).toEqual(virtualRect(slot, base))
    for (const [cx, cy] of [
      [0.5, 0.5],
      [0.3, 0.42],
      [0.77, 0.6]
    ]) {
      const map = toOutput(screen, { scale: 1, cx, cy })
      const c = map(cx, cy)
      expect(c.x).toBeCloseTo(slot.x + slot.w / 2, 6)
      expect(c.y).toBeCloseTo(slot.y + slot.h / 2, 6)
      expect(map(cx - base.w / 2, cy - base.h / 2).x).toBeCloseTo(slot.x, 6)
      expect(map(cx + base.w / 2, cy + base.h / 2).x).toBeCloseTo(slot.x + slot.w, 6)
      expect(map(cx - base.w / 2, cy - base.h / 2).y).toBeCloseTo(slot.y, 6)
      expect(map(cx + base.w / 2, cy + base.h / 2).y).toBeCloseTo(slot.y + slot.h, 6)
    }
  })

  it('baseView, virtualRect and intersectRect', () => {
    expect(baseView({ x: 0, y: 0, w: 1080, h: 1920 }, 1920, 1080, 1)).toEqual({ w: 0.31640625, h: 1 })
    expect(baseView({ x: 0, y: 0, w: 1920, h: 1080 }, 1080, 1920, 1)).toEqual({ w: 1, h: 0.31640625 })
    expect(baseView({ x: 0, y: 0, w: 1080, h: 1920 }, 1920, 1080, 2)).toEqual({ w: 0.158203125, h: 0.5 })
    expect(baseView({ x: 0, y: 0, w: 0, h: 1920 }, 1920, 1080, 1)).toEqual({ w: 1, h: 1 })
    expect(virtualRect({ x: 100, y: 200, w: 300, h: 400 }, { w: 0.5, h: 1 })).toEqual({ x: -50, y: 200, w: 600, h: 400 })
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: -5, w: 10, h: 10 })).toEqual({ x: 5, y: 0, w: 5, h: 5 })
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toMatchObject({ w: 0, h: 0 })
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toMatchObject({ w: 0, h: 0 })
  })

  it('followLevel: How close, limited to 3 output px per recorded px at the canonical frame', () => {
    const bubble = (level: number, vh: number): number => followLevel(project({}, { camera: 'bubble', level }), (vh * 16) / 9, vh)
    expect(bubble(1.5, 1080)).toBe(1.5)
    expect(bubble(2, 1080)).toBeCloseTo(3 / 1.638, 3)
    expect(bubble(2, 720)).toBeCloseTo(1.221, 3)
    expect(bubble(2, 2160)).toBe(2)
    // The canonical frame, not the drawn one: a 405 x 720 preview gets the same view as the export.
    const p = project({}, { camera: 'bubble', level: 2 })
    const big = sceneLayout(p, 1080, 1920, VW, VH, 1).follow!
    const small = sceneLayout(p, 406, 720, VW, VH, 1).follow!
    expect(small.base.w).toBeCloseTo(big.base.w, 3)
  })
})

describe('layout changes while following (test 11)', () => {
  it('band to screen-only: the slot and the base change continuously, moving meanwhile', () => {
    const p = project({ layouts: [seg('l', 8, 20, 'screen-only')] })
    const start = 8
    let prev = sceneLayout(p, W, H, VW, VH, start - 0.01)
    expect(prev.moving).toBe(false)
    expect(prev.follow!.band!.h).toBeCloseTo(566.016, 6)
    for (let i = 0; i <= 400; i++) {
      const t = start + i / 1000
      const l = sceneLayout(p, W, H, VW, VH, t)
      const s = l.follow!.slot
      const q = prev.follow!.slot
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(s[k] - q[k])).toBeLessThan(0.01 * q.h)
      expect(Math.abs(l.follow!.base.w - prev.follow!.base.w)).toBeLessThan(0.01 * prev.follow!.base.w)
      if (i < 400) expect(l.moving).toBe(true)
      prev = l
    }
    const after = sceneLayout(p, W, H, VW, VH, start + LAYOUT_TRANSITION + 0.01)
    expect(after.moving).toBe(false)
    expectRect(after.follow!.slot, { x: 75.6, y: 75.6, w: 928.8, h: 1768.8 })
    expect(after.follow!.base.w).toBeCloseTo(0.2954, 4)
    // The band shrinks to its outer edge as the camera goes.
    const mid = sceneLayout(p, W, H, VW, VH, start + 0.2)
    expect(mid.follow!.band!.y).toBeCloseTo(75.6, 6)
    expect(mid.follow!.band!.h).toBeGreaterThan(0)
    expect(mid.follow!.band!.h).toBeLessThan(566.016)
  })

  it('a bubble changing corners never moves the slot, so the view stays', () => {
    const p = project({ layouts: [{ ...seg('l', 5, 15, 'default'), corner: 'top-left' }] }, { camera: 'bubble' })
    for (const t of [5.1, 5.2, 5.35, 14.8]) {
      const l = sceneLayout(p, W, H, VW, VH, t)
      expect(l.moving).toBe(false)
      expectRect(l.follow!.slot, { x: 75.6, y: 75.6, w: 928.8, h: 1768.8 })
    }
    expect(sceneLayout(p, W, H, VW, VH, 5.2).camera!.rect.x).toBeLessThan(sceneLayout(p, W, H, VW, VH, 4).camera!.rect.x)
  })

  it('camera-only keeps the base while the camera grows to fill the frame', () => {
    const p = project({ layouts: [seg('l', 5, 15, 'camera-only')] })
    const before = sceneLayout(p, W, H, VW, VH, 4).follow!.base
    for (const t of [5.1, 5.2, 5.3, 10]) {
      const base = sceneLayout(p, W, H, VW, VH, t).follow!.base
      expect(base.w).toBeCloseTo(before.w, 9)
      expect(base.h).toBeCloseTo(before.h, 9)
    }
    expect(sceneLayout(p, W, H, VW, VH, 5.2).moving).toBe(true)
    expect(sceneLayout(p, W, H, VW, VH, 10).follow!.band).toBeNull()
  })

  it('a hidden camera: no camera, the slot is the area', () => {
    const p = project({ webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' }, layouts: [seg('l', 5, 15, 'side-by-side')] })
    const l = sceneLayout(p, W, H, VW, VH, 10)
    expect(l.camera).toBeNull()
    expect(l.follow!.band).toBeNull()
    expectRect(l.follow!.slot, { x: 75.6, y: 75.6, w: 928.8, h: 1768.8 })
    expect(sceneContentRect(p, W, H, VW, VH, 10)).toEqual(l.screen)
  })
})

describe('frames that do not follow are laid out exactly as before (test 12)', () => {
  const FIXTURES = sceneFixtures()

  it("'fit' settings, and following in a frame that is not narrower, change nothing", () => {
    for (const f of FIXTURES) {
      const fit = { ...f.drawn, reframe: { ...DEFAULT_REFRAME, mode: 'fit' as const } }
      const wide = { ...f.drawn, reframe: { ...DEFAULT_REFRAME } }
      const follows = f.w * f.vh < 0.9 * f.vw * f.h
      for (const t of f.times.slice(0, 120)) {
        const today = sceneLayout(f.drawn, f.w, f.h, f.vw, f.vh, t)
        expect(sceneLayout(fit, f.w, f.h, f.vw, f.vh, t)).toEqual(today)
        if (!follows) expect(sceneLayout(wide, f.w, f.h, f.vw, f.vh, t)).toEqual(today)
        else expect(sceneLayout(wide, f.w, f.h, f.vw, f.vh, t).follow).toBeDefined()
      }
    }
    // Both kinds are among the fixtures.
    expect(FIXTURES.some((f) => f.w * f.vh < 0.9 * f.vw * f.h)).toBe(true)
    expect(FIXTURES.some((f) => !(f.w * f.vh < 0.9 * f.vw * f.h))).toBe(true)
  })

  it('moving equals layoutMoving for projects that do not follow', () => {
    for (const f of FIXTURES) for (const t of f.times) expect(sceneLayout(f.drawn, f.w, f.h, f.vw, f.vh, t).moving).toBe(layoutMoving(f.drawn, t))
  })
})
