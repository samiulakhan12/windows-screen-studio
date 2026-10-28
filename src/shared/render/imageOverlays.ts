/**
 * Timing and geometry of image overlays and GIF frames (docs/design/brand-kit.md §4.1, §4.2).
 * Pure: the overlay layer, the preview's handles and the tests use the same numbers, so the
 * preview and the export draw an overlay in the same place, with the same alpha and GIF frame.
 */
import { clamp } from '../engine/math'
import type { Clip, ImageOverlay } from '../types'
import { viewingTime } from './overlays'

/** Where an overlay is drawn in a w x h frame: centre, size (px) and clockwise angle (radians). */
export interface OverlayBox {
  cx: number
  cy: number
  w: number
  h: number
  angle: number
}

export function overlayBox(o: Pick<ImageOverlay, 'x' | 'y' | 'w' | 'h' | 'rotation'>, w: number, h: number): OverlayBox {
  const m = Math.min(w, h)
  return { cx: o.x * w, cy: o.y * h, w: o.w * m, h: o.h * m, angle: (o.rotation * Math.PI) / 180 }
}

export const overlayVisibleAt = (o: Pick<ImageOverlay, 'start' | 'end'>, t: number): boolean => t >= o.start && t < o.end

/**
 * Opacity at source time `t`: the overlay's opacity, faded in after its start and out before its
 * end over output (edit) time, so a speed change or a cut inside it never shortens a fade. Fades
 * longer than the overlay together share it in proportion.
 */
export function overlayAlpha(o: Pick<ImageOverlay, 'start' | 'end' | 'opacity' | 'fadeIn' | 'fadeOut'>, t: number, clips: Clip[]): number {
  if (!overlayVisibleAt(o, t)) return 0
  const e = viewingTime(clips, t)
  const e0 = viewingTime(clips, o.start)
  const e1 = viewingTime(clips, o.end)
  const len = Math.max(0, e1 - e0)
  let fin = Math.max(0, o.fadeIn)
  let fout = Math.max(0, o.fadeOut)
  if (fin + fout > len && fin + fout > 0) {
    const k = len / (fin + fout)
    fin *= k
    fout *= k
  }
  let a = 1
  if (fin > 0) a = Math.min(a, (e - e0) / fin)
  if (fout > 0) a = Math.min(a, (e1 - e) / fout)
  return clamp(o.opacity, 0, 1) * clamp(a, 0, 1)
}

/** Milliseconds of the overlay's own clock at source time `t` (output time since its start). */
export const overlayClockMs = (o: Pick<ImageOverlay, 'start'>, t: number, clips: Clip[]): number =>
  Math.max(0, (viewingTime(clips, t) - viewingTime(clips, o.start)) * 1000)

/** Frame delays at or under this many milliseconds play as GIF_SHORT_DELAY_MS, as browsers do. */
export const GIF_MIN_DELAY_MS = 10
export const GIF_SHORT_DELAY_MS = 100

/** A GIF's frame delays (ms) as they play: missing, broken or too short ones become 100 ms. */
export function playedDelays(delays: readonly number[]): number[] {
  return delays.map((d) => (Number.isFinite(d) && d > GIF_MIN_DELAY_MS ? d : GIF_SHORT_DELAY_MS))
}

/** Start of each frame (ms) and the total length, for gifFrameAt. */
export interface GifTiming {
  starts: number[]
  total: number
}

export function gifTiming(delays: readonly number[]): GifTiming {
  const played = playedDelays(delays)
  const starts: number[] = []
  let at = 0
  for (const d of played) {
    starts.push(at)
    at += d
  }
  return { starts, total: at }
}

/** The frame shown `ms` milliseconds into a looping GIF. */
export function gifFrameAt(timing: GifTiming, ms: number): number {
  const n = timing.starts.length
  if (n <= 1 || !(timing.total > 0)) return 0
  const u = ((ms % timing.total) + timing.total) % timing.total
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (timing.starts[mid] <= u + 1e-6) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Decoded frames of a GIF are kept at most this long on their long side … */
export const GIF_MAX_SIDE = 720
/** … and smaller when all frames together would pass this many bytes (RGBA). */
export const GIF_MAX_BYTES = 200 * 1024 * 1024
/** Most frames a GIF may have. */
export const GIF_MAX_FRAMES = 1500
/** Static images are kept at most this long on their long side (SVGs are rasterised at it). */
export const IMAGE_MAX_SIDE = 2048
/** Images larger than this are refused before they become part of a project. */
export const IMAGE_MAX_DECODE_SIDE = 8192
export const IMAGE_MAX_PIXELS = 40_000_000

/** The scale (≤ 1) a GIF's frames are stored at: GIF_MAX_SIDE on the long side, within GIF_MAX_BYTES for all frames. */
export function gifScale(width: number, height: number, frames: number): number {
  if (!(width > 0 && height > 0 && frames > 0)) return 1
  const side = Math.min(1, GIF_MAX_SIDE / Math.max(width, height))
  const bytes = width * height * 4 * frames * side * side
  return bytes > GIF_MAX_BYTES ? side * Math.sqrt(GIF_MAX_BYTES / bytes) : side
}

/** Why an image of this many pixels is refused, or null when it may be used. */
export function imageSizeProblem(width: number, height: number): string | null {
  if (!(width > 0 && height > 0)) return 'This image could not be read.'
  if (Math.max(width, height) > IMAGE_MAX_DECODE_SIDE || width * height > IMAGE_MAX_PIXELS) {
    return `This image is too large to show (${width} × ${height} pixels; ${IMAGE_MAX_DECODE_SIDE} a side and 40 megapixels at most).`
  }
  return null
}
