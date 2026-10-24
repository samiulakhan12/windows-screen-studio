import { describe, expect, it } from 'vitest'
import {
  arrowToward,
  createShape,
  createSpotlight,
  dragShapeBox,
  dragShapeTimes,
  drawnBox,
  drawnGeometry,
  duplicateItem,
  fadeLead,
  hasStroke,
  isLineKind,
  isPrivacyKind,
  itemLanes,
  MIN_SHAPE_LENGTH,
  MIN_SHAPE_SIDE,
  moveLine,
  playheadTimes,
  resizeAround,
  revealTime,
  setItemTime,
  setLineEnd,
  SHAPE_FADE,
  shapeBounds,
  shapeForPlayhead,
  SPOTLIGHT_FADE,
  spotlightForPlayhead
} from '../src/shared/editor/shapes'
import type { Camera } from '../src/shared/engine/zoom'
import {
  arrowGeometry,
  blurPlan,
  blurSigma,
  clipToUnit,
  cursorPositionAt,
  featherRects,
  pixelCell,
  pixelGrid,
  projectShapes,
  projectSpotlights,
  readShape,
  readSpotlight,
  shapeAlpha,
  spotlightAlpha,
  spotlightArea,
  spotlightFeather,
  spotlightLevels,
  sweptBox,
  visibleCursorAt
} from '../src/shared/render/shapes'
import type { Clip, Shape, Spotlight } from '../src/shared/types'

const project = { duration: 20, width: 1920, height: 1080 }
const inUnit = (v: number): boolean => v >= -1e-9 && v <= 1 + 1e-9

describe('createShape / createSpotlight', () => {
  it('start at the playhead with kind defaults, clamped to the recording', () => {
    const a = createShape('arrow', 4, 20)
    expect([a.start, a.end]).toEqual([4, 7])
    expect(a.kind).toBe('arrow')
    // Near the end it starts earlier, keeping its full length.
    const h = createShape('highlight', 19.95, 20)
    expect([h.start, h.end]).toEqual([17, 20])
    expect(h.color).toBe('#ffd60a')
    expect(h.opacity).toBeLessThan(1)
    expect(createShape('blur', -3, 20).start).toBe(0)
  })

  it('lets init override the defaults and makes unique ids', () => {
    const s = createShape('rect', 1, 20, { color: '#00ff00', fill: true, x: 0.1 })
    expect(s).toMatchObject({ color: '#00ff00', fill: true, x: 0.1 })
    expect(createShape('rect', 1, 20).id).not.toBe(createShape('rect', 1, 20).id)
    expect(createSpotlight('region', 1, 20).id).not.toBe(createSpotlight('region', 1, 20).id)
  })

  it('a cursor spotlight starts as a smaller lit area', () => {
    const c = createSpotlight('cursor', 2, 20)
    const r = createSpotlight('region', 2, 20)
    expect(c.h).toBeLessThan(r.h)
    expect(c.mode).toBe('cursor')
    expect([r.start, r.end]).toEqual([2, 5])
    const end = createSpotlight('cursor', 20, 20)
    expect([end.start, end.end]).toEqual([17, 20])
  })

  it('a recording shorter than the default length gets one item over all of it', () => {
    expect([createShape('rect', 1, 2).start, createShape('rect', 1, 2).end]).toEqual([0, 2])
    expect([createSpotlight('region', 1.5, 2).start, createSpotlight('region', 1.5, 2).end]).toEqual([0, 2])
  })
})

describe('kinds', () => {
  it('privacy, line and stroke kinds', () => {
    expect(isPrivacyKind('blur') && isPrivacyKind('pixelate')).toBe(true)
    expect(isPrivacyKind('highlight')).toBe(false)
    expect(isLineKind('arrow') && isLineKind('line') && !isLineKind('rect')).toBe(true)
    expect(hasStroke({ kind: 'rect', fill: false })).toBe(true)
    expect(hasStroke({ kind: 'rect', fill: true })).toBe(false)
    expect(hasStroke({ kind: 'highlight', fill: false })).toBe(false)
    expect(hasStroke({ kind: 'arrow', fill: true })).toBe(true)
  })
})

