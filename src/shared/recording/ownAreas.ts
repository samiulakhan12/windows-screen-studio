/**
 * Where one of the app's movable windows (the speaker notes) was, and when. The input hook
 * delivers clicks and wheel events late and in batches (src/main/recording/hookClock.ts), so
 * "is this point over our window?" must be asked for the moment the event happened, not the
 * moment it arrived: a click on the notes' close button is delivered after the notes are gone,
 * and a click where the notes were a second ago is content. See docs/design/teleprompter.md,
 * "Input never reaches the recording".
 */
import type { Rect } from './windowGeometry'

/** How far around a span's ends a point still counts as inside it (ms): the hook clock errs late. */
export const OWN_AREA_SLACK_MS = 250
/** Spans kept; the oldest are dropped beyond this (a window dragged around for an hour). */
export const OWN_AREA_MAX_SPANS = 1000

interface Span {
  rect: Rect
  start: number
  /** null while the window is still there. */
  end: number | null
}

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

export class AreaHistory {
  private spans: Span[] = []

  /**
   * The window covers `rect` from `now` (epoch ms) on, until the next call; null = hidden or
   * closed. Repeating the same rectangle extends the current span.
   */
  set(rect: Rect | null, now: number): void {
    const last = this.spans[this.spans.length - 1]
    const open = last && last.end === null ? last : null
    if (open && rect && sameRect(open.rect, rect)) return
    if (open) open.end = Math.max(open.start, now)
    if (!rect) return
    this.spans.push({ rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, start: now, end: null })
    if (this.spans.length > OWN_AREA_MAX_SPANS) this.spans.splice(0, this.spans.length - OWN_AREA_MAX_SPANS)
  }

  /** Whether `p` was inside the window at `at` (epoch ms), within `slackMs` of a span's ends. */
  contains(p: { x: number; y: number }, at: number, slackMs: number = OWN_AREA_SLACK_MS): boolean {
    for (let i = this.spans.length - 1; i >= 0; i--) {
      const { rect, start, end } = this.spans[i]
      if (start > at + slackMs) continue
      if (end !== null && end < at - slackMs) continue
      if (p.x >= rect.x && p.x < rect.x + rect.width && p.y >= rect.y && p.y < rect.y + rect.height) return true
    }
    return false
  }

  /** Forgets every span (a new recording). */
  clear(): void {
    this.spans = []
  }
}
