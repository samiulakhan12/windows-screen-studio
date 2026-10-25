import { describe, expect, it } from 'vitest'
import { LAYOUT_TRANSITION, sceneCameraBox, sceneContentRect, type Rect } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import {
  CURSOR_LEAN,
  cursorLean,
  DEFAULT_TILT,
  frameArea,
  leanFit,
  leansToCursor,
  poseIsFlat,
  projectPoint,
  projectRect,
  quadBounds,
  readTilt,
  sameAngles,
  tiltCss,
  tiltOf,
  tiltPoseAt,
  tiltSettingsOf,
  tiltArea,
  tiltView,
  tiltViewAt,
  TILT_PRESETS,
  ZOOM_FLAT_SCALE,
  zoomFlatten,
  type TiltAngles,
  type TiltPoint
} from '../src/shared/engine/tilt'
import { aimAt, autoZoomsForTrack, cameraAt, DEFAULT_ZOOM_SETTINGS, focusPathFor, ZOOM_TRANSITION, type Camera } from '../src/shared/engine/zoom'
import type { CameraLayout, CursorSample, CursorTrack, Project, TiltSettings, ZoomSegment } from '../src/shared/types'

const W = 1920
const H = 1080
/** A 16:9 card centred in a 1080p frame, with some padding around it. */
const BODY: Rect = { x: (W - 1500) / 2, y: (H - 843.75) / 2, w: 1500, h: 843.75 }

const REST: Camera = { scale: 1, cx: 0.5, cy: 0.5 }
const pose = (rotateX: number, rotateY: number, perspective = 0.5): TiltAngles => ({ rotateX, rotateY, perspective })
const settings = (patch: Partial<TiltSettings> = {}): TiltSettings => ({ ...DEFAULT_TILT, enabled: true, ...patch })
const len = (a: TiltPoint, b: TiltPoint): number => Math.hypot(a.x - b.x, a.y - b.y)
const inside = (p: TiltPoint, w: number, h: number, eps = 1e-6): boolean => p.x >= -eps && p.x <= w + eps && p.y >= -eps && p.y <= h + eps

describe('readTilt', () => {
  it('drops anything that is not a tilt', () => {
    for (const v of [undefined, null, 3, 'tilt', [1, 2], true]) expect(readTilt(v)).toBeUndefined()
  })

  it('keeps a valid tilt as it is', () => {
    const t: TiltSettings = { enabled: true, rotateX: 12, rotateY: -8, perspective: 0.4, animate: 'zoom' }
    expect(readTilt(t)).toEqual(t)
  })

  it('clamps angles and perspective and fills in broken fields', () => {
    expect(readTilt({ enabled: true, rotateX: 90, rotateY: -400, perspective: 7, animate: 'spin' })).toEqual({ enabled: true, rotateX: 30, rotateY: -30, perspective: 1, animate: 'none' })
    expect(readTilt({ rotateX: 'x', rotateY: NaN, perspective: -1 })).toEqual({ ...DEFAULT_TILT, perspective: 0, enabled: false })
    // Only exactly true switches it on.
    expect(readTilt({ enabled: 'yes' })?.enabled).toBe(false)
    expect(readTilt({ enabled: 1 })?.enabled).toBe(false)
  })
})

describe('tiltOf / tiltSettingsOf', () => {
  it('is null unless the tilt is on', () => {
    expect(tiltOf({})).toBeNull()
    expect(tiltOf({ tilt: { ...DEFAULT_TILT, enabled: false } })).toBeNull()
    expect(tiltOf({ tilt: settings({ rotateX: 5 }) })).toMatchObject({ enabled: true, rotateX: 5 })
  })

  it('reads a hand-edited tilt once, clamped', () => {
    const raw = { enabled: true, rotateX: 80, rotateY: 3, perspective: 0.2, animate: 'cursor' } as TiltSettings
    const a = tiltOf({ tilt: raw })
    expect(a).toEqual({ ...raw, rotateX: 30 })
    expect(tiltOf({ tilt: raw })).toBe(a)
  })

  it('gives the defaults to edit when there is no tilt yet', () => {
    expect(tiltSettingsOf({})).toEqual(DEFAULT_TILT)
    expect(DEFAULT_TILT.enabled).toBe(false)
  })
})