describe('items made at the playhead', () => {
  it('start one fade earlier so they are fully shown at the playhead (privacy shapes start right there)', () => {
    expect(shapeForPlayhead('rect', 5, project, null).start).toBeCloseTo(5 - SHAPE_FADE)
    expect(shapeForPlayhead('rect', 5, project, null, 2).start).toBeCloseTo(5 - 2 * SHAPE_FADE)
    expect(shapeForPlayhead('blur', 5, project, null).start).toBe(5)
    expect(shapeForPlayhead('arrow', 0.05, project, null).start).toBe(0)
    expect(spotlightForPlayhead('region', 5, project).start).toBeCloseTo(5 - SPOTLIGHT_FADE)
    expect(fadeLead('pixelate')).toBe(0)
    for (const t of [5, 0.1]) {
      const s = shapeForPlayhead('ellipse', t, project, null)
      if (t > SHAPE_FADE) expect(shapeAlpha(s, t)).toBeCloseTo(1)
    }
  })

  it('made where playback stops (the end), they keep their length and show fully at the playhead after revealTime', () => {
    for (const kind of ['arrow', 'rect', 'blur', 'pixelate', 'highlight'] as const) {
      const s = shapeForPlayhead(kind, 20, project, null)
      expect([s.start, s.end]).toEqual([17, 20])
      const at = revealTime(s, 20, fadeLead(kind))
      expect(at).toBeLessThan(20)
      expect(at).toBeGreaterThan(19.5)
      expect(shapeAlpha(s, at)).toBe(1)
    }
    const sp = spotlightForPlayhead('region', 20, project)
    expect([sp.start, sp.end]).toEqual([17, 20])
    expect(spotlightAlpha(sp, revealTime(sp, 20, fadeLead('spotlight')))).toBe(1)
  })

  it('stay inside the kept part of the recording (cuts at either end)', () => {
    const clips: Clip[] = [{ id: 'c', start: 2, end: 8, speed: 1 }]
    const p = { ...project, clips }
    // The playhead rests at the end of the kept part after playing through.
    expect(playheadTimes(8, SHAPE_FADE, p)).toEqual({ start: 5, end: 8 })
    expect(shapeForPlayhead('ellipse', 8, p, null).end).toBe(8)
    expect(spotlightForPlayhead('cursor', 8, p).start).toBe(5)
    expect(playheadTimes(2.05, SHAPE_FADE, p).start).toBe(2)
    // In the middle nothing changes.
    expect(playheadTimes(5, SHAPE_FADE, p).start).toBeCloseTo(5 - SHAPE_FADE)
    // Kept part shorter than the default length: all of it.
    expect(playheadTimes(4, 0, { duration: 20, clips: [{ id: 'c', start: 3, end: 4.5, speed: 1 }] })).toEqual({ start: 3, end: 4.5 })
    // No clips, or a degenerate kept part: the whole recording.
    expect(playheadTimes(20, 0, { duration: 20 })).toEqual({ start: 17, end: 20 })
    expect(playheadTimes(20, 0, { duration: 20, clips: [{ id: 'c', start: 5, end: 5, speed: 1 }] })).toEqual({ start: 17, end: 20 })
  })

  it('revealTime keeps the playhead when the item already shows fully, else moves it as little as possible', () => {
    const item = { start: 4, end: 7 }
    expect(revealTime(item, 5, 0.15)).toBe(5)
    expect(revealTime(item, 4.15, 0.15)).toBe(4.15)
    // Before it: just past the fade-in. After it, or in its fade-out: just before the fade-out.
    expect(revealTime(item, 1, 0.15)).toBeCloseTo(4.16)
    expect(revealTime(item, 7, 0.15)).toBeCloseTo(6.84)
    expect(revealTime(item, 6.95, 0.15)).toBeCloseTo(6.84)
    // Privacy shapes do not fade: the start shows, the end (exclusive) does not.
    expect(revealTime(item, 4, 0)).toBe(4)
    expect(revealTime(item, 7, 0)).toBeCloseTo(6.98)
    // Too short to ever show fully: its middle.
    expect(revealTime({ start: 4, end: 4.2 }, 9, 0.15)).toBeCloseTo(4.1)
  })

  it('a cursor spotlight is round on screen', () => {
    const s = spotlightForPlayhead('cursor', 3, project)
    expect(s.w * (1920 / 1080)).toBeCloseTo(s.h)
  })

  it('an arrow points at the cursor from the side nearer the middle, inside the frame', () => {
    for (const p of [
      { x: 0.8, y: 0.7 },
      { x: 0.1, y: 0.2 },
      { x: 0.02, y: 0.98 },
      { x: 1, y: 0 }
    ]) {
      const a = arrowToward(p, 16 / 9)
      const tip = { x: a.x + a.w, y: a.y + a.h }
      expect(Math.hypot(tip.x - p.x, tip.y - p.y)).toBeLessThan(0.05)
      for (const v of [a.x, a.y, tip.x, tip.y]) expect(inUnit(v)).toBe(true)
      // Comes from the middle's side.
      expect(Math.sign(a.w) || 1).toBe(p.x > 0.5 ? 1 : -1)
      expect(Math.sign(a.h) || 1).toBe(p.y > 0.5 ? 1 : -1)
    }
    const s = shapeForPlayhead('arrow', 2, project, { x: 0.7, y: 0.6 })
    expect(s.x + s.w).toBeCloseTo(0.7 - 0.012)
  })
})

