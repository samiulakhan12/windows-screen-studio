/**
 * The crop tool's maths and the crop edit (E-10, docs/design/crop-in-editor.md §4.7–4.9): drags
 * in recorded pixels with aspect locks, edge magnets and whole-pixel snapping, the taskbar and
 * browser-bar presets, and applying a crop as one undo step (rebasing the automatic zooms).
 * Zoom edits made in the crop's view (levels and regions relative to what is shown) are here too.
 */
import { autoZoomsInFrame, cropOf, inCrop, MIN_CROP_PX, readCrop, visibleSize, zoomFromView, zoomInView } from '../engine/crop'
import { clamp } from '../engine/math'
import { rebaseAutoZooms, zoomSettingsOf } from '../engine/zoom'
import type { CursorTrack, NormRect, Project, ZoomSegment } from '../types'
import { shapeBounds } from './shapes'
import { setZoomLevel, setZoomRegion, type RegionHandle } from './zoomEdit'

export type CropAspect = 'free' | 'original' | '16:9' | '4:3' | '1:1' | '9:16'
/** The crop being edited (held by the Editor until Done). */
export interface CropDraft {
  rect: NormRect
  aspect: CropAspect
}
/** Items left outside a crop (they come back when it is widened). */
export interface OutsideCount {
  zooms: number
  shapes: number
  spotlights: number
}
/** What applying a crop did. */
export interface CropOutcome {
  project: Project
  removedAutoZooms: number
  restoredAutoZooms: number
  outside: OutsideCount
}

/** The aspect chips, in order. */
export const CROP_ASPECTS: readonly CropAspect[] = ['free', 'original', '16:9', '4:3', '1:1', '9:16']
/** Height of the Windows taskbar at 100% scaling (DIP). */
export const TASKBAR_DIP = 48
/** Height of a maximised browser's tabs and address bar at 100% scaling (DIP). */
export const BROWSER_BAR_DIP = 88
/** A crop shorter than this (recorded px) gets the "larger exports will be upscaled" hint. */
export const SMALL_CROP_PX = 720

const FIXED_RATIOS: Record<Exclude<CropAspect, 'free' | 'original'>, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '9:16': 9 / 16 }

/** The pixel ratio (width / height) an aspect locks to; null for free. */
export function cropRatio(a: CropAspect, width: number, height: number): number | null {
  if (a === 'free') return null
  if (a === 'original') return width > 0 && height > 0 ? width / height : null
  return FIXED_RATIOS[a]
}

type Size = { width: number; height: number }

/** Recorded pixels a crop keeps at least on a side `side` pixels long (all of it when shorter). */
const minSide = (side: number): number => Math.min(MIN_CROP_PX, side)

/**
 * A pixel span [a, b] kept inside [0, max] and at least `min` long (grown on the side that has
 * room), so an odd start (a rectangle already smaller than allowed) still ends up valid.
 */
function span(a: number, b: number, min: number, max: number): [number, number] {
  let lo = clamp(Math.min(a, b), 0, max)
  let hi = clamp(Math.max(a, b), 0, max)
  if (hi - lo < min) {
    hi = Math.min(max, lo + min)
    lo = Math.max(0, hi - min)
  }
  return [lo, hi]
}

/** A pixel rectangle (edges) as a normalised one, kept inside the frame and at least the minimum size. */
function normalised(x0: number, y0: number, x1: number, y1: number, { width: W, height: H }: Size): NormRect {
  const [a, b] = span(x0, x1, minSide(W), W)
  const [c, d] = span(y0, y1, minSide(H), H)
  return { x: a / W, y: c / H, w: (b - a) / W, h: (d - c) / H }
}

/** The draft after dragging `handle` by (dx, dy) (normalised), kept inside the frame and at least MIN_CROP_PX a side. */
export function dragCrop(r: NormRect, handle: RegionHandle, dx: number, dy: number, size: { width: number; height: number }, ratio: number | null): NormRect {
  const { width: W, height: H } = size
  if (!(W > 0 && H > 0)) return r
  const x0 = r.x * W
  const x1 = (r.x + r.w) * W
  const y0 = r.y * H
  const y1 = (r.y + r.h) * H
  const mx = dx * W
  const my = dy * H
  if (handle === 'move') {
    const nx = clamp(x0 + mx, 0, Math.max(0, W - (x1 - x0)))
    const ny = clamp(y0 + my, 0, Math.max(0, H - (y1 - y0)))
    return normalised(nx, ny, nx + (x1 - x0), ny + (y1 - y0), size)
  }
  if (ratio && ratio > 0) return lockedDrag([x0, y0, x1, y1], handle, mx, my, size, ratio)
  const minW = minSide(W)
  const minH = minSide(H)
  const nx0 = handle.includes('w') ? clamp(x0 + mx, 0, x1 - minW) : x0
  const nx1 = handle.includes('e') ? clamp(x1 + mx, x0 + minW, W) : x1
  const ny0 = handle.includes('n') ? clamp(y0 + my, 0, y1 - minH) : y0
  const ny1 = handle.includes('s') ? clamp(y1 + my, y0 + minH, H) : y1
  return normalised(nx0, ny0, nx1, ny1, size)
}

