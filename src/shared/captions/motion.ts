/**
 * The Captions Studio motion engine (docs/design/captions-studio.md §9): every pose a pure
 * function of time, so preview, export, seeking and any frame rate draw the same frames.
 *
 * CONTRACT (part P1): signatures are frozen; bodies are to be written.
 */
import type { CaptionMotion, CaptionStudio, Clip, CounterGraphic, ItemMotion, ListGraphic } from '../types'
import type { StudioLayout } from './studioLayout'

/** The body of a frozen signature part P1 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

/** The easings of §9.2. */
export const EASE: Record<'out' | 'outQuart' | 'inCubic' | 'outExpo' | 'emphDecel' | 'emphAccel', (p: number) => number> = {
  out: (p) => notImplemented('EASE.out', p),
  outQuart: (p) => notImplemented('EASE.outQuart', p),
  inCubic: (p) => notImplemented('EASE.inCubic', p),
  outExpo: (p) => notImplemented('EASE.outExpo', p),
  emphDecel: (p) => notImplemented('EASE.emphDecel', p),
  emphAccel: (p) => notImplemented('EASE.emphAccel', p)
}

/** back(c): overshoot easing (peak 1.10 at c = 1.7). */
export function back(p: number, c: number): number {
  return notImplemented('back', p, c)
}

/** The damped spring of §9.2, 1 at p = 1. */
export function spring(p: number): number {
  return notImplemented('spring', p)
}

/** A 32-bit FNV-1a hash of `key` (seeds for rotation and shake, §9.1 rule 4). */
export function seedOf(key: string): number {
  return notImplemented('seedOf', key)
}

/** A cache key of the clips' starts, ends and speeds (§9.1 rule 5). */
export function clipsKey(clips: readonly Clip[]): string {
  return notImplemented('clipsKey', clips)
}

export interface WordPose {
  token: number
  dx: number
  dy: number
  scale: number
  scaleX: number
  rotate: number
  alpha: number
  blur: number
  reveal: number
  fill: number
  weight: number
  mark: number
}

export interface ChunkPose {
  alpha: number
  dx: number
  dy: number
  scale: number
  scaleX: number
  rotate: number
  blur: number
  reveal: number
}

export interface MarkBox {
  x: number
  w: number
  line: number
  alpha: number
  first: number
  last: number
}

/** The poses of chunk `chunk` at source time `t` (and the outgoing chunk during a hand-over, §9.3). */
export function captionPoses(
  layout: StudioLayout,
  chunk: number,
  t: number,
  clips: Clip[],
  studio: CaptionStudio,
  u: number,
  nextStart: number | null,
  opts?: { spoken: boolean }
): { chunk: ChunkPose; words: WordPose[]; mark: MarkBox | null; out?: { chunk: number; pose: ChunkPose } } {
  return notImplemented('captionPoses', layout, chunk, t, clips, studio, u, nextStart, opts)
}

/** A graphic's or card's pose at `t`, or null while it is not shown (§10.1). */
export function itemPose(start: number, end: number, t: number, clips: Clip[], enter: ItemMotion, exit: ItemMotion, u: number, calm: boolean): ChunkPose | null {
  return notImplemented('itemPose', start, end, t, clips, enter, exit, u, calm)
}

/** The number a counter shows at `t` (§10.1). */
export function counterValue(g: CounterGraphic, t: number, clips: Clip[]): number {
  return notImplemented('counterValue', g, t, clips)
}

/** When a list card shows (§10.1): hidden after 6 s without an item, back 0.3 s before the next. */
export function listWindows(g: ListGraphic, clips: Clip[]): { start: number; end: number }[] {
  return notImplemented('listWindows', g, clips)
}

/** Motion with the clamps of Calm motion (§9.5). */
export function calmed(m: CaptionMotion): CaptionMotion {
  return notImplemented('calmed', m)
}

/** The layout with chunks merged so big changes stay at 3 a second or fewer (the flash rule, §9.6). */
export function flashSafeChunks(layout: StudioLayout, clips: Clip[], frameArea: number, boxArea: (chunk: number) => number): StudioLayout {
  return notImplemented('flashSafeChunks', layout, clips, frameArea, boxArea)
}

/** The typewriter clip of a word after k graphemes (§9.3): a measured prefix advance, or k / n of its width. */
export function typewriterClip(word: { graphemes: number; prefixAdvances?: readonly number[]; width: number }, k: number): number {
  return notImplemented('typewriterClip', word, k)
}
