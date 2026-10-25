/**
 * The 3D tilt of the recording card ("product shot"): the settings in effect, how they move
 * over time, and where the tilted card lands in the output frame. Pure: the compositor warps
 * the card with WebGL along the quad computed here (render/tiltLayer.ts), and the e2e tests
 * check exported frames against it.
 *
 * Coordinates are output pixels, y down, z pointing away from the viewer. The card is first
 * tilted about its horizontal axis (rotateX > 0: the top goes away), then turned about the
 * vertical one (rotateY > 0: the right edge goes away), about its own centre, and seen through
 * a camera straight in front of that centre: like CSS `perspective(d) rotateY(y) rotateX(x)`.
 */
import type { CameraLayout, Corner, Project, TiltSettings, ZoomSegment } from '../types'
import { layoutGeometry, layoutPhaseAt, type Rect, type SceneProject } from './layout'
import { clamp, easeInOutCubic, lerp } from './math'
import { aimAt, DEFAULT_ZOOM_STYLE, type Camera, type ZoomStyle } from './zoom'

export const TILT_LIMITS = {
  angle: { min: -30, max: 30 },
  perspective: { min: 0, max: 1 }
} as const

export type TiltAnimation = TiltSettings['animate']
export const TILT_ANIMATIONS: readonly TiltAnimation[] = ['none', 'cursor', 'zoom']

/** The pose of a tilt: its angles (degrees) and perspective strength (0..1). */
export type TiltAngles = Pick<TiltSettings, 'rotateX' | 'rotateY' | 'perspective'>

export interface TiltPreset {
  id: string
  label: string
  title: string
  angles: TiltAngles
}

export const TILT_PRESETS: readonly TiltPreset[] = [
  { id: 'left', label: 'Left', title: 'Turned to the left', angles: { rotateX: 6, rotateY: -20, perspective: 0.55 } },
  { id: 'right', label: 'Right', title: 'Turned to the right', angles: { rotateX: 6, rotateY: 20, perspective: 0.55 } },
  { id: 'top', label: 'Top', title: 'Seen from above, like a laptop on a desk', angles: { rotateX: 24, rotateY: 0, perspective: 0.5 } },
  { id: 'hero', label: 'Hero', title: 'A dramatic product shot from the side and above', angles: { rotateX: 16, rotateY: -14, perspective: 0.7 } }
]

/** What a tilt starts as when it is first switched on: the Hero preset, standing still. */
export const DEFAULT_TILT: TiltSettings = { enabled: false, ...TILT_PRESETS[3].angles, animate: 'none' }

/** Most degrees the 'cursor' animation adds on each axis, for a cursor at the edge of the view. */
export const CURSOR_LEAN = 5
/** Zoom level at which the 'zoom' animation has flattened the card completely. */
export const ZOOM_FLAT_SCALE = 1.3
/** At perspective 1 the camera is this many card lengths (its longer side) in front of the card. */
export const NEAREST_CAMERA = 1
/** Angles never exceed this, animation included, so every point of the card stays in front of the camera. */
const MAX_ANGLE = 40

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const angle = (v: unknown, fallback: number): number => (finite(v) ? clamp(v, TILT_LIMITS.angle.min, TILT_LIMITS.angle.max) : fallback)

/**
 * A stored tilt with every field usable: clamped angles and perspective, defaults for missing or
 * malformed fields (it is on only when `enabled` is exactly true). Undefined when there is none.
 */
export function readTilt(raw: unknown): TiltSettings | undefined {
  if (!isObject(raw)) return undefined
  const d = DEFAULT_TILT
  return {
    enabled: raw.enabled === true,
    rotateX: angle(raw.rotateX, d.rotateX),
    rotateY: angle(raw.rotateY, d.rotateY),
    perspective: finite(raw.perspective) ? clamp(raw.perspective, TILT_LIMITS.perspective.min, TILT_LIMITS.perspective.max) : d.perspective,
    animate: TILT_ANIMATIONS.includes(raw.animate as TiltAnimation) ? (raw.animate as TiltAnimation) : 'none'
  }
}