/**
 * A drag of a handle with the pixel ratio locked to `R`. A corner keeps the opposite corner where
 * it is and takes the larger of the two sizes the pointer asks for, as far as the frame allows. An
 * edge moves only that edge; the other side follows the ratio around the box's centre, shifted to
 * stay inside the frame.
 */
function lockedDrag(edges: [number, number, number, number], handle: RegionHandle, mx: number, my: number, size: Size, R: number): NormRect {
  const { width: W, height: H } = size
  const [x0, y0, x1, y1] = edges
  // Smallest width that keeps both sides at least the minimum.
  const least = Math.max(minSide(W), minSide(H) * R)
  if (handle === 'n' || handle === 's') {
    const south = handle === 's'
    const ay = south ? y0 : y1
    const room = south ? H - ay : ay
    const h = Math.max(Math.min(Math.max(0, south ? y1 + my - ay : ay - (y0 + my)), room, W / R), least / R)
    const w = h * R
    const nx = clamp((x0 + x1) / 2 - w / 2, 0, Math.max(0, W - w))
    const ny = south ? ay : ay - h
    return normalised(nx, ny, nx + w, ny + h, size)
  }
  if (handle === 'e' || handle === 'w') {
    const east = handle === 'e'
    const ax = east ? x0 : x1
    const room = east ? W - ax : ax
    const w = Math.max(Math.min(Math.max(0, east ? x1 + mx - ax : ax - (x0 + mx)), room, H * R), least)
    const h = w / R
    const ny = clamp((y0 + y1) / 2 - h / 2, 0, Math.max(0, H - h))
    const nx = east ? ax : ax - w
    return normalised(nx, ny, nx + w, ny + h, size)
  }
  const east = handle.includes('e')
  const south = handle.includes('s')
  // The opposite corner stays.
  const ax = east ? x0 : x1
  const ay = south ? y0 : y1
  const wantW = Math.max(0, east ? x1 + mx - ax : ax - (x0 + mx))
  const wantH = Math.max(0, south ? y1 + my - ay : ay - (y0 + my))
  const w = Math.max(Math.min(Math.max(wantW, wantH * R), east ? W - ax : ax, (south ? H - ay : ay) * R), least)
  const h = w / R
  const nx = east ? ax : ax - w
  const ny = south ? ay : ay - h
  return normalised(nx, ny, nx + w, ny + h, size)
}

/** The largest rectangle of pixel ratio `ratio` inside `r`, around its centre. */
export function fitCropAspect(r: NormRect, ratio: number, size: { width: number; height: number }): NormRect {
  const { width: W, height: H } = size
  if (!(W > 0 && H > 0 && ratio > 0)) return r
  // The largest fit, at least the minimum size and never larger than the frame.
  const w = clamp(Math.min(r.w * W, r.h * H * ratio), Math.max(minSide(W), minSide(H) * ratio), Math.min(W, H * ratio))
  const h = w / ratio
  const x = clamp((r.x + r.w / 2) * W - w / 2, 0, Math.max(0, W - w))
  const y = clamp((r.y + r.h / 2) * H - h / 2, 0, Math.max(0, H - h))
  return normalised(x, y, x + w, y + h, size)
}

/**
 * `r` with edges near the frame's edges snapped to them, then rounded to whole pixels (and to
 * `ratio`). Free, each edge within `magnet` (normalised) of the frame's edge snaps to it: with a
 * `handle`, only the edges it moves, so a thin cut on another edge (a hidden taskbar) stays. With a
 * ratio, the magnet moves the whole rectangle instead, so its shape stays, and the height follows
 * the rounded width (±1 px).
 */
