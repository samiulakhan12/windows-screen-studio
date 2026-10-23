import type { NormRect } from '../../../shared/types'

/** A rectangle in CSS pixels of the overlay (= DIP of the display). */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  w: number
  h: number
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** Smallest selectable area side, in DIP. */
export const MIN_SIZE = 32

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The rectangle spanned by a drag from `a` to `b`, kept inside the display. */
export function boxFromPoints(a: { x: number; y: number }, b: { x: number; y: number }, bounds: Size): Box {
  const x1 = clamp(Math.min(a.x, b.x), 0, bounds.w)
  const y1 = clamp(Math.min(a.y, b.y), 0, bounds.h)
  const x2 = clamp(Math.max(a.x, b.x), 0, bounds.w)
  const y2 = clamp(Math.max(a.y, b.y), 0, bounds.h)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export function moveBox(box: Box, dx: number, dy: number, bounds: Size): Box {
  return { ...box, x: clamp(box.x + dx, 0, bounds.w - box.w), y: clamp(box.y + dy, 0, bounds.h - box.h) }
}

/** Drags one edge or corner; the opposite side stays put and the size never drops below `min`. */
export function resizeBox(box: Box, handle: Handle, dx: number, dy: number, bounds: Size, min = MIN_SIZE): Box {
  let left = box.x
  let top = box.y
  let right = box.x + box.w
  let bottom = box.y + box.h
  if (handle.includes('w')) left = clamp(left + dx, 0, right - min)
  if (handle.includes('e')) right = clamp(right + dx, left + min, bounds.w)
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - min)
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + min, bounds.h)
  return { x: left, y: top, w: right - left, h: bottom - top }
}

export const isUsable = (box: Box | null, min = MIN_SIZE): box is Box => !!box && box.w >= min && box.h >= min

export function toNormRect(box: Box, bounds: Size): NormRect {
  return { x: box.x / bounds.w, y: box.y / bounds.h, w: box.w / bounds.w, h: box.h / bounds.h }
}

/** Size of the recording in physical pixels (as encoded: even numbers). */
export function pixelSize(box: Box, scale: number): { width: number; height: number } {
  const even = (v: number): number => Math.max(2, 2 * Math.floor((v * scale) / 2))
  return { width: even(box.w), height: even(box.h) }
}
