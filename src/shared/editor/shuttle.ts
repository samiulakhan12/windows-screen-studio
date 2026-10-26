/**
 * J / K / L shuttle and the preview speed (E-08, docs/design/shuttle-and-preview-speed.md): the
 * state machine, the rates, when the preview plays sound, the labels and the reverse position.
 * Pure. The preview speed is player state only: it never reaches the project or the export.
 */
import { keptBounds, outputToSource } from '../engine/timeline'
import { clamp } from '../engine/math'
import type { Clip } from '../types'

/** Speeds the preview can play at; the exported video is never affected. */
export const PREVIEW_SPEEDS = [0.5, 1, 1.5, 2] as const
export type PreviewSpeed = (typeof PREVIEW_SPEEDS)[number]
export const DEFAULT_PREVIEW_SPEED: PreviewSpeed = 1

export type ShuttleDir = -1 | 0 | 1
/** J/K/L state: direction, and how many doublings above the preview speed (0..MAX_SHUTTLE_LEVEL). */
export interface Shuttle {
  dir: ShuttleDir
  level: number
}
export const STOPPED: Shuttle = Object.freeze({ dir: 0, level: 0 })
export const MAX_SHUTTLE_LEVEL = 3

export type ShuttleKey = 'reverse' | 'pause' | 'forward'
export interface ShuttleStep {
  next: Shuttle
  /** A frame step instead of a rate change (J/L tapped while K is held). */
  frameStep: -1 | 0 | 1
}

/** Chromium's playbackRate range (outside it the setter throws). */
export const MIN_ELEMENT_RATE = 1 / 16
export const MAX_ELEMENT_RATE = 16
/** Element rates the preview plays sound at when the viewing rate is not 1. */
export const AUDIBLE_RATES = { min: 0.5, max: 4 } as const

/**
 * The next shuttle state for a key: K stops; J or L while K is held steps one frame (and stops);
 * the same direction again goes one level faster (up to MAX_SHUTTLE_LEVEL); the other direction
 * starts at level 0.
 */
export function pressShuttle(s: Shuttle, key: ShuttleKey, pauseHeld = false): ShuttleStep {
  if (key === 'pause') return { next: STOPPED, frameStep: 0 }
  const dir = key === 'forward' ? 1 : -1
  if (pauseHeld) return { next: STOPPED, frameStep: dir }
  if (s.dir === dir) return { next: { dir, level: Math.min(s.level + 1, MAX_SHUTTLE_LEVEL) }, frameStep: 0 }
  return { next: { dir, level: 0 }, frameStep: 0 }
}

/** Signed viewing rate: direction × preview speed × 2^level (0 when stopped). */
export function viewRate(s: Shuttle, previewSpeed: number): number {
  return s.dir * previewSpeed * 2 ** s.level
}

/** The video element's playbackRate for a clip at `clipSpeed` viewed at `view`, within Chromium's range. */
export function elementRate(clipSpeed: number, view: number): number {
  return clamp(clipSpeed * Math.abs(view), MIN_ELEMENT_RATE, MAX_ELEMENT_RATE)
}

/** Whether the preview plays sound: always at viewing rate 1 (as before), never in reverse, else within AUDIBLE_RATES. */
export function soundAt(clipSpeed: number, view: number): boolean {
  if (view === 1) return true
  if (view <= 0) return false
  const r = elementRate(clipSpeed, view)
  return r >= AUDIBLE_RATES.min && r <= AUDIBLE_RATES.max
}

/** "0.5×", "1×", "1.5×", "16×". */
export function formatRate(r: number): string {
  return `${Number(r.toFixed(2))}×`
}

/** The badge: "Reverse 1×", "Forward 4× · no sound"; null when stopped or playing forward at level 0. */
export function shuttleLabel(s: Shuttle, previewSpeed: number, silent = false): string | null {
  if (s.dir === 0 || (s.dir === 1 && s.level === 0)) return null
  const rate = formatRate(Math.abs(viewRate(s, previewSpeed)))
  return s.dir < 0 ? `Reverse ${rate}` : `Forward ${rate}${silent ? ' · no sound' : ''}`
}

/** The next preview speed up (1) or down (-1), or null at the end of the list. */
export function nextPreviewSpeed(cur: PreviewSpeed, step: 1 | -1): PreviewSpeed | null {
  const i = PREVIEW_SPEEDS.indexOf(cur)
  return PREVIEW_SPEEDS[i + step] ?? null
}

export function isPreviewSpeed(v: unknown): v is PreviewSpeed {
  return typeof v === 'number' && (PREVIEW_SPEEDS as readonly number[]).includes(v)
}

/**
 * Where reverse playback is `elapsed` wall seconds after starting at output second `fromOut`,
 * at `rate` output seconds per second: the source time, the output time, and whether it reached
 * the start (then the first kept frame). Cuts are skipped because the walk is in output time.
 */
export function reversePosition(clips: Clip[], fromOut: number, elapsed: number, rate: number): { time: number; out: number; done: boolean } {
  const out = fromOut - elapsed * rate
  if (out <= 0) return { time: keptBounds(clips).start, out: 0, done: true }
  return { time: outputToSource(clips, out).time, out, done: false }
}