describe('tiltView: projection of the card', () => {
  it('is the identity without a tilt, whatever the perspective', () => {
    for (const p of [0, 0.5, 1]) {
      const v = tiltView(pose(0, 0, p), BODY, frameArea(W, H))
      expect(v.fit).toBe(1)
      const [tl, tr, br, bl] = projectRect(v, BODY)
      expect(tl).toEqual({ x: BODY.x, y: BODY.y, q: 1 })
      expect(tr).toEqual({ x: BODY.x + BODY.w, y: BODY.y, q: 1 })
      expect(br).toEqual({ x: BODY.x + BODY.w, y: BODY.y + BODY.h, q: 1 })
      expect(bl).toEqual({ x: BODY.x, y: BODY.y + BODY.h, q: 1 })
      // Any point, also outside the card (its shadow).
      expect(projectPoint(v, 12.5, 1070)).toEqual({ x: 12.5, y: 1070, q: 1 })
    }
  })

  it('keeps the centre where it is', () => {
    const v = tiltView(pose(18, -25, 1), BODY, frameArea(W, H))
    const c = projectPoint(v, BODY.x + BODY.w / 2, BODY.y + BODY.h / 2)
    expect(c.x).toBeCloseTo(BODY.x + BODY.w / 2, 9)
    expect(c.y).toBeCloseTo(BODY.y + BODY.h / 2, 9)
    expect(c.q).toBe(1)
  })

  it('without perspective, turning only narrows the card by the cosine', () => {
    const v = tiltView(pose(0, 20, 0), BODY, frameArea(W, H))
    const [tl, tr, br, bl] = projectRect(v, BODY)
    expect(tr.x - tl.x).toBeCloseTo(BODY.w * Math.cos((20 * Math.PI) / 180), 9)
    expect(br.y - tr.y).toBeCloseTo(BODY.h, 9)
    expect(bl.y - tl.y).toBeCloseTo(BODY.h, 9)
    // Tilting back only shortens it.
    const [a, b, , d] = projectRect(tiltView(pose(25, 0, 0), BODY, frameArea(W, H)), BODY)
    expect(d.y - a.y).toBeCloseTo(BODY.h * Math.cos((25 * Math.PI) / 180), 9)
    expect(b.x - a.x).toBeCloseTo(BODY.w, 9)
  })

  it('makes the far edge shorter: the right edge when turned right, the top when tilted back', () => {
    const [tl, tr, br, bl] = projectRect(tiltView(pose(0, 20, 0.6), BODY, frameArea(W, H)), BODY)
    expect(len(tr, br)).toBeLessThan(len(tl, bl) * 0.9)
    expect(tr.q).toBeGreaterThan(1)
    expect(tl.q).toBeLessThan(1)
    const [a, b, c, d] = projectRect(tiltView(pose(20, 0, 0.6), BODY, frameArea(W, H)), BODY)
    expect(len(a, b)).toBeLessThan(len(d, c) * 0.9)
    // More perspective, more difference.
    const [, s1, s2] = projectRect(tiltView(pose(0, 20, 0.2), BODY, frameArea(W, H)), BODY)
    expect(len(s1, s2)).toBeGreaterThan(len(tr, br))
  })

  it('is mirror symmetric: turning the other way mirrors the card about its centre', () => {
    for (const [rx, ry, p] of [
      [10, 20, 0.5],
      [-15, 8, 1],
      [25, 30, 0.2]
    ]) {
      const a = projectRect(tiltView(pose(rx, ry, p), BODY, frameArea(W, H)), BODY)
      const b = projectRect(tiltView(pose(rx, -ry, p), BODY, frameArea(W, H)), BODY)
      const cx = BODY.x + BODY.w / 2
      // Corner i of one is the horizontally mirrored corner of the other (TL <-> TR, BR <-> BL).
      const mirror = [1, 0, 3, 2]
      a.forEach((p1, i) => {
        const p2 = b[mirror[i]]
        expect(p1.x - cx).toBeCloseTo(cx - p2.x, 6)
        expect(p1.y).toBeCloseTo(p2.y, 6)
      })
      // And tilting forward instead of back mirrors it vertically.
      const c = projectRect(tiltView(pose(-rx, ry, p), BODY, frameArea(W, H)), BODY)
      const cy = BODY.y + BODY.h / 2
      const flip = [3, 2, 1, 0]
      a.forEach((p1, i) => {
        const p2 = c[flip[i]]
        expect(p1.y - cy).toBeCloseTo(cy - p2.y, 6)
        expect(p1.x).toBeCloseTo(p2.x, 6)
      })
    }
  })

  it('matches a direct 3D rotation and pinhole projection', () => {
    const rx = 17
    const ry = -23
    const p = 0.8
    const v = tiltView(pose(rx, ry, p), BODY, frameArea(W, H))
    const a = (rx * Math.PI) / 180
    const b = (ry * Math.PI) / 180
    const d = Math.max(BODY.w, BODY.h) / p
    const cx = BODY.x + BODY.w / 2
    const cy = BODY.y + BODY.h / 2
    for (const [x, y] of [
      [BODY.x, BODY.y],
      [BODY.x + BODY.w, BODY.y + BODY.h],
      [300, 900]
    ]) {
      // Tilt about x (top away), then turn about y (right edge away); z points away.
      const p0 = [x - cx, y - cy, 0]
      const p1 = [p0[0], p0[1] * Math.cos(a), -p0[1] * Math.sin(a)]
      const p2 = [p1[0] * Math.cos(b) - p1[2] * Math.sin(b), p1[1], p1[0] * Math.sin(b) + p1[2] * Math.cos(b)]
      const s = d / (d + p2[2])
      const got = projectPoint(v, x, y)
      expect(got.x).toBeCloseTo(cx + v.fit * p2[0] * s, 6)
      expect(got.y).toBeCloseTo(cy + v.fit * p2[1] * s, 6)
    }
  })

  it('shrinks the card just enough to keep every tilted corner inside the frame', () => {
    // A card filling the whole frame (no padding): any tilt brings a corner out.
    const full: Rect = { x: 0, y: 0, w: W, h: H }
    const v = tiltView(pose(10, 25, 1), full, frameArea(W, H))
    expect(v.fit).toBeLessThan(1)
    const corners = projectRect(v, full)
    for (const c of corners) expect(inside(c, W, H)).toBe(true)
    // It touches the frame: no more shrinking than needed.
    const touches = corners.some((c) => Math.abs(c.x) < 1e-6 || Math.abs(c.x - W) < 1e-6 || Math.abs(c.y) < 1e-6 || Math.abs(c.y - H) < 1e-6)
    expect(touches).toBe(true)
    // A padded card that stays inside anyway keeps its size.
    expect(tiltView(pose(6, -12, 0.3), BODY, frameArea(W, H)).fit).toBe(1)
  })

  it("keeps the style's padding around a tilted card, but never shrinks a flat one", () => {
    const pad = 0.07 * H
    const v = tiltView(pose(16, -14, 0.7), BODY, frameArea(W, H, pad))
    expect(v.fit).toBeLessThan(tiltView(pose(16, -14, 0.7), BODY, frameArea(W, H)).fit)
    for (const c of projectRect(v, BODY)) {
      expect(c.x).toBeGreaterThanOrEqual(pad - 1e-6)
      expect(c.x).toBeLessThanOrEqual(W - pad + 1e-6)
      expect(c.y).toBeGreaterThanOrEqual(pad - 1e-6)
      expect(c.y).toBeLessThanOrEqual(H - pad + 1e-6)
    }
    // A flat card already inside the margin (a device frame's chrome, a large padding) stays as it is.
    const big = { x: 10, y: 10, w: W - 20, h: H - 20 }
    expect(tiltView(pose(0, 0, 1), big, frameArea(W, H, pad)).fit).toBe(1)
    // A bigger margin than half the frame is not a margin.
    expect(tiltView(pose(10, 10, 0.5), BODY, frameArea(W, H, 1e9)).fit).toBeGreaterThan(0)
  })

  it('keeps corners inside the frame for any pose, size and position (and the card in front of the camera)', () => {
    let seed = 7
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let i = 0; i < 400; i++) {
      const w = 320 + rand() * 3500
      const h = 320 + rand() * 3500
      const bw = w * (0.2 + rand() * 0.8)
      const bh = h * (0.2 + rand() * 0.8)
      const body = { x: rand() * (w - bw), y: rand() * (h - bh), w: bw, h: bh }
      const v = tiltView(pose(-30 + rand() * 60, -30 + rand() * 60, rand()), body, frameArea(w, h, rand() * 0.25 * Math.min(w, h)))
      for (const c of projectRect(v, body)) {
        expect(inside(c, w, h, 1e-6 * Math.max(w, h))).toBe(true)
        expect(c.q).toBeGreaterThan(0.3)
      }
    }
  })

  it('looks the same at any size: a smaller card (pulled back, or a smaller export) is the same picture scaled', () => {
    const v1 = tiltView(pose(14, -20, 0.7), BODY, frameArea(W, H))
    const s = 0.5
    const small = { x: BODY.x * s, y: BODY.y * s, w: BODY.w * s, h: BODY.h * s }
    const v2 = tiltView(pose(14, -20, 0.7), small, frameArea(W * s, H * s))
    const a = projectRect(v1, BODY)
    const b = projectRect(v2, small)
    a.forEach((p, i) => {
      expect(b[i].x).toBeCloseTo(p.x * s, 6)
      expect(b[i].y).toBeCloseTo(p.y * s, 6)
      expect(b[i].q).toBeCloseTo(p.q, 9)
    })
  })

  it('treats a missing perspective as none', () => {
    const v = tiltView({ rotateX: 0, rotateY: 20, perspective: NaN }, BODY, frameArea(W, H))
    expect(v.invD).toBe(0)
  })
})