export function snapCrop(r: NormRect, size: { width: number; height: number }, magnet: { x: number; y: number }, ratio: number | null, handle?: RegionHandle): NormRect {
  const { width: W, height: H } = size
  if (!(W > 0 && H > 0)) return r
  let x0 = r.x
  let x1 = r.x + r.w
  let y0 = r.y
  let y1 = r.y + r.h
  if (ratio && ratio > 0) {
    const sx = x0 < magnet.x ? -x0 : 1 - x1 < magnet.x ? 1 - x1 : 0
    const sy = y0 < magnet.y ? -y0 : 1 - y1 < magnet.y ? 1 - y1 : 0
    const w = clamp(Math.round((x1 - x0) * W), 1, W)
    const h = clamp(Math.round(w / ratio), 1, H)
    const x = clamp(Math.round((x0 + sx) * W), 0, W - w)
    const y = clamp(Math.round((y0 + sy) * H), 0, H - h)
    return { x: x / W, y: y / H, w: w / W, h: h / H }
  }
  const moves = (edge: 'n' | 's' | 'e' | 'w'): boolean => !handle || handle === 'move' || handle.includes(edge)
  if (moves('w') && x0 < magnet.x) x0 = 0
  if (moves('e') && 1 - x1 < magnet.x) x1 = 1
  if (moves('n') && y0 < magnet.y) y0 = 0
  if (moves('s') && 1 - y1 < magnet.y) y1 = 1
  const px0 = clamp(Math.round(x0 * W), 0, W - 1)
  const px1 = clamp(Math.round(x1 * W), px0 + 1, W)
  const py0 = clamp(Math.round(y0 * H), 0, H - 1)
  const py1 = clamp(Math.round(y1 * H), py0 + 1, H)
  return { x: px0 / W, y: py0 / H, w: (px1 - px0) / W, h: (py1 - py0) / H }
}

/** The recorded region and what was recorded, as CaptureInfo documents their defaults. */
function captured(p: Pick<Project, 'capture'>): { region: NormRect; target: 'screen' | 'area' | 'window' } {
  const region = p.capture.region ?? { x: 0, y: 0, w: 1, h: 1 }
  return { region, target: p.capture.target ?? (p.capture.region ? 'area' : 'screen') }
}

/** A display scale factor, 1 when unknown (cursor.json files from before it was recorded). */
const scaleOf = (scale: number | undefined): number => (typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1)

/** Most of the recording's height a preset cuts off: more is not a bar. */
const MAX_CUT = 0.25

/** The draft with its bottom edge above the Windows taskbar, or null when the recording does not show it. */
export function taskbarCrop(r: NormRect, p: Pick<Project, 'capture' | 'width' | 'height'>, scale: number | undefined): NormRect | null {
  const { region, target } = captured(p)
  if (target === 'window' || !(p.height > 0) || !(region.h > 0)) return null
  // The taskbar's height in video pixels, less the part of the screen below the recorded area.
  const cut = (region.y + region.h - 1) / region.h + (TASKBAR_DIP * scaleOf(scale)) / p.height
  if (!(cut > 0 && cut <= MAX_CUT)) return null
  const bottom = 1 - cut
  const top = Math.min(r.y, bottom - minSide(p.height) / p.height)
  return { x: r.x, y: Math.max(0, top), w: r.w, h: bottom - Math.max(0, top) }
}

/** The draft with its top edge below a maximised browser's tabs and address bar, or null when not offered. */
export function browserBarCrop(r: NormRect, p: Pick<Project, 'capture' | 'width' | 'height'>, scale: number | undefined): NormRect | null {
  const { region, target } = captured(p)
  if ((target === 'area' && region.y !== 0) || !(p.height > 0)) return null
  const cut = (BROWSER_BAR_DIP * scaleOf(scale)) / p.height
  if (!(cut > 0 && cut <= MAX_CUT)) return null
  const bottom = Math.max(r.y + r.h, cut + minSide(p.height) / p.height)
  return { x: r.x, y: cut, w: r.w, h: Math.min(1, bottom) - cut }
}

/** True when the rectangle and the crop share no area (lines and arrows: their bounds). */
const misses = (b: NormRect, c: NormRect): boolean => b.x + b.w <= c.x || b.x >= c.x + c.w || b.y + b.h <= c.y || b.y >= c.y + c.h

/** Zooms, shapes and region spotlights of `p` outside `crop`. */
export function outsideCrop(p: Project, crop: NormRect | null): OutsideCount {
  if (!crop) return { zooms: 0, shapes: 0, spotlights: 0 }
  const zoomOutside = (z: ZoomSegment): boolean => {
    const f = z.focus
    if (f.mode === 'fixed') return !inCrop(crop, f)
    if (f.mode === 'region') return misses(f, crop)
    // A cursor-following zoom aims at its anchor (the click or the field it was made for).
    return !!z.anchor && !inCrop(crop, z.anchor)
  }
  return {
    zooms: p.zooms.filter(zoomOutside).length,
    shapes: (p.shapes ?? []).filter((s) => misses(shapeBounds(s), crop)).length,
    spotlights: (p.spotlights ?? []).filter((s) => s.mode === 'region' && misses(shapeBounds(s), crop)).length
  }
}

