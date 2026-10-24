/**
 * Pure timing and geometry for the shapes, privacy blur/pixelate and spotlights drawn over the
 * recording. No DOM, so it is unit-tested directly; renderer/render/shapesLayer.ts and
 * spotlightLayer.ts draw with it, and preview and export both go through that one code path.
 */
import { isPrivacyKind, SHAPE_FADE, SPOTLIGHT_FADE } from '../editor/shapes'
import { cursorAt } from '../engine/cursor'
import { clamp } from '../engine/math'
import { readShape, readSpotlight } from '../engine/shapeData'
import { outputDuration, outputToSource, sourceToOutput } from '../engine/timeline'
import type { Camera } from '../engine/zoom'
import type { Clip, CursorSample, Project, Shape, Spotlight } from '../types'
import { blendHome, cursorLook, loopHomeTime, loopHomeWeight } from './cursorFx'

type Pos = { x: number; y: number }
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/* ---------- reading shapes (defaults applied at read time) ---------- */

export { readShape, readSpotlight }

const shapeCache = new WeakMap<Shape[], Shape[]>()
const spotCache = new WeakMap<Spotlight[], Spotlight[]>()

function readAll<T>(list: T[] | undefined, cache: WeakMap<T[], T[]>, read: (v: T) => T | null): T[] {
  if (!Array.isArray(list) || list.length === 0) return []
  const hit = cache.get(list)
  if (hit) return hit
  const out: T[] = []
  for (const v of list) {
    const r = read(v)
    if (r) out.push(r)
  }
  cache.set(list, out)
  return out
}

/** The project's drawable shapes (older projects have none), computed once per list. */
export const projectShapes = (p: Pick<Project, 'shapes'>): Shape[] => readAll(p.shapes, shapeCache, readShape)
/** The project's drawable spotlights, computed once per list. */
export const projectSpotlights = (p: Pick<Project, 'spotlights'>): Spotlight[] => readAll(p.spotlights, spotCache, readSpotlight)

/* ---------- timing ---------- */

export { SHAPE_FADE, SPOTLIGHT_FADE }

/**
 * Opacity factor of a shape at source time `t` (`speed`: the clip's playback speed, so fades
 * last as long on screen at any speed). Privacy shapes never fade: they are fully applied for
 * their whole range, so nothing they hide flashes up at the edges.
 */
export function shapeAlpha(s: Pick<Shape, 'start' | 'end' | 'kind'>, t: number, speed = 1, fade = SHAPE_FADE): number {
  if (!(t >= s.start && t < s.end)) return 0
  if (isPrivacyKind(s.kind)) return 1
  const f = fade * speed
  return clamp(Math.min((t - s.start) / f, (s.end - t) / f), 0, 1)
}

/** Strength 0..1 of a spotlight at source time `t` (fades in and out over SPOTLIGHT_FADE). */
export function spotlightAlpha(s: Pick<Spotlight, 'start' | 'end'>, t: number, speed = 1, fade = SPOTLIGHT_FADE): number {
  if (!(t >= s.start && t < s.end)) return 0
  const f = fade * speed
  const k = clamp(Math.min((t - s.start) / f, (s.end - t) / f), 0, 1)
  // Eased, so the darkening settles in softly.
  return k * k * (3 - 2 * k)
}

/* ---------- privacy blur and pixelate ---------- */

/**
 * Gaussian blur radius (standard deviation, source pixels) of a privacy blur of `strength`
 * 0..1 on a recording `vh` pixels tall. Relative to the recording, so the blur sticks to the
 * content: it looks the same in preview and export, and grows with the content when zoomed.
 * Even strength 0 makes ordinary text unreadable.
 */
export const blurSigma = (strength: number, vh: number): number => (0.005 + 0.025 * clamp(strength, 0, 1)) * vh

/** Mosaic cell size (source pixels) of a privacy pixelation of `strength` 0..1. */
export const pixelCell = (strength: number, vh: number): number => Math.max(2, (0.01 + 0.04 * clamp(strength, 0, 1)) * vh)

export interface BlurPlan {
  /** Scratch pixels per source pixel (the blur runs on a reduced copy: much cheaper, same look). */
  scale: number
  /** Blur radius in scratch pixels. */
  sigma: number
  /** Scratch pixels of surrounding content kept on each side, so the blur has no transparent edge. */
  margin: number
}

