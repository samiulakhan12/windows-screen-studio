/**
 * *Adjust* in the full-size viewer (docs/design/smart-tools.md §5.5.3): moving and resizing a
 * step's crop and moving its ring, as fractions of the recorded frame. Arrows move the focused one
 * by 1% of the frame (Shift: 10%), Alt with arrows resizes the crop; a crop is never under 5% of the
 * frame nor past its edges, and snaps to an edge within 8 px. Pure.
 */
import type { NormRect } from '../types'

/** The smallest crop (a share of the frame's width and height). */
export const MIN_CROP = 0.05
/** One arrow press, and with Shift. */
export const STEP_SMALL = 0.01
export const STEP_BIG = 0.1
/** Distance (px of the frame) within which a dragged edge snaps to the frame's edge. */
export const SNAP_PX = 8

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const round = (v: number): number => Math.round(v * 1e6) / 1e6

/** The direction of an arrow key, or null. */
function arrow(key: string): { dx: number; dy: number } | null {
  switch (key) {
    case 'ArrowLeft':
      return { dx: -1, dy: 0 }
    case 'ArrowRight':
      return { dx: 1, dy: 0 }
    case 'ArrowUp':
      return { dx: 0, dy: -1 }
    case 'ArrowDown':
      return { dx: 0, dy: 1 }
    default:
      return null
  }
}

/** `rect` kept inside the frame, at least MIN_CROP wide and high. */
export function fitCrop(rect: NormRect): NormRect {
  const w = clamp(rect.w, MIN_CROP, 1)
  const h = clamp(rect.h, MIN_CROP, 1)
  return { x: round(clamp(rect.x, 0, 1 - w)), y: round(clamp(rect.y, 0, 1 - h)), w: round(w), h: round(h) }
}

/** The ring after an arrow key (Shift: 10%), kept on the frame; null for any other key. */
export function nudgeRing(ring: { x: number; y: number }, key: string, shift: boolean): { x: number; y: number } | null {
  const d = arrow(key)
  if (!d) return null
  const step = shift ? STEP_BIG : STEP_SMALL
  return { x: round(clamp(ring.x + d.dx * step, 0, 1)), y: round(clamp(ring.y + d.dy * step, 0, 1)) }
}

/** The crop after an arrow key: moved (Shift: 10%) or, with Alt, resized from its right and bottom edges; null for any other key. */
export function nudgeCrop(rect: NormRect, key: string, shift: boolean, alt: boolean): NormRect | null {
  const d = arrow(key)
  if (!d) return null
  const step = shift ? STEP_BIG : STEP_SMALL
  if (alt) return fitCrop({ ...rect, w: Math.min(1 - rect.x, rect.w + d.dx * step), h: Math.min(1 - rect.y, rect.h + d.dy * step) })
  return fitCrop({ ...rect, x: rect.x + d.dx * step, y: rect.y + d.dy * step })
}

/** `rect`'s edges within SNAP_PX px of the frame's moved onto them (frame `w` × `h` px). */
export function snapCrop(rect: NormRect, frame: { w: number; h: number }): NormRect {
  const sx = SNAP_PX / Math.max(1, frame.w)
  const sy = SNAP_PX / Math.max(1, frame.h)
  let { x, y, w, h } = rect
  if (x < sx) {
    w += x
    x = 0
  }
  if (y < sy) {
    h += y
    y = 0
  }
  if (1 - (x + w) < sx) w = 1 - x
  if (1 - (y + h) < sy) h = 1 - y
  return fitCrop({ x, y, w, h })
}

/**
 * Adjust draws over the part of the recorded frame the video shows (`shown`, pixels of `frame`, the
 * crop's), while a step's `rect` and `ring` are stored as fractions of the recorded frame: a point as
 * fractions of the shown part, and back.
 */
export function pointInShown(p: { x: number; y: number }, frame: { w: number; h: number }, shown: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: round((p.x * frame.w - shown.x) / shown.w), y: round((p.y * frame.h - shown.y) / shown.h) }
}
export function pointFromShown(p: { x: number; y: number }, frame: { w: number; h: number }, shown: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: round((shown.x + p.x * shown.w) / frame.w), y: round((shown.y + p.y * shown.h) / frame.h) }
}
/** A crop as fractions of the shown part (pointInShown), and back. */
export function rectInShown(r: NormRect, frame: { w: number; h: number }, shown: { x: number; y: number; w: number; h: number }): NormRect {
  return { ...pointInShown(r, frame, shown), w: round((r.w * frame.w) / shown.w), h: round((r.h * frame.h) / shown.h) }
}
export function rectFromShown(r: NormRect, frame: { w: number; h: number }, shown: { x: number; y: number; w: number; h: number }): NormRect {
  return { ...pointFromShown(r, frame, shown), w: round((r.w * shown.w) / frame.w), h: round((r.h * shown.h) / frame.h) }
}

/** Whether a crop drawn by hand is big enough to keep (§5.5.3: under 5% of the frame is refused). */
export const cropOk = (rect: NormRect): boolean => rect.w >= MIN_CROP - 1e-9 && rect.h >= MIN_CROP - 1e-9

/** How a screen reader hears the crop: "Crop, 45% wide, from 20% across and 10% down". */
export const cropName = (r: NormRect): string => `Crop, ${Math.round(r.w * 100)}% wide, from ${Math.round(r.x * 100)}% across and ${Math.round(r.y * 100)}% down`
/** How a screen reader hears the ring: "Ring at 42% across, 30% down". */
export const ringName = (p: { x: number; y: number }): string => `Ring at ${Math.round(p.x * 100)}% across, ${Math.round(p.y * 100)}% down`
