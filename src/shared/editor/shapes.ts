import { clamp } from '../engine/math'
import { keptBounds } from '../engine/timeline'
import type { Clip, Shape, ShapeKind, Spotlight } from '../types'
import { dragRegion, type Box, type RegionHandle } from './zoomEdit'

/** Default length (seconds) of a new shape or spotlight. */
export const DEFAULT_SHAPE_LENGTH = 3
/** Shortest shape or spotlight a timeline drag can make (seconds). */
export const MIN_SHAPE_LENGTH = 0.3
/** Smallest side of a box drawn or resized on the preview (normalised). */
export const MIN_SHAPE_SIDE = 0.02
/** Seconds (viewing time) an annotation shape takes to fade in and out. */
export const SHAPE_FADE = 0.15
/** Seconds (viewing time) a spotlight takes to fade in and out. */
export const SPOTLIGHT_FADE = 0.25
/** Stroke widths the editor offers (1080p-referenced pixels). */
export const STROKE_LIMITS = { min: 1, max: 24 }

export const SHAPE_COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#111111']
export const HIGHLIGHT_COLORS = ['#ffd60a', '#a3e635', '#f472b6', '#38bdf8', '#fb923c']

export const SHAPE_KINDS: { kind: ShapeKind; label: string; title: string }[] = [
  { kind: 'arrow', label: 'Arrow', title: 'Point at something' },
  { kind: 'line', label: 'Line', title: 'A straight line, e.g. to underline' },
  { kind: 'rect', label: 'Box', title: 'An outlined or filled box' },
  { kind: 'ellipse', label: 'Ellipse', title: 'Circle something' },
  { kind: 'highlight', label: 'Marker', title: 'A translucent highlighter box' },
  { kind: 'blur', label: 'Blur', title: 'Blur private content (always fully applied)' },
  { kind: 'pixelate', label: 'Pixelate', title: 'Pixelate private content (always fully applied)' }
]

export const shapeLabel = (kind: ShapeKind): string => SHAPE_KINDS.find((k) => k.kind === kind)?.label ?? 'Shape'

/** Blur and pixelate hide content: they never fade and are drawn under the cursor. */
export const isPrivacyKind = (kind: ShapeKind): boolean => kind === 'blur' || kind === 'pixelate'
/** Arrows and lines go from (x, y) to (x + w, y + h); every other kind fills its box. */
export const isLineKind = (kind: ShapeKind): boolean => kind === 'arrow' || kind === 'line'
/** Kinds whose outline width can be set (boxes and ellipses only when not filled). */
export const hasStroke = (s: Pick<Shape, 'kind' | 'fill'>): boolean => isLineKind(s.kind) || ((s.kind === 'rect' || s.kind === 'ellipse') && !s.fill)

/** Geometry and look a new shape of each kind starts with (before the caller's `init`). */
const KIND_DEFAULTS: Record<ShapeKind, Partial<Shape>> = {
  // Down and to the right, ending a little left of the middle: points at the centre.
  arrow: { x: 0.3, y: 0.28, w: 0.16, h: 0.17, strokeWidth: 10 },
  line: { x: 0.35, y: 0.62, w: 0.3, h: 0, strokeWidth: 8 },
  rect: {},
  ellipse: {},
  highlight: { x: 0.3, y: 0.45, w: 0.4, h: 0.1, color: '#ffd60a', opacity: 0.55 },
  blur: { x: 0.35, y: 0.4, w: 0.3, h: 0.2, color: '#000000' },
  pixelate: { x: 0.35, y: 0.4, w: 0.3, h: 0.2, color: '#000000' }
}

let idCounter = 0
const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** Times of a new item at `t`: DEFAULT_SHAPE_LENGTH long, moved back to keep that length near the end. */
function newItemTimes(t: number, duration: number): { start: number; end: number } {
  const length = Math.min(DEFAULT_SHAPE_LENGTH, Math.max(0, duration))
  const start = clamp(t, 0, Math.max(0, duration - length))
  return { start, end: Math.min(duration, start + length) }
}