const inEffect = new WeakMap<object, TiltSettings | null>()

/** The project's tilt when it is on (read as readTilt does, once per settings object), else null. */
export function tiltOf(project: Pick<Project, 'tilt'>): TiltSettings | null {
  const raw = project.tilt
  if (!raw || raw.enabled !== true) return null
  let t = inEffect.get(raw)
  if (t === undefined) {
    t = readTilt(raw) ?? null
    inEffect.set(raw, t)
  }
  return t
}

/** The project's tilt settings for editing (on or off), with defaults when it never had one. */
export const tiltSettingsOf = (project: Pick<Project, 'tilt'>): TiltSettings => readTilt(project.tilt) ?? DEFAULT_TILT

/** True when a tilt shows these angles (presets light up in the panel). */
export const sameAngles = (a: TiltAngles, b: TiltAngles): boolean =>
  Math.abs(a.rotateX - b.rotateX) < 0.05 && Math.abs(a.rotateY - b.rotateY) < 0.05 && Math.abs(a.perspective - b.perspective) < 0.005

/* ---------- animation ---------- */

const smoothstep = (x: number): number => x * x * (3 - 2 * x)

/** How far the 'zoom' animation has flattened the card at zoom level `scale`: 0 (full tilt) .. 1 (flat). */
export function zoomFlatten(scale: number): number {
  return smoothstep(clamp((scale - 1) / (ZOOM_FLAT_SCALE - 1), 0, 1))
}

/**
 * Where the cursor is in the visible part of the recording, -1 (left / top edge) .. 1
 * (right / bottom edge), through the zoom camera: a camera following the cursor keeps it
 * near 0.
 */
export function cursorLean(p: { x: number; y: number }, cam: Camera): { x: number; y: number } {
  const viewX = cam.cx - 0.5 / cam.scale
  const viewY = cam.cy - 0.5 / cam.scale
  return { x: clamp(((p.x - viewX) * cam.scale) * 2 - 1, -1, 1), y: clamp(((p.y - viewY) * cam.scale) * 2 - 1, -1, 1) }
}

/** The smoothed cursor path the 'cursor' animation follows. */
export interface TiltFocus {
  at(t: number): { x: number; y: number }
}

/** True when the tilt leans toward the cursor: its 'cursor' animation, with a cursor to follow (`focus`). */
export const leansToCursor = (tilt: TiltSettings, focus: TiltFocus | null): focus is TiltFocus => tilt.animate === 'cursor' && !!focus

/**
 * The tilt's pose at source time `t`. 'none' keeps the set angles; 'cursor' leans up to
 * CURSOR_LEAN degrees further toward the smoothed cursor (the side it is on comes forward), or
 * toward what the zoom camera aims at instead while one of `zooms` holds its aim on a click or
 * on the field being typed into (aimAt: the idle mouse is not followed then, and the lean turns
 * over as the camera moves in and out, never in one frame); 'zoom' flattens the card while the
 * camera is zoomed in, following the camera's level, so zoomed details stay readable. A pure
 * function of t, like the camera.
 */
export function tiltPoseAt(tilt: TiltSettings, t: number, cam: Camera, focus: TiltFocus | null, zooms: ZoomSegment[] = [], style: ZoomStyle = DEFAULT_ZOOM_STYLE): TiltAngles {
  let rx = tilt.rotateX
  let ry = tilt.rotateY
  if (leansToCursor(tilt, focus)) {
    const lean = cursorLean(aimAt(zooms, t, focus, style), cam)
    // Lower in the view brings the bottom forward (the top goes away); further right brings the right edge forward.
    rx += lean.y * CURSOR_LEAN
    ry -= lean.x * CURSOR_LEAN
  } else if (tilt.animate === 'zoom') {
    const keep = 1 - zoomFlatten(cam.scale)
    rx *= keep
    ry *= keep
  }
  return { rotateX: clamp(rx, -MAX_ANGLE, MAX_ANGLE), rotateY: clamp(ry, -MAX_ANGLE, MAX_ANGLE), perspective: clamp(tilt.perspective, 0, 1) }
}

