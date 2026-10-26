/**
 * Cropping the recording in the editor (E-10, docs/design/crop-in-editor.md). `Project.crop` is
 * one rectangle, normalised to the video frame, and every other stored position stays relative
 * to the FULL recorded frame. Rendering and measuring happen in *view space* (relative to the
 * crop) through one entry point, cropView(project, track): the scene is built from that view, so
 * the compositor, the camera and the layers keep their code. Without a crop every function here
 * returns its input (the same object), so projects without a crop are drawn exactly as before.
 *
 * Every mapping uses the crop snapped to the project's pixels (cropOf), so the geometry and the
 * pixels the compositor copies out of each frame agree exactly. Mapped arrays are memoised per
 * source array and crop, so an edit that does not touch them keeps them (and every cache keyed on
 * them) warm. readCrop and cropOf are frozen contracts (docs/design/editing-wins.md §4).
 */
import type { AutoZoomSettings, ClickEvent, CursorSample, CursorTrack, NormRect, Project, ScrollEvent, Shape, Spotlight, ZoomFocus, ZoomSegment } from '../types'
import { clamp } from './math'
import { autoZoomsForTrack, regenerateAutoZooms } from './zoom'

/** Fewest recorded pixels a crop keeps on each side (the whole side when the recording is smaller). */
export const MIN_CROP_PX = 64

/** The whole frame, as a crop rectangle (a new crop draft starts from it). */
export const FULL_FRAME: Readonly<NormRect> = Object.freeze({ x: 0, y: 0, w: 1, h: 1 })

/** A rectangle in whole pixels of a frame. */
export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

/** Without usable pixel sizes, a crop side must keep at least this share of the frame. */
const MIN_CROP_SHARE = 0.01
/** Without usable pixel sizes, edges this close (normalised) to the frame's edges are on them. */
const EDGE_EPS = 1e-6

const usableSize = (width: number, height: number): boolean => Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0

/**
 * A stored crop, sanitised (project.json, migrateProject): undefined when it is not a rectangle
 * of finite numbers, when it is too small (under MIN_CROP_PX recorded pixels on a side, less
 * half a pixel; under 1% of a side when the size is unknown), or when every edge is within half a
 * pixel of the frame's edge (no crop). Otherwise it is clipped to the unit square. Never snapped
 * to pixels, so it is idempotent and survives correctProjectMedia changing the size; cropOf snaps.
 */
export function readCrop(raw: unknown, width: number, height: number): NormRect | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { x, y, w, h } = raw as Partial<Record<keyof NormRect, unknown>>
  if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return undefined
  const x0 = clamp(x, 0, 1)
  const x1 = clamp(x + w, 0, 1)
  const y0 = clamp(y, 0, 1)
  const y1 = clamp(y + h, 0, 1)
  // A rectangle already inside the frame keeps its exact numbers (x0 + (x1 − x0) is not always x1).
  const cw = x0 === x && x1 === x + w ? w : x1 - x0
  const ch = y0 === y && y1 === y + h ? h : y1 - y0
  if (usableSize(width, height)) {
    if (cw * width < Math.min(MIN_CROP_PX, width) - 0.5 || ch * height < Math.min(MIN_CROP_PX, height) - 0.5) return undefined
    if (x0 * width <= 0.5 && (1 - x1) * width <= 0.5 && y0 * height <= 0.5 && (1 - y1) * height <= 0.5) return undefined
  } else {
    if (cw < MIN_CROP_SHARE || ch < MIN_CROP_SHARE) return undefined
    if (x0 <= EDGE_EPS && 1 - x1 <= EDGE_EPS && y0 <= EDGE_EPS && 1 - y1 <= EDGE_EPS) return undefined
  }
  return { x: x0, y: y0, w: cw, h: ch }
}

/**
 * The crop in whole pixels of a `frameW` × `frameH` frame: edges rounded to the nearest pixel, at
 * least one pixel on a side. No crop: the whole frame.
 */