/**
 * A new shape of `kind` starting at source time `t`, inside the recording's `duration` (one
 * made near the end starts earlier, so it keeps its full length).
 */
export function createShape(kind: ShapeKind, t: number, duration: number, init: Partial<Omit<Shape, 'id' | 'kind'>> = {}): Shape {
  return {
    id: newId('s'),
    kind,
    ...newItemTimes(t, duration),
    x: 0.35,
    y: 0.35,
    w: 0.3,
    h: 0.3,
    color: '#ff3b30',
    strokeWidth: 6,
    fill: false,
    opacity: 1,
    strength: 0.5,
    ...KIND_DEFAULTS[kind],
    ...init
  }
}

/** A new spotlight starting at source time `t` (like createShape, it keeps its full length near the end). */
export function createSpotlight(mode: Spotlight['mode'], t: number, duration: number, init: Partial<Omit<Spotlight, 'id' | 'mode'>> = {}): Spotlight {
  return {
    id: newId('l'),
    mode,
    ...newItemTimes(t, duration),
    x: 0.3,
    y: 0.3,
    w: 0.4,
    h: 0.4,
    shape: 'ellipse',
    dim: 0.6,
    feather: 0.4,
    // Around the cursor: a lit area about a fifth of the frame high, round on screen.
    ...(mode === 'cursor' ? { x: 0.4, y: 0.4, w: 0.2 * (9 / 16), h: 0.2 } : {}),
    ...init
  }
}

/**
 * Where an arrow made at the playhead goes when the cursor's position `p` is known: its tip
 * just beside the cursor, coming in from the side nearer the middle so it stays in frame.
 * `aspect` is the recording's width / height (the arrow is drawn at about 45 degrees).
 */
export function arrowToward(p: { x: number; y: number }, aspect = 16 / 9): Pick<Shape, 'x' | 'y' | 'w' | 'h'> {
  const len = 0.16
  const sx = p.x > 0.5 ? 1 : -1
  const sy = p.y > 0.5 ? 1 : -1
  const dx = (len / Math.SQRT2) * sx
  const dy = ((len * clamp(aspect, 0.3, 4)) / Math.SQRT2) * sy
  // A small gap, so the arrowhead does not cover the cursor.
  const gap = 0.012
  const tipX = clamp(p.x - sx * gap, 0, 1)
  const tipY = clamp(p.y - sy * gap * aspect, 0, 1)
  const x = clamp(tipX - dx, 0, 1)
  const y = clamp(tipY - dy, 0, 1)
  return { x, y, w: tipX - x, h: tipY - y }
}

/** Seconds of source time before `t` a new item starts so it is fully faded in at `t` (`speed`: the clip's speed). */
export const fadeLead = (kind: ShapeKind | 'spotlight', speed = 1): number => (kind === 'spotlight' ? SPOTLIGHT_FADE : isPrivacyKind(kind) ? 0 : SHAPE_FADE) * speed

/**
 * Start and end of a new item for the playhead at `t`: DEFAULT_SHAPE_LENGTH long, starting
 * `lead` seconds earlier so it is fully faded in at `t`, and inside the kept part of the
 * recording. Near the end (where the playhead rests after playing through) it starts earlier
 * instead of getting shorter, so it keeps its full length and is never cut off by a trailing cut.
 */
export function playheadTimes(t: number, lead: number, project: { duration: number; clips?: Clip[] }): { start: number; end: number } {
  const { duration } = project
  let lo = 0
  let hi = Math.max(0, duration)
  if (project.clips && project.clips.length > 0) {
    const kept = keptBounds(project.clips)
    const a = clamp(kept.start, 0, hi)
    const b = clamp(kept.end, a, hi)
    if (b - a >= MIN_SHAPE_LENGTH) {
      lo = a
      hi = b
    }
  }
  const length = Math.min(DEFAULT_SHAPE_LENGTH, hi - lo)
  const start = clamp(t - lead, lo, hi - length)
  return { start, end: start + length }
}

/**
 * A new shape for the playhead at `t`: fully shown there (see playheadTimes), and an arrow
 * points at the cursor when its position `cursor` is known.
 */
