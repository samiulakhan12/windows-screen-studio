/**
 * Editing image overlays (docs/design/brand-kit.md §4.1): new overlays, moving, resizing and
 * rotating them on the preview. Positions are in the output frame; drags arrive in preview pixels.
 */
import { clamp } from '../engine/math'
import { cleanOverlayName, normalizeAngle, OVERLAY_LIMITS } from '../engine/overlayData'
import { stickerOf } from '../render/stickers'
import type { ImageOverlay } from '../types'
import { dragAnnotationTimes, MIN_ANNOTATION_LENGTH } from './annotations'

export const DEFAULT_OVERLAY_LENGTH = 3
export const MIN_OVERLAY_LENGTH = MIN_ANNOTATION_LENGTH
/** Long side of a new overlay, as a fraction of the frame's shorter side. */
export const NEW_IMAGE_SIDE = 0.35
export const NEW_STICKER_SIDE = 0.22
export const DEFAULT_OVERLAY_FADE = 0.2
/** Rotation steps while Shift is held, degrees. */
export const ROTATE_SNAP = 15

let idCounter = 0
export const newOverlayId = (): string => `o${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** Width and height (fractions of the shorter side) for an image of `aspect` (w / h) whose long side is `side`. */
export function sizeForAspect(aspect: number, side: number): { w: number; h: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  return a >= 1 ? { w: side, h: side / a } : { w: side * a, h: side }
}

/** What an overlay shows: a project image file (with the name it was imported from) or a built-in sticker. */
export type OverlaySource = { file: string; name?: string } | { sticker: string }

/** A new overlay at source time `t` (moved earlier when `t` is too close to the end), in the middle of the frame. */
export function createOverlay(t: number, duration: number, source: OverlaySource, aspect: number, id = newOverlayId()): ImageOverlay {
  const length = Math.min(DEFAULT_OVERLAY_LENGTH, duration)
  const start = clamp(t, 0, Math.max(0, duration - length))
  const sticker = 'sticker' in source
  const size = sizeForAspect(sticker ? 1 : aspect, sticker ? NEW_STICKER_SIDE : NEW_IMAGE_SIDE)
  const o: ImageOverlay = {
    id,
    start,
    end: Math.min(duration, start + length),
    x: 0.5,
    y: 0.5,
    ...size,
    rotation: 0,
    opacity: 1,
    fadeIn: DEFAULT_OVERLAY_FADE,
    fadeOut: DEFAULT_OVERLAY_FADE
  }
  if (sticker) o.sticker = source.sticker
  else {
    o.file = source.file
    const name = source.name ? cleanOverlayName(source.name) : ''
    if (name) o.name = name
  }
  return o
}

/** Timeline drags: the same rules as text (at least MIN_OVERLAY_LENGTH, inside the recording). */
export const dragOverlayTimes = dragAnnotationTimes

/** The name the editor shows for an overlay. */
export function overlayLabel(o: Pick<ImageOverlay, 'name' | 'sticker' | 'file'>): string {
  if (o.sticker) return `${stickerOf(o.sticker)?.name ?? 'Sticker'} sticker`
  return o.name || o.file || 'Image'
}

type Geometry = Pick<ImageOverlay, 'x' | 'y' | 'w' | 'h' | 'rotation'>
type Frame = { w: number; h: number }

const rotate = (x: number, y: number, a: number): { x: number; y: number } => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) })

const pos = (v: number): number => clamp(v, OVERLAY_LIMITS.pos.min, OVERLAY_LIMITS.pos.max)

/** The overlay moved by (dx, dy) preview pixels in a frame shown at `frame` pixels. */
export function moveOverlay(initial: Geometry, dx: number, dy: number, frame: Frame): Pick<ImageOverlay, 'x' | 'y'> {
  return { x: pos(initial.x + dx / frame.w), y: pos(initial.y + dy / frame.h) }
}

/** A resize handle: n, ne, e, se, s, sw, w, nw. */
export type OverlayHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

/**
 * The overlay resized by dragging `handle` by (dx, dy) preview pixels. The handle moves along the
 * overlay's own (rotated) axes and the opposite side stays where it is. With `keepAspect` (Shift)
 * both sides scale by the same factor. Sides stay within OVERLAY_LIMITS.side.
 */
export function resizeOverlay(initial: Geometry, handle: OverlayHandle, dx: number, dy: number, frame: Frame, keepAspect: boolean): Pick<ImageOverlay, 'x' | 'y' | 'w' | 'h'> {
  const m = Math.min(frame.w, frame.h)
  const a = (initial.rotation * Math.PI) / 180
  const local = rotate(dx, dy, -a)
  const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
  const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
  const bw = initial.w * m
  const bh = initial.h * m
  const minPx = OVERLAY_LIMITS.side.min * m
  const maxPx = OVERLAY_LIMITS.side.max * m
  let nw = sx ? bw + sx * local.x : bw
  let nh = sy ? bh + sy * local.y : bh
  if (keepAspect) {
    // The larger relative change wins; an edge handle scales the other side with it.
    const kx = sx ? nw / bw : 0
    const ky = sy ? nh / bh : 0
    let k = sx && sy ? (Math.abs(kx - 1) >= Math.abs(ky - 1) ? kx : ky) : sx ? kx : ky
    k = clamp(k, Math.max(minPx / bw, minPx / bh), Math.min(maxPx / bw, maxPx / bh))
    nw = bw * k
    nh = bh * k
  } else {
    nw = clamp(nw, minPx, maxPx)
    nh = clamp(nh, minPx, maxPx)
  }
  // The centre moves by half the growth toward the dragged side (in the overlay's axes).
  const shift = rotate((sx * (nw - bw)) / 2, (sy * (nh - bh)) / 2, a)
  return { x: pos(initial.x + shift.x / frame.w), y: pos(initial.y + shift.y / frame.h), w: nw / m, h: nh / m }
}

/**
 * The rotation that points the overlay's top at the pointer: 0° with the pointer straight above
 * the centre, clockwise positive. With `snap` (Shift), whole ROTATE_SNAP-degree steps.
 */
export function rotationToward(centre: { x: number; y: number }, pointer: { x: number; y: number }, snap: boolean): number {
  const deg = (Math.atan2(pointer.x - centre.x, -(pointer.y - centre.y)) * 180) / Math.PI
  return normalizeAngle(snap ? Math.round(deg / ROTATE_SNAP) * ROTATE_SNAP : Math.round(deg * 10) / 10)
}

/** The overlay with its shape back to the image's own aspect, keeping its long side and centre. */
export function resetOverlayShape(o: Pick<ImageOverlay, 'w' | 'h'>, aspect: number): Pick<ImageOverlay, 'w' | 'h'> {
  return sizeForAspect(aspect, Math.max(o.w, o.h))
}
