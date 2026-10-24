/**
 * How the camera picture is drawn: its drop shadow, the background blur behind the person and
 * the person mask fed to (and read back from) segmentation. Pure, so the preview, the export
 * and the tests agree on every number.
 */
import { clamp } from '../engine/math'

/** The camera's drop shadow at strength `shadow` (0..1); 0.6 is the shadow every camera had before it could be changed. */
export function cameraShadow(shadow: number, k: number): { color: string; blur: number; offsetY: number } | null {
  if (!(shadow > 0)) return null
  const s = Math.min(1, shadow)
  return { color: `rgba(0,0,0,${+((s * 0.4) / 0.6).toFixed(3)})`, blur: 30 * k * (0.4 + s), offsetY: 10 * k }
}

/** Pixels around a box its shadow can reach (for the size of a cached shadow sprite). */
export const shadowReach = (s: { blur: number; offsetY: number }): number => Math.ceil(s.blur * 1.5 + Math.abs(s.offsetY)) + 2

/**
 * Blur radius (camera pixels) behind the person for `amount` (0..1). Relative to the camera
 * picture, so it looks the same at any output size and in the preview and the export.
 */
export const backgroundBlurRadius = (amount: number, camW: number, camH: number): number => clamp(amount, 0, 1) * 0.035 * Math.max(camW, camH)

/** The background is blurred at this fraction of the camera's size (same look, a fraction of the cost). */
export const BLUR_DOWNSCALE = 0.25

/** Longest side of the picture segmentation looks at (the person model works on 256 x 256). */
export const SEGMENT_SIZE = 256

/** Size of the picture handed to segmentation: the camera's shape, its longest side SEGMENT_SIZE. */
export function segmentationSize(camW: number, camH: number): { width: number; height: number } {
  if (!(camW > 0) || !(camH > 0)) return { width: SEGMENT_SIZE, height: SEGMENT_SIZE }
  const s = SEGMENT_SIZE / Math.max(camW, camH)
  return { width: Math.max(16, Math.round(camW * s)), height: Math.max(16, Math.round(camH * s)) }
}

/** Person confidence below this is background, above MASK_HIGH the person; in between the edge fades. */
export const MASK_LOW = 0.3
export const MASK_HIGH = 0.7

/**
 * The person mask as RGBA pixels (white, alpha = person) from segmentation's confidences
 * (0..1 per pixel). A narrow smooth step keeps the edge soft without a halo of half-blurred
 * background around the person.
 */
export function maskPixels(confidence: ArrayLike<number>, out = new Uint8ClampedArray(confidence.length * 4)): Uint8ClampedArray {
  const span = MASK_HIGH - MASK_LOW
  for (let i = 0; i < confidence.length; i++) {
    const c = confidence[i]
    const x = Number.isFinite(c) ? clamp((c - MASK_LOW) / span, 0, 1) : 0
    const o = i * 4
    out[o] = 255
    out[o + 1] = 255
    out[o + 2] = 255
    out[o + 3] = Math.round(x * x * (3 - 2 * x) * 255)
  }
  return out
}