export function shapeForPlayhead(
  kind: ShapeKind,
  t: number,
  project: { duration: number; width: number; height: number; clips?: Clip[] },
  cursor: { x: number; y: number } | null,
  speed = 1
): Shape {
  const init = kind === 'arrow' && cursor ? arrowToward(cursor, project.width / project.height) : {}
  return createShape(kind, t, project.duration, { ...init, ...playheadTimes(t, fadeLead(kind, speed), project) })
}

/** A new spotlight for the playhead at `t`: fully faded in there; around the cursor it is round on screen. */
export function spotlightForPlayhead(mode: Spotlight['mode'], t: number, project: { duration: number; width: number; height: number; clips?: Clip[] }, speed = 1): Spotlight {
  const init = mode === 'cursor' ? { w: 0.24 / (project.width / project.height), h: 0.24 } : {}
  return createSpotlight(mode, t, project.duration, { ...init, ...playheadTimes(t, fadeLead('spotlight', speed), project) })
}

/**
 * Where to put the playhead so `item` shows fully on the preview (past its fade-in and before
 * its fade-out, `fade` source seconds each), as near `t` as possible: `t` itself when it
 * already does. An item too short to ever show fully gets its middle.
 */
export function revealTime(item: { start: number; end: number }, t: number, fade: number): number {
  const pad = 0.01
  const lo = item.start + fade
  // The end itself is not shown (items are end-exclusive).
  const hi = item.end - Math.max(fade, pad)
  if (t >= lo - 1e-6 && t <= hi) return t
  if (hi - lo < 2 * pad) return (item.start + item.end) / 2
  return clamp(t, lo + pad, hi - pad)
}

/* ---------- geometry on the preview ---------- */

/** The box a shape covers (arrows and lines: the box around both ends), with positive sides. */
export function shapeBounds(s: Pick<Shape, 'x' | 'y' | 'w' | 'h'>): Box {
  return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }
}

/** A box shape or a region spotlight after dragging `handle` by (dx, dy): kept inside the recording. */
export function dragShapeBox(box: Box, handle: RegionHandle, dx: number, dy: number, keepShape = false): Box {
  return dragRegion(shapeBounds(box), handle, dx, dy, keepShape)
}

/**
 * A cursor spotlight's lit area after dragging a handle by (dx, dy): it stays centred on the
 * cursor, so it grows on both sides at once.
 */
export function resizeAround(box: Pick<Box, 'w' | 'h'>, handle: RegionHandle, dx: number, dy: number): Pick<Box, 'w' | 'h'> {
  let { w, h } = box
  if (handle.includes('e')) w += 2 * dx
  if (handle.includes('w')) w -= 2 * dx
  if (handle.includes('s')) h += 2 * dy
  if (handle.includes('n')) h -= 2 * dy
  return { w: clamp(w, MIN_SHAPE_SIDE * 2, 1), h: clamp(h, MIN_SHAPE_SIDE * 2, 1) }
}

/** Moves an arrow or line by (dx, dy), keeping both ends inside the recording. */
export function moveLine(s: Pick<Shape, 'x' | 'y' | 'w' | 'h'>, dx: number, dy: number): Pick<Shape, 'x' | 'y' | 'w' | 'h'> {
  const b = shapeBounds(s)
  const mx = clamp(dx, -b.x, 1 - (b.x + b.w))
  const my = clamp(dy, -b.y, 1 - (b.y + b.h))
  return { x: s.x + mx, y: s.y + my, w: s.w, h: s.h }
}

/** An arrow or line with one end moved to `p` (inside the recording); the other end stays. */
export function setLineEnd(s: Pick<Shape, 'x' | 'y' | 'w' | 'h'>, end: 'start' | 'end', p: { x: number; y: number }): Pick<Shape, 'x' | 'y' | 'w' | 'h'> {
  const px = clamp(p.x, 0, 1)
  const py = clamp(p.y, 0, 1)
  if (end === 'end') return { x: s.x, y: s.y, w: px - s.x, h: py - s.y }
  const ex = s.x + s.w
  const ey = s.y + s.h
  return { x: px, y: py, w: ex - px, h: ey - py }
}