describe('quadBounds', () => {
  it('is the pixel-aligned box around the points, cut to the frame', () => {
    const q = (x: number, y: number): TiltPoint => ({ x, y, q: 1 })
    expect(quadBounds([q(10.2, 20.7), q(100.5, 15), q(90, 300.1), q(5, 250)], W, H)).toEqual({ x: 5, y: 15, w: 96, h: 286 })
    expect(quadBounds([q(-50, -10), q(2000, -10), q(2000, 1200), q(-50, 1200)], W, H)).toEqual({ x: 0, y: 0, w: W, h: H })
    expect(quadBounds([q(-50, -10), q(-20, -10), q(-20, -5), q(-50, -5)], W, H)).toMatchObject({ w: 0, h: 0 })
  })
})

describe('tiltPoseAt: animation', () => {
  const path = (x: number, y: number) => ({ at: () => ({ x, y }) })

  it("'none' keeps the set angles", () => {
    const t = settings({ rotateX: 12, rotateY: -9, perspective: 0.4, animate: 'none' })
    expect(tiltPoseAt(t, 3, { scale: 2, cx: 0.3, cy: 0.3 }, path(0.9, 0.9))).toEqual({ rotateX: 12, rotateY: -9, perspective: 0.4 })
  })

  it("'zoom' flattens the card while zoomed in, following the camera's level", () => {
    const t = settings({ rotateX: 12, rotateY: -20, animate: 'zoom' })
    const at = (scale: number): TiltAngles => tiltPoseAt(t, 0, { scale, cx: 0.5, cy: 0.5 }, null)
    expect(at(1)).toMatchObject({ rotateX: 12, rotateY: -20 })
    // Pulled back is not zoomed in: full tilt.
    expect(at(0.7)).toMatchObject({ rotateX: 12, rotateY: -20 })
    expect(poseIsFlat(at(ZOOM_FLAT_SCALE))).toBe(true)
    expect(poseIsFlat(at(2))).toBe(true)
    expect(at(2).rotateX).toBe(0)
    let last = Infinity
    for (let s = 1; s <= ZOOM_FLAT_SCALE + 1e-9; s += 0.02) {
      const ry = Math.abs(at(s).rotateY)
      expect(ry).toBeLessThanOrEqual(last + 1e-12)
      last = ry
    }
    expect(zoomFlatten(1)).toBe(0)
    expect(zoomFlatten(1 + (ZOOM_FLAT_SCALE - 1) / 2)).toBeCloseTo(0.5, 9)
  })

  it("'cursor' leans toward the cursor: its side comes forward, by at most CURSOR_LEAN", () => {
    const t = settings({ rotateX: 10, rotateY: 0, animate: 'cursor' })
    expect(tiltPoseAt(t, 1, REST, path(0.5, 0.5))).toMatchObject({ rotateX: 10, rotateY: 0 })
    // Right edge of the view: the right edge comes forward (rotateY goes negative).
    expect(tiltPoseAt(t, 1, REST, path(1, 0.5)).rotateY).toBeCloseTo(-CURSOR_LEAN, 9)
    expect(tiltPoseAt(t, 1, REST, path(0, 0.5)).rotateY).toBeCloseTo(CURSOR_LEAN, 9)
    // Low in the view: the bottom comes forward, so the top goes further away.
    expect(tiltPoseAt(t, 1, REST, path(0.5, 1)).rotateX).toBeCloseTo(10 + CURSOR_LEAN, 9)
    // Off the frame counts as the edge.
    expect(tiltPoseAt(t, 1, REST, path(5, -3))).toMatchObject({ rotateX: 10 - CURSOR_LEAN, rotateY: -CURSOR_LEAN })
    // No cursor data: no lean.
    expect(tiltPoseAt(t, 1, REST, null)).toMatchObject({ rotateX: 10, rotateY: 0 })
  })

  it('reads the cursor through the zoom camera', () => {
    const cam: Camera = { scale: 2, cx: 0.25, cy: 0.75 }
    expect(cursorLean({ x: 0.25, y: 0.75 }, cam)).toEqual({ x: 0, y: 0 })
    expect(cursorLean({ x: 0.5, y: 1 }, cam)).toEqual({ x: 1, y: 1 })
    expect(cursorLean({ x: 0.5, y: 0.5 }, REST)).toEqual({ x: 0, y: 0 })
  })

  it('is a pure function of time', () => {
    const t = settings({ animate: 'cursor' })
    const moving = { at: (s: number) => ({ x: 0.5 + 0.4 * Math.sin(s), y: 0.5 }) }
    expect(tiltPoseAt(t, 2.5, REST, moving)).toEqual(tiltPoseAt(t, 2.5, REST, moving))
    expect(tiltPoseAt(t, 2.5, REST, moving)).not.toEqual(tiltPoseAt(t, 0, REST, moving))
  })
})