describe('geometry on the preview', () => {
  it('bounds of lines with negative extents', () => {
    expect(shapeBounds({ x: 0.5, y: 0.5, w: -0.2, h: 0.1 })).toEqual({ x: 0.3, y: 0.5, w: 0.2, h: 0.1 })
  })

  it('moving a box keeps it inside; resizing keeps the opposite edge', () => {
    const box = { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }
    expect(dragShapeBox(box, 'move', 0.5, 0.5)).toEqual({ x: 0.7, y: 0.7, w: 0.3, h: 0.3 })
    const r = dragShapeBox(box, 'nw', 0.1, 0.05)
    expect(r.x + r.w).toBeCloseTo(0.9)
    expect(r.y + r.h).toBeCloseTo(0.9)
    expect(r.w).toBeCloseTo(0.2)
    const tiny = dragShapeBox(box, 'e', -1, 0)
    expect(tiny.w).toBeGreaterThan(0)
  })

  it('resizes a cursor spotlight around its centre, never below a minimum', () => {
    expect(resizeAround({ w: 0.2, h: 0.2 }, 'se', 0.05, 0.1)).toEqual({ w: 0.30000000000000004, h: 0.4 })
    expect(resizeAround({ w: 0.2, h: 0.2 }, 'nw', 0.05, 0.05).w).toBeCloseTo(0.1)
    const min = resizeAround({ w: 0.2, h: 0.2 }, 'e', -5, 0)
    expect(min.w).toBe(MIN_SHAPE_SIDE * 2)
    expect(resizeAround({ w: 0.9, h: 0.2 }, 'e', 5, 0).w).toBe(1)
  })

  it('moves lines without pushing an end out of the recording', () => {
    const line = { x: 0.8, y: 0.2, w: 0.15, h: -0.15 }
    const moved = moveLine(line, 0.2, -0.3)
    expect(moved.x + moved.w).toBeCloseTo(1)
    expect(moved.y + moved.h).toBeCloseTo(0)
    expect([moved.w, moved.h]).toEqual([line.w, line.h])
  })

  it('moves one end of a line, keeping the other', () => {
    const line = { x: 0.2, y: 0.2, w: 0.3, h: 0.1 }
    const end = setLineEnd(line, 'end', { x: 0.9, y: 1.4 })
    expect(end).toEqual({ x: 0.2, y: 0.2, w: 0.7, h: 0.8 })
    const start = setLineEnd(line, 'start', { x: 0.6, y: 0.5 })
    expect(start.x + start.w).toBeCloseTo(0.5)
    expect(start.y + start.h).toBeCloseTo(0.3)
    expect([start.x, start.y]).toEqual([0.6, 0.5])
  })

  it('draws lines end to end and boxes of at least a minimum size', () => {
    expect(drawnGeometry('arrow', { x: 0.7, y: 0.6 }, { x: 0.2, y: 1.3 })).toEqual({ x: 0.7, y: 0.6, w: -0.49999999999999994, h: 0.4 })
    const b = drawnGeometry('rect', { x: 0.7, y: 0.6 }, { x: 0.2, y: 0.4 })
    expect(b.x).toBeCloseTo(0.2)
    expect(b.y).toBeCloseTo(0.4)
    expect(b.w).toBeCloseTo(0.5)
    expect(b.h).toBeCloseTo(0.2)
    const dot = drawnBox({ x: 0.999, y: 0.5 }, { x: 0.999, y: 0.5 })
    expect(dot.w).toBeCloseTo(MIN_SHAPE_SIDE)
    expect(dot.x + dot.w).toBeLessThanOrEqual(1)
  })

  it('duplicates with a new id, shifted but still inside the recording', () => {
    const s = createShape('rect', 1, 10, { x: 0.8, y: 0.1, w: 0.2, h: 0.2 })
    const d = duplicateItem(s)
    expect(d.id).not.toBe(s.id)
    expect(d.x + d.w).toBeLessThanOrEqual(1)
    expect(d.y).toBeGreaterThan(s.y)
    expect([d.start, d.end, d.kind]).toEqual([s.start, s.end, s.kind])
    const sp = createSpotlight('region', 1, 10)
    expect(duplicateItem(sp).id.startsWith('l')).toBe(true)
  })
})