/** True when a pose draws the card exactly flat (nothing to warp). */
export const poseIsFlat = (a: TiltAngles): boolean => Math.abs(a.rotateX) < 0.01 && Math.abs(a.rotateY) < 0.01

/* ---------- projection ---------- */

/** A projected point (output px) and its perspective weight (1 on the card's centre plane). */
export interface TiltPoint {
  x: number
  y: number
  q: number
}

/** A pose applied to one card in one output frame. */
export interface TiltView {
  /** The point the card turns about: the centre of its body (output px). */
  cx: number
  cy: number
  /** Rotation: x' = ax*x + ay*y, y' = by*y, depth z = zx*x + zy*y (relative to the centre). */
  ax: number
  ay: number
  by: number
  zx: number
  zy: number
  /** 1 / camera distance (px); 0 without perspective. */
  invD: number
  /** Uniform shrink (<= 1) about the centre that keeps the tilted body inside the frame. */
  fit: number
}

const RAD = Math.PI / 180

function project(v: TiltView, x: number, y: number, fit: number): TiltPoint {
  const dx = x - v.cx
  const dy = y - v.cy
  // Never behind the camera (the angle limit keeps real cards far from it anyway).
  const q = Math.max(0.05, 1 + (v.zx * dx + v.zy * dy) * v.invD)
  return { x: v.cx + (fit * (v.ax * dx + v.ay * dy)) / q, y: v.cy + (fit * v.by * dy) / q, q }
}

/** Where output point (x, y) of the flat card lands once tilted. */
export const projectPoint = (v: TiltView, x: number, y: number): TiltPoint => project(v, x, y, v.fit)

/** Corners of `r` once tilted, clockwise from the top left (top-left, top-right, bottom-right, bottom-left). */
export function projectRect(v: TiltView, r: Rect): [TiltPoint, TiltPoint, TiltPoint, TiltPoint] {
  return [projectPoint(v, r.x, r.y), projectPoint(v, r.x + r.w, r.y), projectPoint(v, r.x + r.w, r.y + r.h), projectPoint(v, r.x, r.y + r.h)]
}

/** `angles` applied to a card whose body is `body`, at its full size (fit 1). */
function poseView(angles: TiltAngles, body: Rect): TiltView {
  const a = clamp(angles.rotateX, -MAX_ANGLE, MAX_ANGLE) * RAD
  const b = clamp(angles.rotateY, -MAX_ANGLE, MAX_ANGLE) * RAD
  const sa = Math.sin(a)
  const sb = Math.sin(b)
  const ca = Math.cos(a)
  const cb = Math.cos(b)
  const size = Math.max(body.w, body.h, 1)
  const p = clamp(finite(angles.perspective) ? angles.perspective : 0, 0, 1)
  return {
    cx: body.x + body.w / 2,
    cy: body.y + body.h / 2,
    ax: cb,
    ay: sa * sb,
    by: ca,
    zx: sb,
    zy: -sa * cb,
    invD: p / (NEAREST_CAMERA * size),
    fit: 1
  }
}