/**
 * How to blur a `bw` x `bh` source-pixel box with radius `sigma` (source pixels): on a copy
 * reduced so the radius is about `target` scratch pixels, at most `maxSide` pixels across.
 */
export function blurPlan(sigma: number, bw: number, bh: number, target = 2.5, maxSide = 1024): BlurPlan {
  let scale = sigma > target ? target / sigma : 1
  const side = Math.max(bw, bh) * scale
  if (side > maxSide) scale *= maxSide / side
  const s = sigma * scale
  return { scale, sigma: s, margin: Math.ceil(s * 3) + 2 }
}

/** Mosaic grid of a `bw` x `bh` source-pixel box with cells of about `cell` pixels (at most `max` per side). */
export function pixelGrid(bw: number, bh: number, cell: number, max = 512): { cols: number; rows: number } {
  const c = Math.max(1, cell)
  return { cols: clamp(Math.round(bw / c), 1, max), rows: clamp(Math.round(bh / c), 1, max) }
}

/** The part of a box inside the recording (null when none of it is). */
export function clipToUnit(b: Box): Box | null {
  const x0 = Math.max(0, Math.min(b.x, b.x + b.w))
  const y0 = Math.max(0, Math.min(b.y, b.y + b.h))
  const x1 = Math.min(1, Math.max(b.x, b.x + b.w))
  const y1 = Math.min(1, Math.max(b.y, b.y + b.h))
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

/**
 * The box (in source units, as `cam` shows it) that covers `box`'s content in every frame
 * `others` show. Motion blur averages the frame over the cameras of its shutter, so while
 * the camera moves the content under a privacy box also lands beside it: covering this
 * larger box keeps it hidden in every sub-frame.
 */
export function sweptBox(box: Box, cam: Camera, others: Camera[]): Box {
  const vx = cam.cx - 0.5 / cam.scale
  const vy = cam.cy - 0.5 / cam.scale
  let x0 = box.x
  let y0 = box.y
  let x1 = box.x + box.w
  let y1 = box.y + box.h
  for (const c of others) {
    const k = c.scale / cam.scale
    const cx = c.cx - 0.5 / c.scale
    const cy = c.cy - 0.5 / c.scale
    // Where that camera puts the box on screen, expressed in this camera's source units.
    const ax = vx + (box.x - cx) * k
    const ay = vy + (box.y - cy) * k
    x0 = Math.min(x0, ax)
    y0 = Math.min(y0, ay)
    x1 = Math.max(x1, ax + box.w * k)
    y1 = Math.max(y1, ay + box.h * k)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/* ---------- arrows ---------- */

export interface ArrowGeometry {
  /** Outline, filled as one shape: shaft sides (tail -> head) and the arrowhead, clockwise from the tail's left. */
  points: Pos[]
  /** Centre and radius of the round tail cap, and the shaft's direction (radians). */
  tail: Pos
  radius: number
  angle: number
  /** The arrowhead's corners (tip, left, right), for rounding them off. */
  head: [Pos, Pos, Pos]
}

/**
 * An arrow from `a` to `b` (output pixels) with a `width` px shaft: a head about 3.4 widths
 * long (at least `minHead`), smaller on short arrows. Null when the arrow has no length.
 */
export function arrowGeometry(a: Pos, b: Pos, width: number, minHead = 0): ArrowGeometry | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (!(len > 0.5) || !(width > 0)) return null
  const ux = dx / len
  const uy = dy / len
  // Perpendicular, to the left of the direction of travel on screen (y points down).
  const nx = uy
  const ny = -ux
  const head = Math.min(Math.max(width * 3.4, minHead), len * 0.6)
  const half = Math.max(head * 0.58, width * 0.75)
  const hw = width / 2
  const bx = b.x - ux * head
  const by = b.y - uy * head
  const at = (x: number, y: number, k: number): Pos => ({ x: x + nx * k, y: y + ny * k })
  const left = at(bx, by, half)
  const right = at(bx, by, -half)
  return {
    points: [at(a.x, a.y, hw), at(bx, by, hw), left, { x: b.x, y: b.y }, right, at(bx, by, -hw), at(a.x, a.y, -hw)],
    tail: { x: a.x, y: a.y },
    radius: hw,
    angle: Math.atan2(uy, ux),
    head: [{ x: b.x, y: b.y }, left, right]
  }
}

/* ---------- spotlight ---------- */

/**
 * The cursor position the cursor layer draws at source time `t`: the smoothed path, glided
 * back to its start at the end with "loop home".
 */
export function cursorPositionAt(path: { at(t: number): Pos }, clips: Clip[], loopHome: boolean, t: number): Pos {
  if (!loopHome) return path.at(t)
  return blendHome(path.at(t), path.at(loopHomeTime(clips)), loopHomeWeight(clips, t))
}

/**
 * Where viewers see the cursor at source time `t`: a cursor spotlight follows this and a new
 * arrow points at it. With the real cursor baked into the video (Chromium capture) that is the
 * recorded position itself, since the video's cursor neither lags like the smoothed path nor
 * glides home. Otherwise it is where the cursor layer draws the synthetic cursor (`path`, the
 * smoothed track), also while that is hidden, so a spotlight keeps the smooth motion. Null
 * without samples.
 */
export function visibleCursorAt(project: Pick<Project, 'capture' | 'cursor' | 'clips'>, samples: CursorSample[], path: { at(t: number): Pos }, t: number): Pos | null {
  if (samples.length === 0) return null
  if (project.capture?.cursorInVideo) return cursorAt(samples, t)
  return cursorPositionAt(path, project.clips, cursorLook(project.cursor).loopHome, t)
}

/** A normalised position inside the recorded video. */
export const insideVideo = (p: Pos): boolean => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1

/**
 * Whether the cursor viewers see at source time `t` is over the recording. In a window or area
 * recording it can leave it (over another window or monitor, outside the area): the cursor layer
 * then stops drawing it at once, also while the smoothed cursor would still be sliding to the
 * edge, so both the drawn and the recorded position (glided home with it) must be inside. With
 * the real cursor baked into the video, that is where the recorded position is.
 */
export function cursorOverVideoAt(project: Pick<Project, 'capture' | 'cursor' | 'clips'>, samples: CursorSample[], path: { at(t: number): Pos }, t: number): boolean {
  return overVideo(project, samples, path)(t)
}

/** cursorOverVideoAt as a function of time, with what does not depend on it worked out once. */
function overVideo(project: Pick<Project, 'capture' | 'cursor' | 'clips'>, samples: CursorSample[], path: { at(t: number): Pos }): (t: number) => boolean {
  const baked = !!project.capture?.cursorInVideo
  const { loopHome } = cursorLook(project.cursor)
  const home = loopHome && !baked ? cursorAt(samples, loopHomeTime(project.clips)) : null
  return (t) => {
    const raw = cursorAt(samples, t)
    if (!raw) return false
    if (baked) return insideVideo(raw)
    const w = home ? loopHomeWeight(project.clips, t) : 0
    const recorded = home && w > 0 ? blendHome(raw, home, w) : raw
    return insideVideo(cursorPositionAt(path, project.clips, loopHome, t)) && insideVideo(recorded)
  }
}

/**
 * How much (0..1) of a cursor spotlight shows at source time `t` as far as the cursor goes: none
 * while the cursor is off the recording (`over` false: its lit area would be off screen and only
 * darken the whole frame), easing out over the `fade` seconds of the edited video before it
 * leaves and back in over those after it returns. It looks around `t` along the edit (`clips`),
 * so only what viewers see counts: the cursor leaving inside a cut, or before the edit starts or
 * after it ends, does not dim the frames beside it, and the fades last as long on screen at any
 * clip speed. A frame inside a cut (only the paused preview shows one) looks around in source
 * time. A pure function of `t`, so preview and export agree.
 */
export function cursorPresence(over: (t: number) => boolean, clips: Clip[], t: number, fade = SPOTLIGHT_FADE): number {
  if (!over(t)) return 0
  if (!(fade > 0)) return 1
  const o = sourceToOutput(clips, t)
  const end = outputDuration(clips)
  // The source time viewers see `d` seconds from `t`, or null past either end of the edit.
  const away = (d: number): number | null => {
    if (o === null) return t + d
    return o + d < 0 || o + d > end ? null : outputToSource(clips, o + d).time
  }
  // Looks around `t` in steps of at most 1/240 s for the nearest moment the cursor is off.
  const steps = clamp(Math.ceil(fade * 240), 8, 960)
  let near = fade
  for (const dir of [-1, 1]) {
    for (let i = 1; i <= steps && (i * fade) / steps < near; i++) {
      const d = (i * fade) / steps
      const s = away(dir * d)
      if (s === null) break
      if (!over(s)) {
        near = d
        break
      }
    }
  }
  const k = clamp(near / fade, 0, 1)
  return k * k * (3 - 2 * k)
}

/**
 * How much of a cursor spotlight shows at source time `t`: it fades out while the cursor is off
 * the recording, just as the cursor layer hides the cursor then (cursorOverVideoAt), over as
 * long on screen as the spotlight's own fades.
 */
export function cursorSpotlightPresence(project: Pick<Project, 'capture' | 'cursor' | 'clips'>, samples: CursorSample[], path: { at(t: number): Pos }, t: number): number {
  return cursorPresence(overVideo(project, samples, path), project.clips, t, SPOTLIGHT_FADE)
}

/** The lit area of a spotlight (normalised source units): its box, or centred on `cursor` in cursor mode. */
export function spotlightArea(s: Pick<Spotlight, 'mode' | 'x' | 'y' | 'w' | 'h'>, cursor: Pos | null): Box {
  if (s.mode === 'cursor' && cursor) return { x: cursor.x - s.w / 2, y: cursor.y - s.h / 2, w: s.w, h: s.h }
  return { x: s.x, y: s.y, w: s.w, h: s.h }
}

/**
 * Width (output px) of a spotlight's soft edge: `feather` 0..1 of the lit area's smaller
 * half-size, centred on its outline (half inside, half outside).
 */
export const spotlightFeather = (feather: number, rx: number, ry: number): number => clamp(feather, 0, 1) * Math.max(0, Math.min(rx, ry))

export interface IntRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Whole-pixel rectangles of a feathered rectangular spotlight centred at (cx, cy) with half
 * sizes rx, ry and a `feather` px soft edge: fully lit inside `inner`, untouched outside
 * `outer`. Whole pixels, so the pieces it is drawn from meet without seams.
 */
export function featherRects(cx: number, cy: number, rx: number, ry: number, feather: number): { inner: IntRect; outer: IntRect } {
  const f = Math.max(0, feather) / 2
  const outer = { x0: Math.round(cx - rx - f), y0: Math.round(cy - ry - f), x1: Math.round(cx + rx + f), y1: Math.round(cy + ry + f) }
  let x0 = Math.round(cx - rx + f)
  let x1 = Math.round(cx + rx - f)
  let y0 = Math.round(cy - ry + f)
  let y1 = Math.round(cy + ry - f)
  // A feather wider than the area leaves no fully lit core: it collapses onto the centre line.
  if (x1 < x0) x0 = x1 = Math.round(cx)
  if (y1 < y0) y0 = y1 = Math.round(cy)
  return { inner: { x0, y0, x1, y1 }, outer }
}

/** Gradient stops (offset 0..1 across the soft edge, lit amount) that ease in and out. */
export const FEATHER_STOPS: [number, number][] = [0, 0.2, 0.4, 0.6, 0.8, 1].map((o) => [o, 1 - o * o * (3 - 2 * o)])

/**
 * Combined darkening of several spotlights active at once: the darkest one (by its Darkness
 * and how far it has faded in) sets the overall level, and each one's lit area is cleared by
 * its own fade alone. So every area is fully lit while its spotlight is fully in, whatever its
 * Darkness, and one fading out lets its area darken gradually while the others stay lit.
 */
export function spotlightLevels(items: { dim: number; alpha: number }[]): { dim: number; clear: number[] } {
  const dim = Math.max(0, ...items.map((s) => clamp(s.dim, 0, 1) * clamp(s.alpha, 0, 1)))
  return { dim, clear: items.map((s) => (dim > 0 ? clamp(s.alpha, 0, 1) : 0)) }
}
