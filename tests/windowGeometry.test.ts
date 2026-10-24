import { describe, expect, it } from 'vitest'
import { fitContent, hiddenPoint, insideWindow, mapPointToWindowVideo, poseAt, poseIndexAt, posesFromRects, type WindowPose } from '../src/shared/recording/windowGeometry'

describe('mapping beside a resized window (no cursor in the black bars)', () => {
  // A 1280 x 720 video; the window became 640 x 720 at (100, 0): content at x 320..960.
  const out = { width: 1280, height: 720 }
  const p: WindowPose = { at: 0, dip: { x: 100, y: 0, width: 640, height: 720 }, physical: { x: 100, y: 0, width: 640, height: 720 } }
  it('maps the window edges onto the content edges, and anything beside them outside 0..1', () => {
    expect(mapPointToWindowVideo({ x: 100, y: 360 }, p, out)!.x).toBeCloseTo(0.25)
    expect(mapPointToWindowVideo({ x: 740, y: 360 }, p, out)!.x).toBeCloseTo(0.75)
    expect(mapPointToWindowVideo({ x: 741, y: 360 }, p, out)!.x).toBeGreaterThan(1)
    expect(mapPointToWindowVideo({ x: 99, y: 360 }, p, out)!.x).toBeLessThan(0)
    // Continues outwards at the content's scale from the video edge.
    expect(mapPointToWindowVideo({ x: 740 + 640, y: 360 }, p, out)!.x).toBeCloseTo(1.5)
  })
})

describe('poseAt (window moves between polls)', () => {
  const at = (t: number, x: number, w = 100, extra: Partial<WindowPose> = {}): WindowPose => ({
    at: t,
    dip: { x, y: 0, width: w, height: 50 },
    physical: { x, y: 0, width: w, height: 50 },
    ...extra
  })
  it('interpolates a move across the last poll interval before the next pose only', () => {
    const poses = [at(0, 0), at(1000, 170)]
    expect(poseAt(poses, 500).dip.x).toBe(0)
    expect(poseAt(poses, 983).dip.x).toBe(0)
    expect(poseAt(poses, 991.5).dip.x).toBeCloseTo(85)
    expect(poseAt(poses, 991.5).physical.x).toBeCloseTo(85)
    expect(poseAt(poses, 1000).dip.x).toBe(170)
  })
  it('steps across resizes, minimised windows and gaps shorter than a poll', () => {
    expect(poseAt([at(0, 0), at(10, 100, 200)], 5).dip.x).toBe(0)
    expect(poseAt([at(0, 0), at(10, 100, 100, { minimized: true })], 5).dip.x).toBe(0)
    expect(poseAt([at(0, 0, 100, { minimized: true }), at(10, 100)], 5).minimized).toBe(true)
    // Polls 10 ms apart: the whole gap is interpolated.
    expect(poseAt([at(0, 0), at(10, 100)], 5).dip.x).toBeCloseTo(50)
  })
  it('keeps the covering state of the pose in effect', () => {
    expect(poseAt([at(0, 0, 100, { cursorOver: false }), at(10, 100)], 5).cursorOver).toBe(false)
  })
})

describe('hiddenPoint', () => {
  it('puts a point past the nearest video edge, keeping the other coordinate', () => {
    expect(hiddenPoint({ x: 0.9, y: 0.4 })).toEqual({ x: 2, y: 0.4 })
    expect(hiddenPoint({ x: 0.2, y: 0.1 })).toEqual({ x: 0.2, y: -1 })
    expect(hiddenPoint({ x: 0.05, y: 0.5 })).toEqual({ x: -1, y: 0.5 })
    expect(hiddenPoint({ x: 0.5, y: 0.97 })).toEqual({ x: 0.5, y: 2 })
  })
  it('leaves a point already outside the video alone', () => {
    expect(hiddenPoint({ x: 1.3, y: 0.5 })).toEqual({ x: 1.3, y: 0.5 })
  })
})

describe('posesFromRects cursorOver', () => {
  it('keeps cursorOver false only; absent or true means over the window', () => {
    const [a, b, c] = posesFromRects([
      { at: 0, x: 0, y: 0, width: 10, height: 10, cursorOver: false },
      { at: 1, x: 0, y: 0, width: 10, height: 10, cursorOver: true },
      { at: 2, x: 0, y: 0, width: 10, height: 10 }
    ])
    expect(a.cursorOver).toBe(false)
    expect(b.cursorOver).toBeUndefined()
    expect(c.cursorOver).toBeUndefined()
  })
})

