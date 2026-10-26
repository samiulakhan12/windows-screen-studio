/**
 * Where one of the app's movable windows (the speaker notes) was, and when. The input hook
 * delivers clicks and wheel events late and in batches (src/main/recording/hookClock.ts), so
 * "is this point over our window?" must be asked for the moment the event happened, not the
 * moment it arrived: a click on the notes' close button is delivered after the notes are gone,
 * and a click where the notes were a second ago is content. See docs/design/teleprompter.md,
 * "Input never reaches the recording".
 *
 * STUB (contracts commit): signatures and doc comments frozen, bodies by workstream A.
 */
import type { Rect } from './windowGeometry'

/** How far around a span's ends a point still counts as inside it (ms): the hook clock errs late. */
export const OWN_AREA_SLACK_MS = 250
/** Spans kept; the oldest are dropped beyond this (a window dragged around for an hour). */
export const OWN_AREA_MAX_SPANS = 1000

export class AreaHistory {
  /**
   * The window covers `rect` from `now` (epoch ms) on, until the next call; null = hidden or
   * closed. Repeating the same rectangle extends the current span.
   */
  set(_rect: Rect | null, _now: number): void {
    throw new Error('AreaHistory.set: not implemented yet (workstream A)')
  }

  /** Whether `p` was inside the window at `at` (epoch ms), within `slackMs` of a span's ends. */
  contains(_p: { x: number; y: number }, _at: number, _slackMs: number = OWN_AREA_SLACK_MS): boolean {
    throw new Error('AreaHistory.contains: not implemented yet (workstream A)')
  }

  /** Forgets every span (a new recording). */
  clear(): void {
    throw new Error('AreaHistory.clear: not implemented yet (workstream A)')
  }
}
