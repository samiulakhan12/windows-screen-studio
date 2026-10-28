/**
 * Pure timing and geometry for what the compositor draws on top of the recording:
 * keystroke labels, text annotations, cursor size and motion-blur sampling.
 * No DOM access, so it is unit-tested directly.
 */
import { clamp, easeOutCubic, lowerIndex } from '../engine/math'
import { clipIndexAt, playableFrom, sourceToOutput } from '../engine/timeline'
import type { Camera } from '../engine/zoom'
import type { Annotation, Clip, CursorShape, CursorShapeEvent, KeyEvent } from '../types'

/* ---------- time mapping ---------- */

/** Playback speed of the clip at source time `t` (1 inside a cut). */
export function speedAt(clips: Clip[], t: number): number {
  const i = clipIndexAt(clips, t)
  return i >= 0 ? clips[i].speed : 1
}

/**
 * Output time at which source time `t` is on screen. A time inside a cut maps to
 * the start of the next kept clip (the frame the preview shows there).
 */
export function viewingTime(clips: Clip[], t: number): number {
  const direct = sourceToOutput(clips, t)
  if (direct !== null) return direct
  const next = playableFrom(clips, t)
  if (next) return sourceToOutput(clips, next.time) ?? 0
  const last = clips[clips.length - 1]
  return sourceToOutput(clips, last.end) ?? 0
}

/* ---------- keystrokes ---------- */

export const KEYSTROKE_TIMING = {
  /** Seconds (of output time) a label stays after its last key press. */
  hold: 1.2,
  /** Presses closer than this stack into one row. */
  combo: 0.8,
  fadeIn: 0.1,
  fadeOut: 0.25,
  /** Most groups shown at once. */
  max: 3
}

export interface KeystrokeGroup {
  label: string
  /** Consecutive presses of the same label ("x3"). */
  count: number
}

export interface KeystrokeView {
  groups: KeystrokeGroup[]
  alpha: number
  /** 0..1 "pop" of the newest group right after a press (1 = just pressed). */
  pop: number
}

/** Keystroke labels on screen at source time `t`, or null when none are. */
export function keystrokesAt(keys: KeyEvent[] | undefined, clips: Clip[], t: number, timing = KEYSTROKE_TIMING): KeystrokeView | null {
  if (!keys || keys.length === 0) return null
  const last = lowerIndex(keys, t)
  if (last < 0) return null
  const now = viewingTime(clips, t)
  const outAt = (k: KeyEvent): number | null => sourceToOutput(clips, k.t)
  // The newest key that was not cut out of the edit.
  let i = last
  let lastOut: number | null = null
  for (; i >= 0; i--) {
    lastOut = outAt(keys[i])
    if (lastOut !== null) break
  }
  if (i < 0 || lastOut === null) return null
  const age = now - lastOut
  if (age < 0 || age > timing.hold) return null
  // Walk back over the burst of presses that belong to the same row.
  let first = i
  let firstOut = lastOut
  for (let j = i - 1; j >= 0; j--) {
    const o = outAt(keys[j])
    if (o === null || firstOut - o > timing.combo) break
    first = j
    firstOut = o
  }
  const groups: KeystrokeGroup[] = []
  for (let j = first; j <= i; j++) {
    const prev = groups[groups.length - 1]
    if (prev && prev.label === keys[j].label) prev.count++
    else groups.push({ label: keys[j].label, count: 1 })
  }
  const alpha = Math.min(clamp((now - firstOut) / timing.fadeIn, 0, 1), clamp((timing.hold - age) / timing.fadeOut, 0, 1))
  return { groups: groups.slice(-timing.max), alpha, pop: 1 - easeOutCubic(age / 0.18) }
}

/** Splits "Ctrl + Shift + S" into keycaps. */
export const keycaps = (label: string): string[] => label.split(' + ').filter(Boolean)

/* ---------- annotations ---------- */

export const ANNOTATION_FADE = 0.15