const pose = (at: number, x: number, y: number, w: number, h: number, scale = 1, minimized = false): WindowPose => ({
  at,
  dip: { x, y, width: w, height: h },
  physical: { x: x * scale, y: y * scale, width: w * scale, height: h * scale },
  minimized
})

describe('fitContent', () => {
  it('is the identity for the initial size', () => {
    expect(fitContent({ width: 1280, height: 720 }, { width: 1280, height: 720 })).toEqual({ scale: 1, dx: 0, dy: 0, width: 1280, height: 720 })
  })
  it('letterboxes a wider window and pillarboxes a taller one, centred', () => {
    const wide = fitContent({ width: 2560, height: 720 }, { width: 1280, height: 720 })
    expect(wide).toMatchObject({ scale: 0.5, dx: 0, dy: 180, width: 1280, height: 360 })
    const tall = fitContent({ width: 640, height: 1440 }, { width: 1280, height: 720 })
    expect(tall).toMatchObject({ scale: 0.5, dx: 480, dy: 0, width: 320, height: 720 })
  })
})

describe('mapPointToWindowVideo', () => {
  const out = { width: 1000, height: 500 }
  it('maps window corners and centre to 0..1', () => {
    const p = pose(0, 100, 50, 1000, 500)
    expect(mapPointToWindowVideo({ x: 100, y: 50 }, p, out)).toEqual({ x: 0, y: 0 })
    expect(mapPointToWindowVideo({ x: 600, y: 300 }, p, out)).toEqual({ x: 0.5, y: 0.5 })
    expect(mapPointToWindowVideo({ x: 1100, y: 550 }, p, out)).toEqual({ x: 1, y: 1 })
  })
  it('follows a moved window', () => {
    const p = pose(0, 300, 200, 1000, 500)
    expect(mapPointToWindowVideo({ x: 800, y: 450 }, p, out)).toEqual({ x: 0.5, y: 0.5 })
  })
  it('maps into the fitted content after a resize', () => {
    // Window became 2000x500 (twice as wide): content occupies the middle half vertically.
    const p = pose(0, 0, 0, 2000, 500)
    const r = mapPointToWindowVideo({ x: 2000, y: 0 }, p, out)!
    expect(r.x).toBeCloseTo(1)
    expect(r.y).toBeCloseTo(0.25)
  })
  it('uses DIP for the cursor and physical size for the fit (150% scaling)', () => {
    const p = pose(0, 100, 100, 800, 400, 1.5) // physical 1200x600 fits a 1200x600 output exactly
    const r = mapPointToWindowVideo({ x: 500, y: 300 }, p, { width: 1200, height: 600 })!
    expect(r.x).toBeCloseTo(0.5)
    expect(r.y).toBeCloseTo(0.5)
  })
  it('returns null while minimised and maps outside points outside 0..1', () => {
    expect(mapPointToWindowVideo({ x: 0, y: 0 }, pose(0, 0, 0, 10, 10, 1, true), out)).toBeNull()
    const r = mapPointToWindowVideo({ x: 0, y: 0 }, pose(0, 100, 50, 1000, 500), out)!
    expect(r.x).toBeLessThan(0)
  })
})

describe('poses over time', () => {
  it('finds the pose in effect at a time', () => {
    const poses = [pose(1000, 0, 0, 10, 10), pose(2000, 5, 5, 10, 10), pose(3000, 9, 9, 10, 10)]
    expect(poseIndexAt(poses, 500)).toBe(0)
    expect(poseIndexAt(poses, 1999)).toBe(0)
    expect(poseIndexAt(poses, 2000)).toBe(1)
    expect(poseIndexAt(poses, 99999)).toBe(2)
  })
  it('tests whether a point is inside the window', () => {
    const p = pose(0, 100, 100, 200, 100)
    expect(insideWindow({ x: 150, y: 150 }, p)).toBe(true)
    expect(insideWindow({ x: 99, y: 150 }, p)).toBe(false)
    expect(insideWindow({ x: 150, y: 150 }, pose(0, 100, 100, 200, 100, 1, true))).toBe(false)
  })
})