describe('timeline', () => {
  it('moves within the recording and resizes with a minimum length', () => {
    expect(dragShapeTimes({ start: 2, end: 4 }, 'move', 100, 10)).toEqual({ start: 8, end: 10 })
    expect(dragShapeTimes({ start: 2, end: 4 }, 'move', -100, 10)).toEqual({ start: 0, end: 2 })
    expect(dragShapeTimes({ start: 2, end: 4 }, 'start', 5, 10).start).toBeCloseTo(4 - MIN_SHAPE_LENGTH)
    expect(dragShapeTimes({ start: 2, end: 4 }, 'end', -5, 10).end).toBeCloseTo(2 + MIN_SHAPE_LENGTH)
    expect(dragShapeTimes({ start: 0.1, end: 0.2 }, 'start', 1, 10).start).toBeCloseTo(0.1)
  })

  it('typed times keep the item at least the minimum length, inside the recording', () => {
    expect(setItemTime({ start: 2, end: 4 }, 'start', 5, 10)).toEqual({ start: 5, end: 5.3 })
    expect(setItemTime({ start: 2, end: 4 }, 'start', -1, 10)).toEqual({ start: 0, end: 4 })
    expect(setItemTime({ start: 2, end: 4 }, 'end', 1, 10)).toEqual({ start: 0.7, end: 1 })
    expect(setItemTime({ start: 2, end: 4 }, 'end', 50, 10)).toEqual({ start: 2, end: 10 })
    expect(setItemTime({ start: 2, end: 4 }, 'start', 10, 10)).toEqual({ start: 9.7, end: 10 })
  })

  it('stacks overlapping items in lanes', () => {
    const r = itemLanes([
      { id: 'a', start: 0, end: 3 },
      { id: 'b', start: 1, end: 2 },
      { id: 'c', start: 3, end: 4 },
      { id: 'd', start: 1.5, end: 5 }
    ])
    expect(r.count).toBe(3)
    expect(r.lanes.get('a')).toBe(0)
    expect(r.lanes.get('b')).toBe(1)
    expect(r.lanes.get('c')).toBe(0)
    expect(r.lanes.get('d')).toBe(2)
    expect(itemLanes([]).count).toBe(1)
  })
})

describe('reading shapes', () => {
  it('fills in defaults and drops shapes that cannot be drawn', () => {
    expect(readShape({ id: 'x', kind: 'rect', start: 0, end: 1, x: 0, y: 0, w: 0.5, h: 0.5 } as Partial<Shape>)).toMatchObject({
      color: '#ff3b30',
      strokeWidth: 6,
      fill: false,
      opacity: 1,
      strength: 0.5
    })
    expect(readShape({ kind: 'star' as never, start: 0, end: 1, x: 0, y: 0, w: 1, h: 1 })).toBeNull()
    expect(readShape({ kind: 'rect', start: 2, end: 1, x: 0, y: 0, w: 1, h: 1 })).toBeNull()
    expect(readShape({ kind: 'rect', start: 0, end: 1, x: NaN, y: 0, w: 1, h: 1 })).toBeNull()
    expect(readShape(null)).toBeNull()
    expect(readShape({ kind: 'blur', start: 0, end: 1, x: 0, y: 0, w: 1, h: 1, strength: 7, opacity: -1, color: 'red' })).toMatchObject({ strength: 1, opacity: 0, color: '#ff3b30' })
    expect(readSpotlight({ mode: 'cursor', start: 0, end: 2 })).toMatchObject({ shape: 'ellipse', dim: 0.6, feather: 0.4 })
    expect(readSpotlight({ mode: 'spot' as never, start: 0, end: 2 })).toBeNull()
  })

  it('older projects have none; lists are read once', () => {
    expect(projectShapes({})).toEqual([])
    expect(projectSpotlights({ spotlights: undefined })).toEqual([])
    const list = [createShape('arrow', 0, 5), { kind: 'nope' } as unknown as Shape]
    const a = projectShapes({ shapes: list })
    expect(a).toHaveLength(1)
    expect(projectShapes({ shapes: list })).toBe(a)
  })
})

