/**
 * The notes window's scroll engine, pure (docs/design/teleprompter.md, "Scrolling").
 *
 * Coordinates: `y` is how far the text has moved up, in CSS px. The text column has a top
 * padding of READING_LINE × the text area's height, so at y = 0 the first block's top sits on
 * the reading line, and block i is on the reading line while box.top <= y < box.top + box.height.
 * Boxes are measured from the column's content top (padding excluded), contiguous: a block's box
 * runs from its top to the next block's top (the gap before the next block is part of it).
 *
 * Speed: the block on the reading line moves at wpm/60 × height / max(words, SCROLL.minWords)
 * px/s, so every block takes as long as reading its words, however densely it wraps. The page
 * writes the snapped position to one `will-change: transform` column only when it changes, at
 * most SCROLL.maxWritesPerSecond times a second, and runs no timer while paused, hidden or at
 * the end.
 */
import { NOTES_WPM } from './notes'

export const SCROLL = {
  /** Fewest words a block counts as (a cue-only line still takes this long). */
  minWords: 1,
  /** Most position writes per second (the window repaints only then). */
  maxWritesPerSecond: 30,
  /** Longest wait between steps while playing (ms): a very slow rate still advances. */
  maxStepMs: 1000,
  /** Back / forward glide (ms); 0 under prefers-reduced-motion. */
  glideMs: 150
} as const

export interface BlockBox {
  top: number
  height: number
  /** Spoken words of the block. */
  words: number
}

/** Index of the block on the reading line at `y` (the last one past the end; 0 when there is none). */
export function blockAt(boxes: readonly BlockBox[], y: number): number {
  // Binary search for the last box whose top is at or above y.
  let lo = 0
  let hi = boxes.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (boxes[mid].top <= y) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** Where scrolling stops: the end of the last block on the reading line (0 without blocks). */
export function endPosition(boxes: readonly BlockBox[]): number {
  const last = boxes[boxes.length - 1]
  return last ? Math.max(0, last.top + last.height) : 0
}

const blockRate = (box: BlockBox, wpm: number): number => (wpm / 60) * (box.height / Math.max(box.words, SCROLL.minWords))

/** Scrolling speed at `y` (px/s); 0 at or past the end, or without blocks. */
export function rateAt(boxes: readonly BlockBox[], y: number, wpm: number): number {
  if (!boxes.length || !(wpm > 0) || y >= endPosition(boxes)) return 0
  return blockRate(boxes[blockAt(boxes, y)], wpm)
}

/** The position `seconds` of scrolling after `y`, across block boundaries at each block's rate, never past the end. */
export function advance(boxes: readonly BlockBox[], y: number, seconds: number, wpm: number): number {
  const end = endPosition(boxes)
  let pos = Math.min(Math.max(0, y), end)
  if (!boxes.length || !(wpm > 0) || !(seconds > 0)) return pos
  let left = seconds
  let i = blockAt(boxes, pos)
  while (left > 0 && pos < end && i < boxes.length) {
    const box = boxes[i]
    const boundary = i + 1 < boxes.length ? boxes[i + 1].top : end
    const rate = blockRate(box, wpm)
    if (boundary <= pos || rate <= 0) {
      // An empty box (or one the position is already past): on to the next.
      if (boundary > pos) break
      i++
      continue
    }
    const need = (boundary - pos) / rate
    if (need >= left) return Math.min(end, pos + rate * left)
    pos = boundary
    left -= need
    i++
  }
  return Math.min(pos, end)
}

/**
 * Back: the start of the current block when more than `lineHeight` past it, else the previous
 * block's start. Forward: the next block's start, or the end from the last block.
 */
export function stepTarget(boxes: readonly BlockBox[], y: number, dir: 'back' | 'forward', lineHeight: number): number {
  if (!boxes.length) return 0
  const i = blockAt(boxes, y)
  if (dir === 'forward') return i + 1 < boxes.length ? boxes[i + 1].top : endPosition(boxes)
  if (y - boxes[i].top > lineHeight) return boxes[i].top
  return boxes[Math.max(0, i - 1)].top
}

/** `y` rounded to whole device pixels (dpr = window.devicePixelRatio). */
export function snap(y: number, dpr: number): number {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1
  return Math.round(y * d) / d
}

/** Wait before the next step at `rate` px/s: one device pixel, within [1000 / maxWritesPerSecond, maxStepMs]. */
export function stepDelayMs(rate: number, dpr: number): number {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1
  const ms = rate > 0 ? 1000 / (rate * d) : SCROLL.maxStepMs
  return Math.min(SCROLL.maxStepMs, Math.max(1000 / SCROLL.maxWritesPerSecond, ms))
}

/**
 * The position as a pure function of time: an anchor (y, t) plus playing or not. Nothing drifts,
 * whatever the timer's jitter. Times are performance.now() ms.
 */
export class ScrollClock {
  private boxes: readonly BlockBox[] = []
  private wpm: number = NOTES_WPM.default
  private y0 = 0
  private t0 = 0
  private running = false

  /** Moves the anchor to `now` without moving the text. */
  private rebase(now: number): void {
    this.y0 = this.positionAt(now)
    this.t0 = now
  }

  /** New text layout (text, size or width changed): keeps the same block and the same share of it. */
  setLayout(boxes: readonly BlockBox[], now: number): void {
    const old = this.boxes
    const y = this.positionAt(now)
    let next = 0
    if (old.length && boxes.length) {
      if (y >= endPosition(old)) next = endPosition(boxes)
      else {
        const i = blockAt(old, y)
        const share = old[i].height > 0 ? (y - old[i].top) / old[i].height : 0
        const box = boxes[Math.min(i, boxes.length - 1)]
        next = i < boxes.length ? box.top + share * box.height : box.top
      }
    }
    this.boxes = boxes
    this.y0 = Math.min(Math.max(0, next), endPosition(boxes))
    this.t0 = now
  }

  /** New speed, the position continuous. */
  setWpm(wpm: number, now: number): void {
    this.rebase(now)
    this.wpm = wpm
  }

  play(now: number): void {
    if (this.running) return
    this.y0 = this.positionAt(now)
    this.t0 = now
    this.running = true
  }

  pause(now: number): void {
    if (!this.running) return
    this.rebase(now)
    this.running = false
  }

  /** Moves to `y` (clamped to [0, end]); playing stays as it was. */
  jump(y: number, now: number): void {
    this.y0 = Math.min(Math.max(0, y), endPosition(this.boxes))
    this.t0 = now
  }

  positionAt(now: number): number {
    if (!this.running) return this.y0
    return advance(this.boxes, this.y0, Math.max(0, now - this.t0) / 1000, this.wpm)
  }

  /** The end reached the reading line at `now`. */
  endedAt(now: number): boolean {
    return this.boxes.length > 0 && this.positionAt(now) >= endPosition(this.boxes) - 1e-6
  }

  get playing(): boolean {
    return this.running
  }
}