describe('tiltViewAt: a card leaning toward the cursor keeps one size', () => {
  // The "Midnight browser" look at 1080p: padding 0.08, a browser frame, turned right, following the cursor.
  const pad = 0.08 * H
  const body: Rect = { x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad }
  const midnight = settings({ rotateX: 6, rotateY: 16, perspective: 0.55, animate: 'cursor' })
  const at = (x: number, y: number, tilt = midnight, cam = REST) => {
    const focus = { at: () => ({ x, y }) }
    return tiltViewAt(tilt, tiltPoseAt(tilt, 0, cam, focus), leansToCursor(tilt, focus), body, frameArea(W, H, pad))
  }
  const spots = [-0.5, 0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, 1.5]

  it('has the same fit wherever the cursor is, only the angles change', () => {
    // Fitted pose by pose, the card would grow and shrink with the cursor (by about 6% here).
    const own = [pose(1, 11, 0.55), pose(6, 16, 0.55), pose(11, 21, 0.55)].map((a) => tiltView(a, body, frameArea(W, H, pad)).fit)
    expect(Math.max(...own) - Math.min(...own)).toBeGreaterThan(0.04)
    const fit = leanFit(midnight, body, frameArea(W, H, pad))
    expect(fit).toBeLessThanOrEqual(Math.min(...own))
    const angles = new Set<string>()
    for (const x of spots) {
      for (const y of spots) {
        const v = at(x, y)
        expect(v.fit).toBe(fit)
        angles.add(`${v.ax},${v.by}`)
      }
    }
    expect(angles.size).toBeGreaterThan(20)
    // Zoomed in, the cursor is read through the camera: still the same size.
    expect(at(0.3, 0.6, midnight, { scale: 2, cx: 0.3, cy: 0.4 }).fit).toBe(fit)
  })

  it('keeps every corner inside the padding for any lean (the widest pose can lie inside the range)', () => {
    let seed = 3
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let i = 0; i < 60; i++) {
      const m = rand() * 0.15 * H
      const b: Rect = { x: m, y: m, w: W - 2 * m, h: H - 2 * m }
      const tilt = settings({ rotateX: -30 + rand() * 60, rotateY: -30 + rand() * 60, perspective: rand(), animate: 'cursor' })
      const fit = leanFit(tilt, b, frameArea(W, H, m))
      for (let a = 0; a <= 20; a++) {
        for (let c = 0; c <= 20; c++) {
          const focus = { at: () => ({ x: a / 20, y: c / 20 }) }
          const v = tiltViewAt(tilt, tiltPoseAt(tilt, 0, REST, focus), true, b, frameArea(W, H, m))
          expect(v.fit).toBe(fit)
          for (const p of projectRect(v, b)) {
            // Lean poses are tried a grid apart: a pose between them may come a hair closer.
            expect(p.x).toBeGreaterThanOrEqual(m - 0.25)
            expect(p.x).toBeLessThanOrEqual(W - m + 0.25)
            expect(p.y).toBeGreaterThanOrEqual(m - 0.25)
            expect(p.y).toBeLessThanOrEqual(H - m + 0.25)
          }
        }
      }
    }
  })

  it('is tiltView when the card does not lean', () => {
    const p = pose(12, -18, 0.6)
    for (const animate of ['none', 'zoom', 'cursor'] as const) {
      expect(tiltViewAt(settings({ ...p, animate }), p, false, body, frameArea(W, H, pad))).toEqual(tiltView(p, body, frameArea(W, H, pad)))
    }
    // A 'zoom' card grows back to full size as it straightens.
    const flat = pose(0, 0, 0.6)
    expect(tiltViewAt(settings({ ...p, animate: 'zoom' }), flat, false, body, frameArea(W, H, pad)).fit).toBe(1)
  })

  it('follows the card: a pulled-back card, another frame size or other angles get their own fit', () => {
    const small: Rect = { x: body.x + 300, y: body.y + 170, w: body.w - 600, h: body.h - 340 }
    const fit = at(0.5, 0.5).fit
    const focus = { at: () => ({ x: 0.5, y: 0.5 }) }
    const v = tiltViewAt(midnight, tiltPoseAt(midnight, 0, REST, focus), true, small, frameArea(W, H, pad))
    expect(v.fit).toBe(leanFit(midnight, small, frameArea(W, H, pad)))
    expect(v.fit).toBeGreaterThan(fit)
    const steeper = settings({ ...midnight, rotateY: 28 })
    expect(at(0.5, 0.5, steeper).fit).toBe(leanFit(steeper, body, frameArea(W, H, pad)))
    expect(at(0.5, 0.5, steeper).fit).toBeLessThan(fit)
    // And back: the first one again.
    expect(at(0.9, 0.1).fit).toBe(fit)
  })

  it('leans only with a cursor to follow', () => {
    const focus = { at: () => ({ x: 0, y: 0 }) }
    expect(leansToCursor(midnight, focus)).toBe(true)
    expect(leansToCursor(midnight, null)).toBe(false)
    expect(leansToCursor(settings({ animate: 'zoom' }), focus)).toBe(false)
    // No lean room needed for a small tilt on a well padded card.
    expect(leanFit(pose(2, 2, 0.2), BODY, frameArea(W, H))).toBe(1)
  })
})