/** Part of the output frame (px, its edges) the corners of a tilted card stay inside. */
export interface TiltArea {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The `w` x `h` frame, `margin` px in from its edges. */
export function frameArea(w: number, h: number, margin = 0): TiltArea {
  const m = clamp(finite(margin) ? margin : 0, 0, Math.min(w, h) / 2)
  return { x0: m, y0: m, x1: w - m, y1: h - m }
}

/** The tilt area of a settled `layout` (`corner`: a segment's own): next to a camera card, only up to the middle of the gap between them. */
function layoutArea(layout: CameraLayout, corner: Corner | undefined, frame: TiltArea, project: SceneProject, w: number, h: number, srcW: number, srcH: number): TiltArea {
  if (layout !== 'side-by-side') return frame
  const { screen: s, camera } = layoutGeometry(layout, project, w, h, srcW, srcH, corner)
  const c = camera.rect
  const a = { ...frame }
  if (c.x >= s.x + s.w) a.x1 = Math.min(a.x1, (s.x + s.w + c.x) / 2)
  else if (c.x + c.w <= s.x) a.x0 = Math.max(a.x0, (c.x + c.w + s.x) / 2)
  else if (c.y >= s.y + s.h) a.y1 = Math.min(a.y1, (s.y + s.h + c.y) / 2)
  else if (c.y + c.h <= s.y) a.y0 = Math.max(a.y0, (c.y + c.h + s.y) / 2)
  return a
}

/**
 * Where the tilted card may reach at source time `t` in a `w` x `h` output of a `srcW` x `srcH`
 * recording: the frame inside the style's padding and, while a camera card stands next to the
 * screen (side by side), only up to the middle of the gap between them, so the tilted screen
 * never slides under the flat camera card. It moves between layouts as the cards do.
 */
export function tiltArea(project: SceneProject, w: number, h: number, srcW: number, srcH: number, t: number): TiltArea {
  const frame = frameArea(w, h, project.style.padding * Math.min(w, h))
  if (!project.webcam.show) return frame
  const phase = layoutPhaseAt(project, t)
  const to = layoutArea(phase.to, phase.toCorner, frame, project, w, h, srcW, srcH)
  if (phase.progress >= 1 || (phase.from === phase.to && phase.fromCorner === phase.toCorner)) return to
  const from = layoutArea(phase.from, phase.fromCorner, frame, project, w, h, srcW, srcH)
  const e = easeInOutCubic(clamp(phase.progress, 0, 1))
  return { x0: lerp(from.x0, to.x0, e), y0: lerp(from.y0, to.y0, e), x1: lerp(from.x1, to.x1, e), y1: lerp(from.y1, to.y1, e) }
}

/**
 * The largest shrink (<= 1) about the centre that keeps the corners of `body`, seen through
 * `v`, inside `area`; never more than the flat body itself needs.
 */
function fitInFrame(v: TiltView, body: Rect, area: TiltArea): number {
  const loX = Math.min(area.x0, body.x)
  const loY = Math.min(area.y0, body.y)
  const hiX = Math.max(area.x1, body.x + body.w)
  const hiY = Math.max(area.y1, body.y + body.h)
  let fit = 1
  for (let i = 0; i < 4; i++) {
    // Clockwise from the top left.
    const c = project(v, i === 1 || i === 2 ? body.x + body.w : body.x, i < 2 ? body.y : body.y + body.h, 1)
    const dx = c.x - v.cx
    const dy = c.y - v.cy
    if (c.x > hiX && dx > 0) fit = Math.min(fit, (hiX - v.cx) / dx)
    if (c.x < loX && dx < 0) fit = Math.min(fit, (loX - v.cx) / dx)
    if (c.y > hiY && dy > 0) fit = Math.min(fit, (hiY - v.cy) / dy)
    if (c.y < loY && dy < 0) fit = Math.min(fit, (loY - v.cy) / dy)
  }
  return Math.max(0, fit)
}

/**
 * How `angles` tilt a card whose body (device chrome and border included, shadow left out)
 * is `body`. The perspective scales with the card, so a pulled-back card looks the same, only
 * smaller. When a tilted corner would leave `area` (the frame inside the style's padding, see
 * tiltArea), the whole card is shrunk about its centre until it fits; never more than the flat
 * body itself needs, so no tilt is exactly the flat card, and the corners never leave the area.
 */
export function tiltView(angles: TiltAngles, body: Rect, area: TiltArea): TiltView {
  const v = poseView(angles, body)
  v.fit = fitInFrame(v, body, area)
  return v
}

/** Lean poses tried along each axis by leanFit (the ends and evenly between). */
const LEAN_SAMPLES = 9

/**
 * The fit (TiltView.fit) of a card leaning toward the cursor from `angles`: the smallest one
 * over every pose the lean reaches (each angle up to CURSOR_LEAN degrees either way), so the
 * card keeps one size while it leans instead of growing and shrinking with the cursor. Poses
 * across the whole range are tried, not only its ends: with perspective, the edge coming
 * forward is widest part of the way round.
 */
export function leanFit(angles: TiltAngles, body: Rect, area: TiltArea): number {
  const n = LEAN_SAMPLES - 1
  let fit = 1
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const lean = { rotateX: angles.rotateX + CURSOR_LEAN * ((2 * i) / n - 1), rotateY: angles.rotateY + CURSOR_LEAN * ((2 * j) / n - 1), perspective: angles.perspective }
      fit = Math.min(fit, fitInFrame(poseView(lean, body), body, area))
    }
  }
  return fit
}