export function cropPixels(crop: NormRect | null, frameW: number, frameH: number): PixelRect {
  if (!crop) return { x: 0, y: 0, w: frameW, h: frameH }
  const x0 = Math.round(crop.x * frameW)
  const x1 = Math.round((crop.x + crop.w) * frameW)
  const y0 = Math.round(crop.y * frameH)
  const y1 = Math.round((crop.y + crop.h) * frameH)
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

/**
 * The project's crop snapped to its pixels (cropPixels / size), so geometry and copied pixels
 * agree exactly; null when there is no crop (or it snaps to the whole frame). Every mapping uses
 * this, never `project.crop` itself.
 */
export function cropOf(p: Pick<Project, 'crop' | 'width' | 'height'>): NormRect | null {
  const c = p.crop
  if (!c) return null
  if (!usableSize(p.width, p.height)) return { x: c.x, y: c.y, w: c.w, h: c.h }
  const px = cropPixels(c, p.width, p.height)
  if (px.x === 0 && px.y === 0 && px.w === p.width && px.h === p.height) return null
  return { x: px.x / p.width, y: px.y / p.height, w: px.w / p.width, h: px.h / p.height }
}

/**
 * Size of the drawn (cropped) picture of a decoded `frameW` × `frameH` frame; `fallback` while no
 * frame is decoded (a zero size). cropPixels never gives 0, so `|| project.width` cannot do this.
 */
export function croppedFrameSize(
  crop: NormRect | null,
  frameW: number,
  frameH: number,
  fallback: { width: number; height: number }
): { width: number; height: number } {
  if (!frameW || !frameH) return fallback
  const px = cropPixels(crop, frameW, frameH)
  return { width: px.w, height: px.h }
}

/** The recording's size as it is shown: the crop's pixels, or the whole frame. */
export function visibleSize(p: Pick<Project, 'crop' | 'width' | 'height'>): { width: number; height: number } {
  const px = cropPixels(cropOf(p), p.width, p.height)
  return { width: px.w, height: px.h }
}

const inUnit = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1

// A full-frame coordinate in view space and back. Every mapping goes through these, so a point is
// tested (inCrop) exactly where the view draws it.
const viewX = (c: NormRect, x: number): number => (x - c.x) / c.w
const viewY = (c: NormRect, y: number): number => (y - c.y) / c.h
const fullX = (c: NormRect, x: number): number => c.x + x * c.w
const fullY = (c: NormRect, y: number): number => c.y + y * c.h

/** Whether a full-frame point is shown (exactly the view's own inVideo test after toCrop). */
export function inCrop(crop: NormRect | null, p: { x: number; y: number }): boolean {
  return inUnit(toCrop(crop, p))
}

/** A full-frame point moved into the crop (the same object when it is already inside). */
export function clampIntoCrop<T extends { x: number; y: number }>(crop: NormRect | null, p: T): T {
  if (!crop) return p
  const x = clamp(p.x, crop.x, crop.x + crop.w)
  const y = clamp(p.y, crop.y, crop.y + crop.h)
  return x === p.x && y === p.y ? p : { ...p, x, y }
}

/** A full-frame point in view space: ((x − c.x) / c.w, (y − c.y) / c.h). No crop: the same object. */
export function toCrop(crop: NormRect | null, p: { x: number; y: number }): { x: number; y: number } {
  return crop ? { x: viewX(crop, p.x), y: viewY(crop, p.y) } : p
}

/** A view-space point in the full frame (the inverse of toCrop). No crop: the same object. */
export function fromCrop(crop: NormRect | null, p: { x: number; y: number }): { x: number; y: number } {
  return crop ? { x: fullX(crop, p.x), y: fullY(crop, p.y) } : p
}

/** A full-frame rectangle in view space (negative w/h of lines and arrows map too). No crop: the same object. */
export function rectToCrop<R extends NormRect>(crop: NormRect | null, r: R): R {
  if (!crop) return r
  return { ...r, x: viewX(crop, r.x), y: viewY(crop, r.y), w: r.w / crop.w, h: r.h / crop.h }
}

/** A view-space rectangle in the full frame (the inverse of rectToCrop). No crop: the same object. */
export function rectFromCrop<R extends NormRect>(crop: NormRect | null, r: R): R {
  if (!crop) return r
  return { ...r, x: fullX(crop, r.x), y: fullY(crop, r.y), w: r.w * crop.w, h: r.h * crop.h }
}

/** A view-space geometry patch (any of x, y, w, h) in the full frame; x and w map independently. No crop: the same object. */
export function geometryFromCrop<T extends Partial<NormRect>>(crop: NormRect | null, patch: T): T {
  if (!crop) return patch
  const out: Partial<NormRect> = { ...patch }
  if (patch.x !== undefined) out.x = fullX(crop, patch.x)
  if (patch.y !== undefined) out.y = fullY(crop, patch.y)
  if (patch.w !== undefined) out.w = patch.w * crop.w
  if (patch.h !== undefined) out.h = patch.h * crop.h
  return out as T
}

/** `z` with its fixed point, region and anchor mapped one way (`view`: into view space); the same object when it has none. */
function mapZoom(c: NormRect, z: ZoomSegment, view: boolean): ZoomSegment {
  const f = z.focus
  if (f.mode === 'cursor' && !z.anchor) return z
  const point = view ? (p: { x: number; y: number }) => toCrop(c, p) : (p: { x: number; y: number }) => fromCrop(c, p)
  const focus: ZoomFocus = f.mode === 'fixed' ? { mode: 'fixed', ...point(f) } : f.mode === 'region' ? (view ? rectToCrop(c, f) : rectFromCrop(c, f)) : f
  const out: ZoomSegment = { ...z, focus }
  if (z.anchor) out.anchor = { ...z.anchor, ...point(z.anchor) }
  return out
}

/** A zoom in view space: fixed point, region and anchor mapped; scale, times and `until` kept. No crop: the same object. */
export function zoomInView(crop: NormRect | null, z: ZoomSegment): ZoomSegment {
  return crop ? mapZoom(crop, z, true) : z
}

/** A view-space zoom in the full frame (the inverse of zoomInView), for edits made in the view. No crop: the same object. */
export function zoomFromView(crop: NormRect | null, z: ZoomSegment): ZoomSegment {
  return crop ? mapZoom(crop, z, false) : z
}

/**
 * Where a region spotlight none of the view shows is put in view space. readSpotlight keeps it as
 * it is (a far-off one would be clamped back into view), and it lights nothing the view shows, so
 * everything shown is dimmed, as it should be.
 */
const OFF_VIEW = { x: 1.5, y: 1.5, w: 0.005, h: 0.005 }

/** A spotlight in view space: position mapped, size scaled (cursor mode uses only the size). */
function spotlightInView(c: NormRect, s: Spotlight): Spotlight {
  const v = rectToCrop(c, s)
  if (s.mode !== 'region') return v
  // Its lit area, widened by the half of its soft edge that lies outside it (spotlightFeather).
  const f = Number.isFinite(s.feather) ? clamp(s.feather, 0, 1) : 0.4
  const mx = (f * Math.abs(v.w)) / 4
  const my = (f * Math.abs(v.h)) / 4
  const x0 = Math.min(v.x, v.x + v.w) - mx
  const x1 = Math.max(v.x, v.x + v.w) + mx
  const y0 = Math.min(v.y, v.y + v.h) - my
  const y1 = Math.max(v.y, v.y + v.h) + my
  return x1 <= 0 || x0 >= 1 || y1 <= 0 || y0 >= 1 ? { ...v, ...OFF_VIEW } : v
}

const cropKey = (c: NormRect): string => `${c.x},${c.y},${c.w},${c.h}`

type Mapped<T> = WeakMap<T[], { key: string; out: T[] }>

/** `list` mapped into the view of the crop `key` names, memoised per source array (for its latest crop). */
function mapped<T>(cache: Mapped<T>, list: T[], key: string, map: (v: T) => T): T[] {
  const hit = cache.get(list)
  if (hit && hit.key === key) return hit.out
  const out = list.map(map)
  cache.set(list, { key, out })
  return out
}

const zoomViews: Mapped<ZoomSegment> = new WeakMap()
const shapeViews: Mapped<Shape> = new WeakMap()
const spotlightViews: Mapped<Spotlight> = new WeakMap()
const projectViews = new WeakMap<object, CroppableProject>()

/** What cropProject reads and writes. */
export type CroppableProject = Pick<Project, 'width' | 'height' | 'zooms' | 'shapes' | 'spotlights' | 'crop'>

/**
 * The project as drawn: the crop's pixel size, zooms, shapes and spotlights in view space, and no
 * `crop` key; everything else shared. No crop: `p` itself. Memoised per project object, and each
 * mapped list per source list, so an edit elsewhere keeps the mapped lists.
 */
export function cropProject<P extends CroppableProject>(p: P): P {
  const c = cropOf(p)
  if (!c) return p
  const hit = projectViews.get(p)
  if (hit) return hit as P
  const key = cropKey(c)
  const { crop: _crop, ...rest } = p
  const { width, height } = visibleSize(p)
  const view = {
    ...rest,
    width,
    height,
    zooms: mapped(zoomViews, p.zooms, key, (z) => mapZoom(c, z, true)),
    ...(p.shapes ? { shapes: mapped(shapeViews, p.shapes, key, (s) => rectToCrop(c, s)) } : {}),
    ...(p.spotlights ? { spotlights: mapped(spotlightViews, p.spotlights, key, (s) => spotlightInView(c, s)) } : {})
  } as unknown as P
  projectViews.set(p, view)
  return view
}

const sampleViews: Mapped<CursorSample> = new WeakMap()
const clickViews: Mapped<ClickEvent> = new WeakMap()
const scrollViews: Mapped<ScrollEvent> = new WeakMap()
const trackViews = new WeakMap<CursorTrack, { key: string; out: CursorTrack }>()

/**
 * The cursor track in view space (samples, clicks and scrolls; keys, typing, marks, shapes, scale
 * and valid shared); memoised per array. No crop: `track` itself.
 */
export function cropTrack(track: CursorTrack, crop: NormRect | null): CursorTrack {
  if (!crop) return track
  const key = cropKey(crop)
  const hit = trackViews.get(track)
  if (hit && hit.key === key) return hit.out
  const out: CursorTrack = {
    ...track,
    samples: mapped(sampleViews, track.samples, key, (s) => ({ t: s.t, x: viewX(crop, s.x), y: viewY(crop, s.y) })),
    clicks: mapped(clickViews, track.clicks, key, (k) => ({ ...k, x: viewX(crop, k.x), y: viewY(crop, k.y) }))
  }
  if (track.scrolls) out.scrolls = mapped(scrollViews, track.scrolls, key, (e) => ({ ...e, x: viewX(crop, e.x), y: viewY(crop, e.y) }))
  trackViews.set(track, { key, out })
  return out
}

/** The view of a project and its track: what cropView returns. */
export interface CropView<P> {
  project: P
  cursor: CursorTrack
  crop: NormRect | null
}

const views = new WeakMap<object, { track: CursorTrack; view: CropView<CroppableProject> }>()

/**
 * The single entry point the scene is built from: the project and track as drawn, and the snapped
 * crop. Memoised per (project, track). No crop: the project and the track themselves.
 */
export function cropView<P extends CroppableProject>(p: P, track: CursorTrack): CropView<P> {
  const hit = views.get(p)
  if (hit && hit.track === track) return hit.view as CropView<P>
  const crop = cropOf(p)
  const view: CropView<P> = { project: cropProject(p), cursor: cropTrack(track, crop), crop }
  views.set(p, { track, view })
  return view
}

const shownClicks: Mapped<ClickEvent> = new WeakMap()

/** `track` without the clicks the crop hides, in full-frame coordinates (the same object when it hides none). */
function shownTrack(track: CursorTrack, c: NormRect): CursorTrack {
  const key = cropKey(c)
  let hit = shownClicks.get(track.clicks)
  if (!hit || hit.key !== key) {
    hit = { key, out: track.clicks.filter((k) => inCrop(c, k)) }
    shownClicks.set(track.clicks, hit)
  }
  return hit.out.length === track.clicks.length ? track : { ...track, clicks: hit.out }
}

/**
 * An automatic zoom aimed into the crop: its anchor (typing places, marks and scroll landings can
 * lie outside), and the fixed focus a track without cursor data copies from it, clamped. The same
 * object when both are inside, so rebaseAutoZooms matches zooms across crops exactly.
 */
function aimIntoCrop(c: NormRect, z: ZoomSegment): ZoomSegment {
  const anchor = z.anchor && clampIntoCrop(c, z.anchor)
  const focus = z.focus.mode === 'fixed' ? clampIntoCrop(c, z.focus) : z.focus
  if (anchor === z.anchor && focus === z.focus) return z
  return anchor ? { ...z, focus, anchor } : { ...z, focus }
}

/**
 * The automatic zooms for `track` in the cropped frame: clicks outside the crop dropped and
 * anchors clamped into it, all in full-frame coordinates (never mapped into view space and back,
 * which is not exact). No crop: exactly autoZoomsForTrack.
 */
export function autoZoomsInFrame(
  track: CursorTrack,
  p: Pick<Project, 'crop' | 'width' | 'height' | 'duration'>,
  settings: AutoZoomSettings
): ZoomSegment[] {
  const c = cropOf(p)
  if (!c) return autoZoomsForTrack(track, p.duration, settings)
  return autoZoomsForTrack(shownTrack(track, c), p.duration, settings).map((z) => aimIntoCrop(c, z))
}

/** regenerateAutoZooms in the cropped frame (automatic zooms as autoZoomsInFrame; manual zooms the same objects). */
export function regenerateInFrame(
  zooms: ZoomSegment[],
  track: CursorTrack,
  p: Pick<Project, 'crop' | 'width' | 'height' | 'duration'>,
  settings?: AutoZoomSettings
): ReturnType<typeof regenerateAutoZooms> {
  const c = cropOf(p)
  if (!c) return regenerateAutoZooms(zooms, track, p.duration, settings)
  const r = regenerateAutoZooms(zooms, shownTrack(track, c), p.duration, settings)
  return { ...r, zooms: r.zooms.map((z) => (z.auto ? aimIntoCrop(c, z) : z)) }
}