describe('timing', () => {
  const arrow = { kind: 'arrow' as const, start: 2, end: 5 }
  const blur = { kind: 'blur' as const, start: 2, end: 5 }

  it('annotation shapes fade in and out over SHAPE_FADE of viewing time', () => {
    expect(shapeAlpha(arrow, 1.99)).toBe(0)
    expect(shapeAlpha(arrow, 2)).toBe(0)
    expect(shapeAlpha(arrow, 2 + SHAPE_FADE / 2)).toBeCloseTo(0.5)
    expect(shapeAlpha(arrow, 3)).toBe(1)
    expect(shapeAlpha(arrow, 5 - SHAPE_FADE / 2)).toBeCloseTo(0.5)
    expect(shapeAlpha(arrow, 5)).toBe(0)
    // At 2x one output second covers two source seconds: the fade is twice as long in source time.
    expect(shapeAlpha(arrow, 2 + SHAPE_FADE / 2, 2)).toBeCloseTo(0.25)
  })

  it('privacy shapes are fully applied for their whole range, even at its first frame', () => {
    expect(shapeAlpha(blur, 2)).toBe(1)
    expect(shapeAlpha(blur, 4.999)).toBe(1)
    expect(shapeAlpha(blur, 5)).toBe(0)
    expect(shapeAlpha(blur, 1.999)).toBe(0)
  })

  it('spotlights ease in and out', () => {
    const s = { start: 1, end: 3 }
    expect(spotlightAlpha(s, 1)).toBe(0)
    expect(spotlightAlpha(s, 1 + SPOTLIGHT_FADE / 2)).toBeCloseTo(0.5)
    expect(spotlightAlpha(s, 1 + SPOTLIGHT_FADE / 4)).toBeLessThan(0.25)
    expect(spotlightAlpha(s, 2)).toBe(1)
    expect(spotlightAlpha(s, 3)).toBe(0)
  })
})

describe('privacy maths', () => {
  it('blur radius and mosaic cells grow with strength, relative to the recording', () => {
    expect(blurSigma(1, 1080)).toBeGreaterThan(blurSigma(0, 1080))
    expect(blurSigma(0.5, 2160)).toBeCloseTo(2 * blurSigma(0.5, 1080))
    // Even the weakest blur hides 1080p text (strokes of a few pixels).
    expect(blurSigma(0, 1080)).toBeGreaterThanOrEqual(5)
    expect(pixelCell(1, 1080)).toBeGreaterThan(pixelCell(0, 1080))
    expect(pixelCell(0, 10)).toBe(2)
    expect(blurSigma(5, 1080)).toBe(blurSigma(1, 1080))
  })

  it('blurs on a reduced copy with a margin that hides the edge', () => {
    const p = blurPlan(20, 400, 300)
    expect(p.sigma).toBeCloseTo(2.5)
    expect(p.scale).toBeCloseTo(0.125)
    expect(p.margin).toBeGreaterThanOrEqual(Math.ceil(p.sigma * 3))
    expect(blurPlan(1, 100, 100).scale).toBe(1)
    const big = blurPlan(3, 8000, 100, 2.5, 1024)
    expect(8000 * big.scale).toBeCloseTo(1024)
  })

  it('a mosaic has at least one cell and a bounded grid', () => {
    expect(pixelGrid(400, 200, 20)).toEqual({ cols: 20, rows: 10 })
    expect(pixelGrid(5, 5, 50)).toEqual({ cols: 1, rows: 1 })
    expect(pixelGrid(1e6, 10, 1, 512).cols).toBe(512)
  })

  it('clips boxes to the recording', () => {
    expect(clipToUnit({ x: -0.2, y: 0.5, w: 0.4, h: 0.8 })).toEqual({ x: 0, y: 0.5, w: 0.2, h: 0.5 })
    expect(clipToUnit({ x: 1.1, y: 0, w: 0.2, h: 0.2 })).toBeNull()
    const neg = clipToUnit({ x: 0.5, y: 0.5, w: -0.2, h: -0.2 })
    expect(neg!.x).toBeCloseTo(0.3)
    expect(neg!.w).toBeCloseTo(0.2)
  })

  it('covers where every motion-blur sub-frame puts the box', () => {
    const box = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }
    const cam: Camera = { scale: 2, cx: 0.5, cy: 0.5 }
    const same = sweptBox(box, cam, [cam, cam])
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(same[k]).toBeCloseTo(box[k], 12)
    const other: Camera = { scale: 2.2, cx: 0.55, cy: 0.5 }
    const swept = sweptBox(box, cam, [other])
    // Where the other camera puts the box on screen, in this camera's source units.
    const vx = cam.cx - 0.5 / cam.scale
    const ox = other.cx - 0.5 / other.scale
    const x0 = vx + ((box.x - ox) * other.scale) / cam.scale
    const x1 = vx + ((box.x + box.w - ox) * other.scale) / cam.scale
    expect(swept.x).toBeCloseTo(Math.min(box.x, x0))
    expect(swept.x + swept.w).toBeCloseTo(Math.max(box.x + box.w, x1))
    expect(swept.w).toBeGreaterThan(box.w)
  })
})