/** The last lean fit worked out, with what it was for: every frame of a video asks for the same one. */
let leanFitCache: { angles: TiltAngles; body: Rect; area: TiltArea; fit: number } | null = null

function steadyLeanFit(tilt: TiltSettings, body: Rect, area: TiltArea): number {
  const c = leanFitCache
  if (
    c &&
    c.angles.rotateX === tilt.rotateX &&
    c.angles.rotateY === tilt.rotateY &&
    c.angles.perspective === tilt.perspective &&
    c.body.x === body.x &&
    c.body.y === body.y &&
    c.body.w === body.w &&
    c.body.h === body.h &&
    c.area.x0 === area.x0 &&
    c.area.y0 === area.y0 &&
    c.area.x1 === area.x1 &&
    c.area.y1 === area.y1
  ) {
    return c.fit
  }
  const fit = leanFit(tilt, body, area)
  leanFitCache = { angles: { rotateX: tilt.rotateX, rotateY: tilt.rotateY, perspective: tilt.perspective }, body: { ...body }, area: { ...area }, fit }
  return fit
}

/**
 * How `tilt` tilts the card at a moment when its pose (tiltPoseAt) is `pose`: tiltView, except
 * that a card leaning toward the cursor (`leaning`, see leansToCursor) is fitted once for its
 * whole lean (leanFit), so it only turns as the cursor moves. A card the 'zoom' animation
 * flattens grows back to its full size as it straightens.
 */
export function tiltViewAt(tilt: TiltSettings, pose: TiltAngles, leaning: boolean, body: Rect, area: TiltArea): TiltView {
  if (!leaning) return tiltView(pose, body, area)
  const v = poseView(pose, body)
  v.fit = steadyLeanFit(tilt, body, area)
  return v
}

/** Smallest pixel-aligned rectangle holding `points`, cut to the frame (empty when outside it). */
export function quadBounds(points: readonly TiltPoint[], frameW: number, frameH: number): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of points) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  const x = clamp(Math.floor(x0), 0, frameW)
  const y = clamp(Math.floor(y0), 0, frameH)
  return { x, y, w: clamp(Math.ceil(x1), 0, frameW) - x, h: clamp(Math.ceil(y1), 0, frameH) - y }
}

/**
 * The same pose as a CSS transform for an element `size` px across (the Effects panel's
 * preset tiles): the conventions here are CSS's, so the tile shows what the video will.
 */
export function tiltCss(angles: TiltAngles, size: number): string {
  const p = clamp(angles.perspective, 0, 1)
  const d = p > 0 ? `perspective(${((NEAREST_CAMERA * size) / p).toFixed(1)}px) ` : ''
  return `${d}rotateY(${angles.rotateY}deg) rotateX(${angles.rotateX}deg)`
}
