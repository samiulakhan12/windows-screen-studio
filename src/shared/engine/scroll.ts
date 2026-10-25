/**
 * Scroll sessions (NW-03 part 3, docs/design/smarter-auto-zoom.md): mouse-wheel events grouped
 * into stretches of scrolling, and which of them auto zoom treats as long scrolls (it zooms out
 * while they last and back in where they stop, in 'zoom-out' mode). zoom.ts autoZoomsForTrack
 * uses them to place zooms, smartSpeed.ts inputGaps to count scrolling as activity, and the
 * editor to show and count them. Pure.
 */
import type { AutoZoomSettings, CursorTrack, ScrollEvent } from '../types'

export const SCROLL = {
  /** Wheel events at most this far apart (seconds) are one session. */
  join: 0.8,
  /** A long scroll lasts at least this long (seconds)... */
  long: 1.5,
  /** ...with at least this many notches (|dx| + |dy| summed). */
  minNotches: 4,
  /** The camera is back at the full frame this long (seconds) after a long scroll starts. */
  outBy: 0.35,
  /** A zoom after a long scroll starts this long (seconds) after its last wheel event (the page settles). */
  rest: 0.2,
  /** No zoom back in after a long scroll when a click, mark or typing starts this soon (seconds) after it. */
  landSkip: 1.5,
  /** Smart speed: a session keeps this much (seconds) before and after it busy. */
  activityPad: 0.05
} as const

/** A stretch of scrolling. */
export interface ScrollSession {
  /** First and last wheel event (source seconds). */
  start: number
  end: number
  /** Sum of |dx| + |dy| over its events. */
  notches: number
  /** Wheel events in it. */
  count: number
  /** Where the last wheel event was (normalised): where the page stopped. */
  last: { x: number; y: number }
}

/**
 * Sessions of `scrolls` (sorted or not): events at most SCROLL.join apart, also cut at every
 * instant of `splits` strictly between two of their events (an event exactly at a split starts
 * the next session). [] without scroll data.
 */
export function scrollSessions(scrolls: readonly ScrollEvent[] | undefined, splits: readonly number[] = []): ScrollSession[] {
  // Stub until workstream B lands: no scrolling.
  void scrolls
  void splits
  return []
}

/** A session long enough to zoom out for. */
export const isLongScroll = (s: ScrollSession): boolean => s.end - s.start >= SCROLL.long && s.notches >= SCROLL.minNotches

/**
 * The long scrolls auto zoom zooms out for with these settings, exactly as autoZoomsForTrack
 * finds them: sessions split at the zoom events (used zoom clicks, marks, typing starts and
 * ends), long, not overlapping a typing session. [] in 'hold' or 'ignore' mode, without scroll
 * data, or when auto zoom is off. For the editor's summary and the zoom track's scroll bands.
 */
export function scrollBreaks(track: CursorTrack, settings: AutoZoomSettings): ScrollSession[] {
  // Stub until workstream B lands.
  void track
  void settings
  return []
}