describe('arrows', () => {
  it('has its tip at the end and a head proportional to the width', () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 200, y: 0 }, 10)!
    expect(g.head[0]).toEqual({ x: 200, y: 0 })
    expect(g.points).toHaveLength(7)
    // Head 34 px long, about 39 px wide, centred on the shaft.
    expect(g.head[1].x).toBeCloseTo(166)
    expect(Math.abs(g.head[1].y - g.head[2].y)).toBeCloseTo(34 * 0.58 * 2)
    expect(g.radius).toBe(5)
    expect(g.angle).toBeCloseTo(0)
  })

  it('shrinks the head on short arrows and has no geometry without length', () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 0, y: 20 }, 10)!
    expect(g.head[1].y).toBeCloseTo(8)
    expect(g.angle).toBeCloseTo(Math.PI / 2)
    expect(arrowGeometry({ x: 5, y: 5 }, { x: 5, y: 5.1 }, 10)).toBeNull()
    expect(arrowGeometry({ x: 0, y: 0 }, { x: 50, y: 0 }, 0)).toBeNull()
    // A minimum head for thin strokes.
    expect(arrowGeometry({ x: 0, y: 0 }, { x: 200, y: 0 }, 1, 14)!.head[1].x).toBeCloseTo(186)
  })
})

