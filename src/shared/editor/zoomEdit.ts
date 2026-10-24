/**
 * Pure editing operations for zoom segments used by the zoom inspector, the timeline,
 * the preview's region editor and the level shortcuts. Like the helpers in engine/zoom,
 * they only ever change the zoom being edited.
 */
import { clamp } from '../engine/math'
import {
  connectGap,
  DEFAULT_ZOOM_STYLE,
  MIN_ZOOM_LENGTH,
  regionScale,
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE,
  zoomsConnected,
  type ZoomStyle
} from '../engine/zoom'
import type { ZoomFocus, ZoomSegment } from '../types'

export type ZoomRegion = Extract<ZoomFocus, { mode: 'region' }>

/**
 * Level presets offered as chips; `key` is the default keyboard shortcut that sets it (the
 * zoomLevel<key> command, which can be rebound).
 */
export const ZOOM_LEVEL_PRESETS: { value: number; key: string; label: string; title: string }[] = [
  { value: 0.75, key: '0', label: '0.75×', title: 'Pull back: show more background' },
  { value: 1.25, key: '1', label: '1.25×', title: 'Zoom 1.25×' },
  { value: 1.5, key: '2', label: '1.5×', title: 'Zoom 1.5×' },
  { value: 2, key: '3', label: '2×', title: 'Zoom 2×' },
  { value: 3, key: '4', label: '3×', title: 'Zoom 3×' }
]

/** Zoom level for a number key ('0' pulls back, '1'-'4' zoom in), or null. */
export function levelForKey(key: string): number | null {
  return ZOOM_LEVEL_PRESETS.find((p) => p.key === key)?.value ?? null
}

/** "2×", "1.25×", "0.75×". */
export function formatLevel(scale: number): string {
  return `${+scale.toFixed(2)}×`
}

/** Smallest side a region may have (normalised). */
export const MIN_REGION_SIDE = 0.03

/**
 * A region kept inside the recording, at least MIN_REGION_SIDE on each side and large
 * enough that framing it needs no more than the maximum zoom level.
 */
