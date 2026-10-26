/**
 * Cropping the recording in the editor (E-10, docs/design/crop-in-editor.md). `Project.crop` is
 * one rectangle, normalised to the video frame, and every other stored position stays relative
 * to the FULL recorded frame. Rendering and measuring happen in *view space* (relative to the
 * crop) through one entry point, cropView(project, track): the scene is built from that view, so
 * the compositor, the camera and the layers keep their code. Without a crop every function here
 * returns its input (the same object), so projects without a crop are drawn exactly as before.
 *
 * Implemented and frozen (contracts commit): MIN_CROP_PX, FULL_FRAME, PixelRect, readCrop, cropOf,
 * and the pixel sizes (cropPixels, croppedFrameSize, visibleSize). The mappings are the identity
 * until E-10 lands (TODO(E-10) below); they are already exact without a crop.
 */
import type { AutoZoomSettings, CursorTrack, NormRect, Project, ZoomSegment } from '../types'
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

/** Whether a full-frame point is shown (exactly the view's own inVideo test after toCrop). */
export function inCrop(crop: NormRect | null, p: { x: number; y: number }): boolean {
  // TODO(E-10): inUnit(toCrop(crop, p)) with a crop.
  void crop
  return inUnit(p)
}

/** A full-frame point moved into the crop (the same object when it is already inside). */
export function clampIntoCrop<T extends { x: number; y: number }>(crop: NormRect | null, p: T): T {
  // TODO(E-10): clamp x into [c.x, c.x + c.w] and y into [c.y, c.y + c.h].
  void crop
  return p
}

/** A full-frame point in view space: ((x − c.x) / c.w, (y − c.y) / c.h). No crop: the same object. */
export function toCrop(crop: NormRect | null, p: { x: number; y: number }): { x: number; y: number } {
  // TODO(E-10): map with a crop.
  void crop
  return p
}

/** A view-space point in the full frame (the inverse of toCrop). No crop: the same object. */
export function fromCrop(crop: NormRect | null, p: { x: number; y: number }): { x: number; y: number } {
  // TODO(E-10): map with a crop.
  void crop
  return p
}

/** A full-frame rectangle in view space (negative w/h of lines and arrows map too). No crop: the same object. */
export function rectToCrop<R extends NormRect>(crop: NormRect | null, r: R): R {
  // TODO(E-10): x' = (x − c.x) / c.w, w' = w / c.w (and y, h).
  void crop
  return r
}

/** A view-space rectangle in the full frame (the inverse of rectToCrop). No crop: the same object. */
export function rectFromCrop<R extends NormRect>(crop: NormRect | null, r: R): R {
  // TODO(E-10): map with a crop.
  void crop
  return r
}

/** A view-space geometry patch (any of x, y, w, h) in the full frame; x and w map independently. No crop: the same object. */
export function geometryFromCrop<T extends Partial<NormRect>>(crop: NormRect | null, patch: T): T {
  // TODO(E-10): map each present field with a crop.
  void crop
  return patch
}

/** A zoom in view space: fixed point, region and anchor mapped; scale, times and `until` kept. No crop: the same object. */
export function zoomInView(crop: NormRect | null, z: ZoomSegment): ZoomSegment {
  // TODO(E-10): map focus and anchor with a crop.
  void crop
  return z
}

/** What cropProject reads and writes. */
export type CroppableProject = Pick<Project, 'width' | 'height' | 'zooms' | 'shapes' | 'spotlights' | 'crop'>

/**
 * The project as drawn: the crop's pixel size, zooms, shapes and spotlights in view space, and no
 * `crop` key; everything else shared. No crop: `p` itself.
 */
export function cropProject<P extends CroppableProject>(p: P): P {
  // TODO(E-10): build the memoised view when cropOf(p) is not null.
  return p
}

/** The cursor track in view space (samples, clicks, scrolls); memoised per array. No crop: `track` itself. */
export function cropTrack(track: CursorTrack, crop: NormRect | null): CursorTrack {
  // TODO(E-10): map with a crop.
  void crop
  return track
}

/** The single entry point the scene is built from: the project and track as drawn, and the snapped crop. */
export function cropView<P extends CroppableProject>(p: P, track: CursorTrack): { project: P; cursor: CursorTrack; crop: NormRect | null } {
  // TODO(E-10): memoise per (project, track) once the view is not the identity.
  const crop = cropOf(p)
  return { project: cropProject(p), cursor: cropTrack(track, crop), crop }
}

/**
 * The automatic zooms for `track` in the cropped frame: clicks outside the crop dropped and
 * anchors clamped into it, all in full-frame coordinates. No crop: exactly autoZoomsForTrack.
 */
export function autoZoomsInFrame(
  track: CursorTrack,
  p: Pick<Project, 'crop' | 'width' | 'height' | 'duration'>,
  settings: AutoZoomSettings
): ZoomSegment[] {
  // TODO(E-10): filter hidden clicks and clamp anchors when cropOf(p) is not null.
  return autoZoomsForTrack(track, p.duration, settings)
}

/** regenerateAutoZooms in the cropped frame (automatic zooms as autoZoomsInFrame; manual zooms the same objects). */
export function regenerateInFrame(
  zooms: ZoomSegment[],
  track: CursorTrack,
  p: Pick<Project, 'crop' | 'width' | 'height' | 'duration'>,
  settings?: AutoZoomSettings
): ReturnType<typeof regenerateAutoZooms> {
  // TODO(E-10): hidden clicks out and auto anchors clamped when cropOf(p) is not null.
  return regenerateAutoZooms(zooms, track, p.duration, settings)
}