describe('spotlight', () => {
  const clips: Clip[] = [{ id: 'c', start: 0, end: 10, speed: 1 }]
  const path = { at: (t: number) => ({ x: t / 10, y: 0.5 }) }

  it('follows the cursor the cursor layer draws', () => {
    expect(cursorPositionAt(path, clips, false, 4)).toEqual({ x: 0.4, y: 0.5 })
    // Loop home: back at the start position at the very end.
    const end = cursorPositionAt(path, clips, true, 10)
    expect(end.x).toBeCloseTo(0)
    expect(cursorPositionAt(path, clips, true, 2).x).toBeCloseTo(0.2)
  })

  it('follows the cursor viewers see: the drawn one, or the real one baked into the video', () => {
    const samples = [
      { t: 0, x: 0.1, y: 0.5 },
      { t: 10, x: 0.9, y: 0.5 }
    ]
    // A smoothed path lagging behind the recorded position.
    const lagging = { at: (t: number) => ({ x: Math.max(0.1, 0.1 + 0.08 * (t - 1)), y: 0.5 }) }
    const cursor = { show: true, size: 1, smoothing: 0.6, clickEffect: false, hideWhenIdle: false }
    const synthetic = { capture: { method: 'native' as const, cursorInVideo: false, region: null }, cursor, clips }
    const baked = { ...synthetic, capture: { method: 'chromium' as const, cursorInVideo: true, region: null } }
    expect(visibleCursorAt(synthetic, samples, lagging, 5)!.x).toBeCloseTo(0.42)
    expect(visibleCursorAt(baked, samples, lagging, 5)!.x).toBeCloseTo(0.5)
    // Loop home moves the drawn cursor only: the one in the video cannot glide home.
    const home = { ...cursor, loopHome: true }
    expect(visibleCursorAt({ ...synthetic, cursor: home }, samples, path, 10)!.x).toBeCloseTo(0)
    expect(visibleCursorAt({ ...baked, cursor: home }, samples, path, 10)!.x).toBeCloseTo(0.9)
    // Older projects without capture info use the drawn cursor; no samples, no position.
    expect(visibleCursorAt({ cursor, clips } as Parameters<typeof visibleCursorAt>[0], samples, lagging, 5)!.x).toBeCloseTo(0.42)
    expect(visibleCursorAt(baked, [], lagging, 5)).toBeNull()
  })

  it('lights its box, or the same size around the cursor', () => {
    const s: Pick<Spotlight, 'mode' | 'x' | 'y' | 'w' | 'h'> = { mode: 'cursor', x: 0.1, y: 0.1, w: 0.2, h: 0.4 }
    expect(spotlightArea(s, { x: 0.5, y: 0.5 })).toEqual({ x: 0.4, y: 0.3, w: 0.2, h: 0.4 })
    expect(spotlightArea(s, null)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.4 })
    expect(spotlightArea({ ...s, mode: 'region' }, { x: 0.5, y: 0.5 })).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.4 })
  })

  it('feathers relative to the lit area', () => {
    expect(spotlightFeather(0.5, 100, 40)).toBe(20)
    expect(spotlightFeather(2, 100, 40)).toBe(40)
    expect(spotlightFeather(-1, 100, 40)).toBe(0)
  })

  it('builds feathered rectangles from whole pixels', () => {
    const { inner, outer } = featherRects(100.3, 50.6, 40, 20, 10)
    for (const v of [...Object.values(inner), ...Object.values(outer)]) expect(Number.isInteger(v)).toBe(true)
    expect(outer.x0).toBe(Math.round(100.3 - 45))
    expect(inner.x0).toBe(Math.round(100.3 - 35))
    expect(inner.x0).toBeGreaterThan(outer.x0)
    expect(inner.y1).toBeLessThan(outer.y1)
    // A feather wider than the area collapses the core onto the centre.
    const wide = featherRects(50, 50, 10, 4, 30)
    expect(wide.inner.y0).toBe(wide.inner.y1)
    expect(wide.inner.x0).toBe(wide.inner.x1)
    const hard = featherRects(50, 50, 10, 10, 0)
    expect(hard.inner).toEqual(hard.outer)
  })

  it('combines several spotlights: the darkest sets the level, each clears its own area', () => {
    expect(spotlightLevels([{ dim: 0.6, alpha: 1 }])).toEqual({ dim: 0.6, clear: [1] })
    const two = spotlightLevels([
      { dim: 0.6, alpha: 1 },
      { dim: 0.6, alpha: 0.5 }
    ])
    expect(two.dim).toBeCloseTo(0.6)
    expect(two.clear[0]).toBeCloseTo(1)
    expect(two.clear[1]).toBeCloseTo(0.5)
    expect(spotlightLevels([{ dim: 0.6, alpha: 0 }])).toEqual({ dim: 0, clear: [0] })
  })

  it('a lighter spotlight still lights its whole area next to a darker one', () => {
    // Darkness left in an area: the overall level times what its clearing leaves.
    const left = (l: { dim: number; clear: number[] }, i: number): number => l.dim * (1 - l.clear[i])
    for (const dimB of [0.3, 0.1, 0]) {
      const l = spotlightLevels([
        { dim: 0.7, alpha: 1 },
        { dim: dimB, alpha: 1 }
      ])
      expect(l.dim).toBeCloseTo(0.7)
      expect(left(l, 0)).toBeCloseTo(0)
      expect(left(l, 1)).toBeCloseTo(0)
    }
    // Fading out, an area darkens gradually up to the others' level.
    const fading = [1, 0.75, 0.5, 0.25, 0].map((a) =>
      left(
        spotlightLevels([
          { dim: 0.7, alpha: 1 },
          { dim: 0.3, alpha: a }
        ]),
        1
      )
    )
    for (let i = 1; i < fading.length; i++) expect(fading[i]).toBeGreaterThan(fading[i - 1])
    expect(fading[fading.length - 1]).toBeCloseTo(0.7)
    // The darker one fading out: the level eases down to the lighter one's, its area stays lit.
    const l = spotlightLevels([
      { dim: 0.7, alpha: 0.2 },
      { dim: 0.3, alpha: 1 }
    ])
    expect(l.dim).toBeCloseTo(0.3)
    expect(left(l, 1)).toBeCloseTo(0)
  })
})