/** Opacity of a text annotation at source time `t` (fades are ~150 ms of viewing time). */
export function annotationAlpha(a: Annotation, t: number, speed = 1, fade = ANNOTATION_FADE): number {
  if (t < a.start || t >= a.end) return 0
  const f = fade * speed
  return clamp(Math.min((t - a.start) / f, (a.end - t) / f), 0, 1)
}

export interface TextBoxMetrics {
  /** Font size in pixels. */
  px: number
  lineHeight: number
  padX: number
  padY: number
  weight: number
}

/** Font metrics for an annotation in an output frame of the given size (matches the editor's drag handle). */
export function annotationMetrics(a: Pick<Annotation, 'size' | 'style'>, w: number, h: number): TextBoxMetrics {
  const px = a.size * Math.min(w, h)
  const pill = a.style === 'pill'
  return { px, lineHeight: px * 1.3, padX: pill ? px * 0.7 : px * 0.2, padY: pill ? px * 0.35 : px * 0.1, weight: pill ? 600 : 700 }
}

export const ANNOTATION_FONT = "'Segoe UI', system-ui, sans-serif"

/* ---------- cursor ---------- */

/** Cursor shape at source time `t` (arrow before the first recorded change or without data). */
export function shapeAt(shapes: CursorShapeEvent[] | undefined, t: number): CursorShape {
  if (!shapes || shapes.length === 0) return 'arrow'
  const i = lowerIndex(shapes, t)
  return i >= 0 ? shapes[i].shape : 'arrow'
}

/** The OS cursor is about 24 DIP tall; the capture is in physical pixels. */
export const CURSOR_DIP = 24

/**
 * Height in output pixels of the drawn cursor: the real cursor's size on the captured
 * display (24 DIP x display scale, in video pixels), scaled with the content and zoom,
 * times the user's size setting. DPI-independent: 100% and 200% displays match.
 */
export function cursorHeight(contentH: number, videoH: number, displayScale: number | undefined, camScale: number, size: number): number {
  const scale = clamp(displayScale && displayScale > 0 ? displayScale : 1, 0.5, 4)
  return ((CURSOR_DIP * scale) / Math.max(1, videoH)) * contentH * camScale * size
}

/* ---------- motion blur ---------- */

export interface RectLike {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Largest on-screen movement (output pixels) of the content between two cameras,
 * measured at the corners of the content rectangle, where zooming moves pixels most.
 * `clip`: measure at the corners of this part of the frame instead (the slot of a view that
 * follows the action, docs/design/vertical-video.md §8.2); absent, the content's corners.
 */
export function cameraDisplacement(a: Camera, b: Camera, rect: RectLike, clip?: RectLike): number {
  if (clip !== undefined) throw new Error('not implemented')
  let max = 0
  for (const fx of [0, 1]) {
    for (const fy of [0, 1]) {
      // Output corner -> source point under camera a -> output point under camera b.
      const sx = a.cx - 0.5 / a.scale + fx / a.scale
      const sy = a.cy - 0.5 / a.scale + fy / a.scale
      const bx = (sx - (b.cx - 0.5 / b.scale)) * b.scale
      const by = (sy - (b.cy - 0.5 / b.scale)) * b.scale
      max = Math.max(max, Math.hypot((bx - fx) * rect.w, (by - fy) * rect.h))
    }
  }
  return max
}

/** Sub-frames needed so that consecutive samples are at most `spacing` pixels apart. */
export function blurSampleCount(displacement: number, maxSamples: number, spacing = 2): number {
  if (maxSamples <= 1 || displacement < 1) return 1
  return clamp(Math.ceil(displacement / spacing) + 1, 2, Math.floor(maxSamples))
}

/** Sub-frame times spread evenly over a shutter interval centred on `t`. */
export function shutterTimes(t: number, shutter: number, samples: number): number[] {
  if (samples <= 1) return [t]
  const out: number[] = []
  for (let k = 0; k < samples; k++) out.push(t - shutter / 2 + (shutter * k) / (samples - 1))
  return out
}