const sameCrop = (a: NormRect | null, b: NormRect | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9 && Math.abs(a.w - b.w) <= 1e-9 && Math.abs(a.h - b.h) <= 1e-9

const NOTHING_OUTSIDE: OutsideCount = Object.freeze({ zooms: 0, shapes: 0, spotlights: 0 })

/**
 * Applies a crop (null: the whole recording) as one edit, rebasing the automatic zooms when
 * `track` is given (the effective track): with auto zoom on, rebaseAutoZooms between
 * autoZoomsInFrame for the old and the new crop removes the zooms made for clicks the crop hides
 * and brings back those a wider crop shows again. `p` itself (nothing counted) when the crop
 * draws the same pixels as the current one, so an unchanged Done adds no undo step.
 */
export function setCrop(p: Project, crop: NormRect | null, track: CursorTrack | null): CropOutcome {
  const c = crop ? readCrop(crop, p.width, p.height) : undefined
  const { crop: _old, ...rest } = p
  let next: Project = c ? { ...p, crop: c } : rest
  if (sameCrop(cropOf(p), cropOf(next))) return { project: p, removedAutoZooms: 0, restoredAutoZooms: 0, outside: NOTHING_OUTSIDE }
  let removedAutoZooms = 0
  let restoredAutoZooms = 0
  const auto = zoomSettingsOf(p).auto
  if (track && auto.enabled) {
    const zooms = rebaseAutoZooms(p.zooms, autoZoomsInFrame(track, p, auto), autoZoomsInFrame(track, next, auto))
    if (zooms !== p.zooms) {
      removedAutoZooms = p.zooms.filter((z) => z.auto && !zooms.includes(z)).length
      restoredAutoZooms = zooms.filter((z) => !p.zooms.includes(z)).length
      next = { ...next, zooms }
    }
  }
  return { project: next, removedAutoZooms, restoredAutoZooms, outside: outsideCrop(next, cropOf(next)) }
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The notice after Done: "Cropped to 1920 × 1032." plus what happened to zooms and items. */
export function cropNotice(o: CropOutcome): string {
  const size = visibleSize(o.project)
  const parts = [cropOf(o.project) ? `Cropped to ${size.width} × ${size.height}.` : 'Showing the whole recording.']
  // A zoom replaced (a merged zoom split around a hidden click) is removed and added: it was adjusted.
  const adjusted = Math.min(o.removedAutoZooms, o.restoredAutoZooms)
  const removed = o.removedAutoZooms - adjusted
  const restored = o.restoredAutoZooms - adjusted
  if (removed) parts.push(`${count(removed, 'automatic zoom for a click outside it was', 'automatic zooms for clicks outside it were')} removed.`)
  if (adjusted) parts.push(`${count(adjusted, 'automatic zoom was', 'automatic zooms were')} adjusted.`)
  if (restored) parts.push(`${count(restored, 'automatic zoom', 'automatic zooms')} came back.`)
  const { zooms, shapes, spotlights } = o.outside
  const items = [
    zooms ? count(zooms, 'zoom', 'zooms') : '',
    shapes ? count(shapes, 'shape', 'shapes') : '',
    spotlights ? count(spotlights, 'spotlight', 'spotlights') : ''
  ].filter(Boolean)
  if (items.length) {
    const one = zooms + shapes + spotlights === 1
    const list = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0]
    parts.push(`${list} ${one ? 'is' : 'are'} outside it; ${one ? 'it comes' : 'they come'} back if you widen the crop.`)
  }
  return parts.join(' ')
}

/**
 * setZoomLevel with the level relative to what the crop shows (levels are relative to the visible
 * frame): a region zoom's rectangle is resized in the crop's view and stored in the full frame.
 * No crop, or a zoom without a region: exactly setZoomLevel.
 */
export function setZoomLevelInView(crop: NormRect | null, z: ZoomSegment, level: number): ZoomSegment {
  if (!crop || z.focus.mode !== 'region') return setZoomLevel(z, level)
  return zoomFromView(crop, setZoomLevel(zoomInView(crop, z), level))
}

/**
 * setZoomRegion with a region drawn in the crop's view (on the preview): it is kept inside the
 * crop and at most the maximum zoom level of the view, then stored in the full frame. No crop:
 * exactly setZoomRegion.
 */
export function setZoomRegionInView(crop: NormRect | null, z: ZoomSegment, region: { x: number; y: number; w: number; h: number }): ZoomSegment {
  if (!crop) return setZoomRegion(z, region)
  return zoomFromView(crop, setZoomRegion(zoomInView(crop, z), region))
}