/** A shape drawn anew by dragging from `a` to `b` on the preview: ends for lines, a box otherwise. */
export function drawnGeometry(kind: ShapeKind, a: { x: number; y: number }, b: { x: number; y: number }): Pick<Shape, 'x' | 'y' | 'w' | 'h'> {
  const ax = clamp(a.x, 0, 1)
  const ay = clamp(a.y, 0, 1)
  const bx = clamp(b.x, 0, 1)
  const by = clamp(b.y, 0, 1)
  if (isLineKind(kind)) return { x: ax, y: ay, w: bx - ax, h: by - ay }
  return drawnBox(a, b)
}

/** The box spanned by two points (inside the recording, at least MIN_SHAPE_SIDE on each side). */
export function drawnBox(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  const x0 = clamp(Math.min(a.x, b.x), 0, 1 - MIN_SHAPE_SIDE)
  const y0 = clamp(Math.min(a.y, b.y), 0, 1 - MIN_SHAPE_SIDE)
  const x1 = clamp(Math.max(a.x, b.x), x0 + MIN_SHAPE_SIDE, 1)
  const y1 = clamp(Math.max(a.y, b.y), y0 + MIN_SHAPE_SIDE, 1)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** A copy of a shape or spotlight (new id) a little lower right, so both stay visible. */
export function duplicateItem<T extends Shape | Spotlight>(item: T): T {
  const off = 0.03
  const b = shapeBounds(item)
  const dx = b.x + b.w + off <= 1 ? off : -Math.min(off, b.x)
  const dy = b.y + b.h + off <= 1 ? off : -Math.min(off, b.y)
  return { ...item, id: newId('kind' in item ? 's' : 'l'), x: item.x + dx, y: item.y + dy }
}

/* ---------- timeline ---------- */

/** New start/end for a move or edge drag on the timeline; shapes may overlap each other freely. */
export function dragShapeTimes(initial: { start: number; end: number }, mode: 'move' | 'start' | 'end', dt: number, duration: number): { start: number; end: number } {
  let { start, end } = initial
  // An item already shorter than the minimum may grow but not shrink further.
  const short = end - start < MIN_SHAPE_LENGTH
  if (mode === 'move') {
    const len = end - start
    start = clamp(start + dt, 0, Math.max(0, duration - len))
    end = start + len
  } else if (mode === 'start') {
    start = clamp(start + dt, Math.min(0, start), short ? start : end - MIN_SHAPE_LENGTH)
  } else {
    end = clamp(end + dt, short ? end : start + MIN_SHAPE_LENGTH, Math.max(duration, end))
  }
  return { start, end }
}

/** New start or end typed in the inspector, keeping the item at least MIN_SHAPE_LENGTH long. */
export function setItemTime(item: { start: number; end: number }, edge: 'start' | 'end', t: number, duration: number): { start: number; end: number } {
  const len = Math.min(MIN_SHAPE_LENGTH, duration)
  if (edge === 'start') {
    const start = clamp(t, 0, Math.max(0, duration - len))
    return { start, end: Math.max(item.end, start + len) }
  }
  const end = clamp(t, len, duration)
  return { start: Math.min(item.start, end - len), end }
}

/**
 * Assigns overlapping items to stacked lanes (greedy interval partitioning), so every one of
 * them stays visible and grabbable on the timeline.
 */
export function itemLanes(items: { id: string; start: number; end: number }[]): { lanes: Map<string, number>; count: number } {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end)
  const laneEnds: number[] = []
  const lanes = new Map<string, number>()
  for (const a of sorted) {
    let lane = laneEnds.findIndex((end) => end <= a.start + 1e-9)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(a.end)
    } else {
      laneEnds[lane] = a.end
    }
    lanes.set(a.id, lane)
  }
  return { lanes, count: Math.max(1, laneEnds.length) }
}

export const itemVisibleAt = (item: { start: number; end: number }, t: number): boolean => t >= item.start && t < item.end