export function normalizeRegion(r: { x: number; y: number; w: number; h: number }): ZoomRegion {
  let w = clamp(Number.isFinite(r.w) ? r.w : 0.5, MIN_REGION_SIDE, 1)
  let h = clamp(Number.isFinite(r.h) ? r.h : 0.5, MIN_REGION_SIDE, 1)
  const need = 1 / ZOOM_MAX_SCALE
  if (Math.max(w, h) < need) {
    // Grow the longer side (keeping the shape) until the maximum zoom can frame it.
    const k = need / Math.max(w, h)
    w = Math.min(1, w * k)
    h = Math.min(1, h * k)
  }
  const cx = (Number.isFinite(r.x) ? r.x : 0.25) + (Number.isFinite(r.w) ? r.w : 0.5) / 2
  const cy = (Number.isFinite(r.y) ? r.y : 0.25) + (Number.isFinite(r.h) ? r.h : 0.5) / 2
  return { mode: 'region', x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h }
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Part of a region the user drags on the preview: the whole box, an edge or a corner. */
export type RegionHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * The region after dragging `handle` by (dx, dy) (normalised source units): moving keeps it
 * inside the recording, resizing keeps the opposite edges where they are. With `keepShape`
 * a corner drag keeps the box's proportions.
 */
export function dragRegion(r: Box, handle: RegionHandle, dx: number, dy: number, keepShape = false): Box {
  if (handle === 'move') return { x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h), w: r.w, h: r.h }
  let x0 = r.x
  let y0 = r.y
  let x1 = r.x + r.w
  let y1 = r.y + r.h
  if (handle.includes('w')) x0 = clamp(x0 + dx, 0, x1 - MIN_REGION_SIDE)
  if (handle.includes('e')) x1 = clamp(x1 + dx, x0 + MIN_REGION_SIDE, 1)
  if (handle.includes('n')) y0 = clamp(y0 + dy, 0, y1 - MIN_REGION_SIDE)
  if (handle.includes('s')) y1 = clamp(y1 + dy, y0 + MIN_REGION_SIDE, 1)
  if (keepShape && handle.length === 2 && r.w > 0 && r.h > 0) {
    const ratio = r.w / r.h
    let w = x1 - x0
    let h = y1 - y0
    if (w / h > ratio) w = h * ratio
    else h = w / ratio
    if (handle.includes('w')) x0 = x1 - w
    else x1 = x0 + w
    if (handle.includes('n')) y0 = y1 - h
    else y1 = y0 + h
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * The box spanned by two points dragged out on the preview, inside the recording. With
 * `keepShape` it has the recording's own proportions (equal normalised sides), so it fills
 * the frame exactly when zoomed.
 */
export function regionFromPoints(a: { x: number; y: number }, b: { x: number; y: number }, keepShape = false): Box {
  const ax = clamp(a.x, 0, 1)
  const ay = clamp(a.y, 0, 1)
  let bx = clamp(b.x, 0, 1)
  let by = clamp(b.y, 0, 1)
  if (keepShape) {
    const side = Math.min(Math.max(Math.abs(bx - ax), Math.abs(by - ay)), bx >= ax ? 1 - ax : ax, by >= ay ? 1 - ay : ay)
    bx = ax + Math.sign(bx - ax || 1) * side
    by = ay + Math.sign(by - ay || 1) * side
  }
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

/** The region a zoom at `scale` centred on (cx, cy) shows (what switching to Region starts from). */
export function regionAround(cx: number, cy: number, scale: number): ZoomRegion {
  const side = 1 / clamp(scale, 1, ZOOM_MAX_SCALE)
  return normalizeRegion({ x: cx - side / 2, y: cy - side / 2, w: side, h: side })
}

/**
 * The zoom at another level. A region zoom keeps its centre and shape and its rectangle is
 * resized to frame the new level; pulling a region zoom back (below 1) turns it into a
 * fixed-point zoom on the region's centre.
 */
export function setZoomLevel(z: ZoomSegment, level: number): ZoomSegment {
  const scale = clamp(level, ZOOM_MIN_SCALE, ZOOM_MAX_SCALE)
  const f = z.focus
  if (f.mode === 'region') {
    const cx = f.x + f.w / 2
    const cy = f.y + f.h / 2
    if (scale < 1) return { ...z, scale, focus: { mode: 'fixed', x: cx, y: cy }, auto: false }
    const k = 1 / scale / Math.max(f.w, f.h)
    const region = normalizeRegion({ x: cx - (f.w * k) / 2, y: cy - (f.h * k) / 2, w: f.w * k, h: f.h * k })
    return { ...z, scale: regionScale(region), focus: region, auto: false }
  }
  return { ...z, scale, auto: false }
}

/** A zoom that frames `region` (its level follows from the rectangle). */
export function setZoomRegion(z: ZoomSegment, region: { x: number; y: number; w: number; h: number }): ZoomSegment {
  const r = normalizeRegion(region)
  return { ...z, focus: r, scale: regionScale(r), auto: false }
}

/** The zoom that comes right after `id` (by start time), if any. */
export function nextZoom(zooms: ZoomSegment[], id: string): ZoomSegment | null {
  const z = zooms.find((x) => x.id === id)
  if (!z) return null
  let best: ZoomSegment | null = null
  for (const o of zooms) {
    if (o.id === id || o.start < z.start || (o.start === z.start && o.end <= z.end)) continue
    if (!best || o.start < best.start) best = o
  }
  return best
}

/** True when the camera pans from zoom `id` straight into the next one. */
export function isConnectedToNext(zooms: ZoomSegment[], id: string, style: ZoomStyle = DEFAULT_ZOOM_STYLE): boolean {
  const z = zooms.find((x) => x.id === id)
  const next = nextZoom(zooms, id)
  return !!z && !!next && zoomsConnected(z, next, style)
}

/** Ids of the zooms that pan straight into their next zoom (for the timeline). */
export function connectedZoomIds(zooms: ZoomSegment[], style: ZoomStyle = DEFAULT_ZOOM_STYLE): Set<string> {
  const sorted = [...zooms].sort((a, b) => a.start - b.start)
  const out = new Set<string>()
  for (let i = 0; i + 1 < sorted.length; i++) if (zoomsConnected(sorted[i], sorted[i + 1], style)) out.add(sorted[i].id)
  return out
}

/**
 * "Pan to next zoom": extends zoom `id` up to the next zoom so the two touch, and the camera
 * moves from one to the other without zooming out. Null when there is no next zoom.
 */
export function connectToNext(zooms: ZoomSegment[], id: string): ZoomSegment[] | null {
  const next = nextZoom(zooms, id)
  if (!next) return null
  return zooms.map((z) => (z.id === id ? { ...z, end: Math.max(z.start + MIN_ZOOM_LENGTH, next.start), auto: false } : z))
}

/**
 * Undoes "Pan to next zoom": ends zoom `id` early enough that the camera returns to the full
 * frame before the next zoom. Null when the zoom would become too short (or has no next zoom).
 */
export function disconnectFromNext(zooms: ZoomSegment[], id: string, style: ZoomStyle = DEFAULT_ZOOM_STYLE): ZoomSegment[] | null {
  const z = zooms.find((x) => x.id === id)
  const next = nextZoom(zooms, id)
  if (!z || !next) return null
  const end = next.start - connectGap(z, next, style) - 0.05
  if (end - z.start < MIN_ZOOM_LENGTH) return null
  return zooms.map((x) => (x.id === id ? { ...x, end, auto: false } : x))
}

/** Every zoom follows the project's zoom style again (per-zoom easing and speed removed). */
export function clearZoomStyles(zooms: ZoomSegment[]): ZoomSegment[] {
  if (!zooms.some((z) => z.easing !== undefined || z.transition !== undefined)) return zooms
  return zooms.map((z) => {
    if (z.easing === undefined && z.transition === undefined) return z
    const { easing: _e, transition: _t, ...rest } = z
    void _e
    void _t
    return rest
  })
}