describe('tiltPoseAt: the cursor lean during an auto zoom', () => {
  // Click into a search box at the top left at 1 s, park the mouse at the bottom right, type from 1.5 to 7 s.
  const samples: CursorSample[] = []
  for (let i = 0; i <= 600; i++) {
    const t = i / 60
    const k = (t - 1) / 0.4
    samples.push(
      t < 1 ? { t, x: 0.5 - 0.35 * t, y: 0.5 - 0.38 * t } : t < 1.4 ? { t, x: 0.15 + 0.77 * k, y: 0.12 + 0.78 * k } : { t, x: 0.92, y: 0.9 }
    )
  }
  const track: CursorTrack = { samples, clicks: [{ t: 1, x: 0.15, y: 0.12, button: 'left' }], typing: [{ t: 1.5, end: 7 }], valid: true }
  const zooms = autoZoomsForTrack(track, 10, DEFAULT_ZOOM_SETTINGS.auto)
  const focus = focusPathFor(samples, 10)
  // The 'Midnight' look: turned right, leaning toward where you work.
  const midnight = settings({ rotateX: 6, rotateY: 16, perspective: 0.55, animate: 'cursor' })

  it('leans toward the field being typed into, as the camera looks at it, not toward the idle mouse', () => {
    expect(zooms).toHaveLength(1)
    expect(zooms[0].anchor?.until).toBe(7)
    for (const t of [2, 4, 6.5]) {
      const cam = cameraAt(zooms, t, focus)
      const p = tiltPoseAt(midnight, t, cam, focus, zooms)
      // The top left (the field) comes forward: the top less far away, the left edge further round.
      expect(p.rotateX).toBeLessThan(midnight.rotateX)
      expect(p.rotateY).toBeGreaterThan(midnight.rotateY)
      // Following the mouse instead would bring the bottom right forward by the whole lean.
      const mouse = tiltPoseAt(midnight, t, cam, focus)
      expect(mouse.rotateX).toBeCloseTo(midnight.rotateX + CURSOR_LEAN, 6)
      expect(mouse.rotateY).toBeCloseTo(midnight.rotateY - CURSOR_LEAN, 6)
    }
  })

  /** Largest change of either angle from one 60 fps frame to the next over [t0, t1], and when. */
  function maxStep(zs: ZoomSegment[], t0: number, t1: number): { step: number; at: number } {
    let prev: TiltAngles | null = null
    let step = 0
    let at = t0
    for (let i = Math.round(t0 * 60); i <= Math.round(t1 * 60); i++) {
      const t = i / 60
      const p = tiltPoseAt(midnight, t, cameraAt(zs, t, focus), focus, zs)
      const d = prev ? Math.max(Math.abs(p.rotateX - prev.rotateX), Math.abs(p.rotateY - prev.rotateY)) : 0
      if (d > step) {
        step = d
        at = t
      }
      prev = p
    }
    return { step, at }
  }

  it('turns over to the field as the camera moves in and back as it moves out, never in one frame', () => {
    const z = zooms[0]
    // At the zoom's very start and end the lean is the mouse's, as the camera is the full frame.
    for (const t of [z.start, z.end]) {
      const cam = cameraAt(zooms, t, focus)
      expect(tiltPoseAt(midnight, t, cam, focus, zooms)).toEqual(tiltPoseAt(midnight, t, cam, focus))
    }
    // Following the mouse alone, the card turns at most 0.4 degrees a frame here. Switching the
    // lean at once would turn it 3.8 degrees in the frame the zoom starts and 7.8 as it ends.
    const { step, at } = maxStep(zooms, 0, 10)
    expect(step, `at ${at}`).toBeLessThan(0.6)
  })

  it('pans the lean from one field to the next across connected typing zooms, as the camera pans', () => {
    const z = zooms[0]
    const a: ZoomSegment = { ...z, id: 'a', start: 1.5, end: 4, anchor: { t: 1.5, x: 0.15, y: 0.12, until: 4 } }
    const b: ZoomSegment = { ...z, id: 'b', start: 4, end: 7, anchor: { t: 4, x: 0.8, y: 0.2, until: 7 } }
    const chain = [a, b]
    // Still on the first field as the second zoom starts; on the second once the camera got there.
    const near = (p: { x: number; y: number }, x: number, y: number): void => {
      expect(p.x).toBeCloseTo(x, 9)
      expect(p.y).toBeCloseTo(y, 9)
    }
    near(aimAt(chain, 4, focus), 0.15, 0.12)
    near(aimAt(chain, 4 + ZOOM_TRANSITION, focus), 0.8, 0.2)
    const mid = aimAt(chain, 4 + ZOOM_TRANSITION / 2, focus)
    expect(mid.x).toBeGreaterThan(0.2)
    expect(mid.x).toBeLessThan(0.75)
    expect(maxStep(chain, 0, 10).step).toBeLessThan(0.6)
  })

  it('follows the cursor again once the zoom has ended, and wherever no zoom holds its aim', () => {
    const cam = cameraAt(zooms, 9.5, focus)
    expect(tiltPoseAt(midnight, 9.5, cam, focus, zooms)).toEqual(tiltPoseAt(midnight, 9.5, cam, focus))
    // A zoom with a fixed focus does not move the lean off the cursor.
    const fixed = [{ id: 'f', start: 0, end: 10, scale: 2, focus: { mode: 'fixed' as const, x: 0.2, y: 0.2 }, auto: false }]
    const fcam = cameraAt(fixed, 4, focus)
    expect(tiltPoseAt(midnight, 4, fcam, focus, fixed)).toEqual(tiltPoseAt(midnight, 4, fcam, focus))
  })
})

