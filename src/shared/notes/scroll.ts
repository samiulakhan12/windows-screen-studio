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
 *
 * STUB (contracts commit): signatures and doc comments frozen, bodies by workstream B.
 */

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
export function blockAt(_boxes: readonly BlockBox[], _y: number): number {
  throw new Error('blockAt: not implemented yet (workstream B)')
}

/** Scrolling speed at `y` (px/s); 0 at or past the end, or without blocks. */
export function rateAt(_boxes: readonly BlockBox[], _y: number, _wpm: number): number {
  throw new Error('rateAt: not implemented yet (workstream B)')
}

/** Where scrolling stops: the end of the last block on the reading line (0 without blocks). */
export function endPosition(_boxes: readonly BlockBox[]): number {
  throw new Error('endPosition: not implemented yet (workstream B)')
}

/** The position `seconds` of scrolling after `y`, across block boundaries at each block's rate, never past the end. */
export function advance(_boxes: readonly BlockBox[], _y: number, _seconds: number, _wpm: number): number {
  throw new Error('advance: not implemented yet (workstream B)')
}

/**
 * Back: the start of the current block when more than `lineHeight` past it, else the previous
 * block's start. Forward: the next block's start, or the end from the last block.
 */
export function stepTarget(_boxes: readonly BlockBox[], _y: number, _dir: 'back' | 'forward', _lineHeight: number): number {
  throw new Error('stepTarget: not implemented yet (workstream B)')
}

/** `y` rounded to whole device pixels (dpr = window.devicePixelRatio). */
export function snap(_y: number, _dpr: number): number {
  throw new Error('snap: not implemented yet (workstream B)')
}

/** Wait before the next step at `rate` px/s: one device pixel, within [1000 / maxWritesPerSecond, maxStepMs]. */
export function stepDelayMs(_rate: number, _dpr: number): number {
  throw new Error('stepDelayMs: not implemented yet (workstream B)')
}

/**
 * The position as a pure function of time: an anchor (y, t) plus playing or not. Nothing drifts,
 * whatever the timer's jitter. Times are performance.now() ms.
 */
export class ScrollClock {
  /** New text layout (text, size or width changed): keeps the same block and the same share of it. */
  setLayout(_boxes: readonly BlockBox[], _now: number): void {
    throw new Error('ScrollClock.setLayout: not implemented yet (workstream B)')
  }

  /** New speed, the position continuous. */
  setWpm(_wpm: number, _now: number): void {
    throw new Error('ScrollClock.setWpm: not implemented yet (workstream B)')
  }

  play(_now: number): void {
    throw new Error('ScrollClock.play: not implemented yet (workstream B)')
  }

  pause(_now: number): void {
    throw new Error('ScrollClock.pause: not implemented yet (workstream B)')
  }

  /** Moves to `y` (clamped to [0, end]); playing stays as it was. */
  jump(_y: number, _now: number): void {
    throw new Error('ScrollClock.jump: not implemented yet (workstream B)')
  }

  positionAt(_now: number): number {
    throw new Error('ScrollClock.positionAt: not implemented yet (workstream B)')
  }

  /** The end reached the reading line at `now`. */
  endedAt(_now: number): boolean {
    throw new Error('ScrollClock.endedAt: not implemented yet (workstream B)')
  }

  get playing(): boolean {
    throw new Error('ScrollClock.playing: not implemented yet (workstream B)')
  }
}
