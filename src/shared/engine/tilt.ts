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
import type { Project, TiltSettings } from '../types'
import type { Rect } from './layout'
import { clamp } from './math'
import type { Camera } from './zoom'

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

/**
 * The tilt's pose at source time `t`. 'none' keeps the set angles; 'cursor' leans up to
 * CURSOR_LEAN degrees further toward the smoothed cursor (the side it is on comes forward);
 * 'zoom' flattens the card while the camera is zoomed in, following the camera's level, so
 * zoomed details stay readable. A pure function of t, like the camera.
 */
export function tiltPoseAt(tilt: TiltSettings, t: number, cam: Camera, focus: { at(t: number): { x: number; y: number } } | null): TiltAngles {
  let rx = tilt.rotateX
  let ry = tilt.rotateY
  if (tilt.animate === 'cursor' && focus) {
    const lean = cursorLean(focus.at(t), cam)
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

/**
 * How `angles` tilt a card whose body (device chrome and border included, shadow left out)
 * is `body`, in a `frameW` x `frameH` output. The perspective scales with the card, so a
 * pulled-back card looks the same, only smaller. When a tilted corner would come closer than
 * `margin` (the style's padding, px) to the frame's edge, the whole card is shrunk about its
 * centre until it fits; never more than the flat body itself needs, so no tilt is exactly the
 * flat card, and the corners never leave the frame.
 */
export function tiltView(angles: TiltAngles, body: Rect, frameW: number, frameH: number, margin = 0): TiltView {
  const a = clamp(angles.rotateX, -MAX_ANGLE, MAX_ANGLE) * RAD
  const b = clamp(angles.rotateY, -MAX_ANGLE, MAX_ANGLE) * RAD
  const sa = Math.sin(a)
  const sb = Math.sin(b)
  const ca = Math.cos(a)
  const cb = Math.cos(b)
  const size = Math.max(body.w, body.h, 1)
  const p = clamp(finite(angles.perspective) ? angles.perspective : 0, 0, 1)
  const v: TiltView = {
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
  const m = clamp(finite(margin) ? margin : 0, 0, Math.min(frameW, frameH) / 2)
  const lo = { x: Math.min(m, body.x), y: Math.min(m, body.y) }
  const hi = { x: Math.max(frameW - m, body.x + body.w), y: Math.max(frameH - m, body.y + body.h) }
  let fit = 1
  for (const [x, y] of [
    [body.x, body.y],
    [body.x + body.w, body.y],
    [body.x + body.w, body.y + body.h],
    [body.x, body.y + body.h]
  ]) {
    const c = project(v, x, y, 1)
    const dx = c.x - v.cx
    const dy = c.y - v.cy
    if (c.x > hi.x && dx > 0) fit = Math.min(fit, (hi.x - v.cx) / dx)
    if (c.x < lo.x && dx < 0) fit = Math.min(fit, (lo.x - v.cx) / dx)
    if (c.y > hi.y && dy > 0) fit = Math.min(fit, (hi.y - v.cy) / dy)
    if (c.y < lo.y && dy < 0) fit = Math.min(fit, (lo.y - v.cy) / dy)
  }
  v.fit = Math.max(0, fit)
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