describe('tiltArea: the tilted screen stays in its own slot', () => {
  function sceneProject(layout: CameraLayout | null, corner: Project['webcam']['corner'] = 'bottom-right', padding = 0.06): Project {
    const p = createProject({
      id: 'p',
      name: 'p',
      duration: 10,
      width: 1920,
      height: 1080,
      hasWebcam: true,
      hasAudio: false,
      webcamOffset: 0,
      zooms: [],
      cursorValid: false,
      capture: { method: 'native', cursorInVideo: false, region: null }
    })
    p.style = { background: { type: 'color', color: '#123456' }, padding, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
    p.webcam = { ...p.webcam, show: true, corner }
    p.layouts = layout ? [{ id: 'l', start: 2, end: 8, layout }] : []
    return p
  }
  const hero = TILT_PRESETS.find((t) => t.id === 'hero')!.angles

  it('keeps the default Hero tilt left of the camera card beside it (it used to go 17 px under it)', () => {
    const p = sceneProject('side-by-side')
    const screen = sceneContentRect(p, W, H, W, H, 5)
    const cam = sceneCameraBox(p, W, H, W, H, 5)!
    expect(cam.rect.x).toBeGreaterThan(screen.x + screen.w)
    // Fitted to the whole frame, the bottom-right corner lands past the camera card's left edge.
    const loose = projectRect(tiltView(hero, screen, frameArea(W, H, 0.06 * H)), screen)
    expect(Math.max(...loose.map((c) => c.x))).toBeGreaterThan(cam.rect.x)
    const area = tiltArea(p, W, H, W, H, 5)
    const gapMid = (screen.x + screen.w + cam.rect.x) / 2
    expect(area).toEqual({ ...frameArea(W, H, 0.06 * H), x1: gapMid })
    for (const c of projectRect(tiltView(hero, screen, area), screen)) {
      expect(c.x).toBeLessThanOrEqual(gapMid + 1e-6)
      expect(c.x).toBeGreaterThanOrEqual(area.x0 - 1e-6)
      expect(c.y).toBeGreaterThanOrEqual(area.y0 - 1e-6)
      expect(c.y).toBeLessThanOrEqual(area.y1 + 1e-6)
    }
  })

  it('keeps clear of a camera on the left, and of one below the screen in a portrait frame', () => {
    const left = sceneProject('side-by-side', 'bottom-left')
    const cl = sceneCameraBox(left, W, H, W, H, 5)!.rect
    const sl = sceneContentRect(left, W, H, W, H, 5)
    expect(tiltArea(left, W, H, W, H, 5).x0).toBeCloseTo((cl.x + cl.w + sl.x) / 2, 9)
    for (const c of projectRect(tiltView(pose(6, 20, 0.55), sl, tiltArea(left, W, H, W, H, 5)), sl)) expect(c.x).toBeGreaterThan(cl.x + cl.w)
    // 1080 x 1920: the camera card goes under the screen.
    const tall = sceneProject('side-by-side')
    const cb = sceneCameraBox(tall, H, W, W, H, 5)!.rect
    const sb = sceneContentRect(tall, H, W, W, H, 5)
    expect(cb.y).toBeGreaterThan(sb.y + sb.h)
    expect(tiltArea(tall, H, W, W, H, 5).y1).toBeCloseTo((sb.y + sb.h + cb.y) / 2, 9)
  })

  it('keeps clear of a card on the side of its segment corner, and moves with it as it changes sides', () => {
    const left = sceneProject('side-by-side', 'bottom-left')
    const right = sceneProject('side-by-side')
    const own = sceneProject(null)
    own.layouts = [{ id: 'l', start: 2, end: 8, layout: 'side-by-side', corner: 'top-left' }]
    expect(tiltArea(own, W, H, W, H, 5)).toEqual(tiltArea(left, W, H, W, H, 5))
    // Straight into a card on the project's side (the right): half way, half way between the two.
    own.layouts = [...own.layouts, { id: 'r', start: 8, end: 10, layout: 'side-by-side' }]
    const a = tiltArea(left, W, H, W, H, 5)
    const b = tiltArea(right, W, H, W, H, 5)
    const mid = tiltArea(own, W, H, W, H, 8 + LAYOUT_TRANSITION / 2)
    expect(mid.x0).toBeCloseTo((a.x0 + b.x0) / 2, 6)
    expect(mid.x1).toBeCloseTo((a.x1 + b.x1) / 2, 6)
  })

  it('is the frame inside the padding for every other layout, without a camera, and outside layouts', () => {
    const frame = frameArea(W, H, 0.06 * H)
    for (const layout of ['default', 'camera-large', 'camera-only', 'screen-only'] as const) expect(tiltArea(sceneProject(layout), W, H, W, H, 5)).toEqual(frame)
    expect(tiltArea(sceneProject('side-by-side'), W, H, W, H, 1)).toEqual(frame)
    const hidden = sceneProject('side-by-side')
    hidden.webcam = { ...hidden.webcam, show: false }
    expect(tiltArea(hidden, W, H, W, H, 5)).toEqual(frame)
  })

  it('moves with the cards while the layout changes, without a jump', () => {
    const p = sceneProject('side-by-side')
    const frame = frameArea(W, H, 0.06 * H)
    const settled = tiltArea(p, W, H, W, H, 5)
    // Eased like the cards over LAYOUT_TRANSITION (0.4 s, ease in-out cubic): at most 3x the average speed.
    const step = ((frame.x1 - settled.x1) * 3 * 0.01) / 0.4
    let last = frame.x1
    for (let t = 1.9; t <= 2.5; t += 0.01) {
      const a = tiltArea(p, W, H, W, H, t)
      expect(a.x1).toBeLessThanOrEqual(last + 1e-9)
      expect(last - a.x1).toBeLessThan(step + 1e-6)
      last = a.x1
    }
    expect(last).toBeCloseTo(settled.x1, 9)
  })
})

describe('presets and helpers', () => {
  it('has distinct, valid presets', () => {
    expect(TILT_PRESETS.map((p) => p.id)).toEqual(['left', 'right', 'top', 'hero'])
    for (const p of TILT_PRESETS) expect(readTilt({ enabled: true, ...p.angles })).toMatchObject(p.angles)
    for (let i = 0; i < TILT_PRESETS.length; i++) for (let j = i + 1; j < TILT_PRESETS.length; j++) expect(sameAngles(TILT_PRESETS[i].angles, TILT_PRESETS[j].angles)).toBe(false)
    expect(sameAngles(DEFAULT_TILT, TILT_PRESETS[3].angles)).toBe(true)
  })

  it('writes the same pose as a CSS transform', () => {
    expect(tiltCss(pose(10, -20, 0.5), 44)).toBe('perspective(88.0px) rotateY(-20deg) rotateX(10deg)')
    expect(tiltCss(pose(10, -20, 0), 44)).toBe('rotateY(-20deg) rotateX(10deg)')
  })
})
