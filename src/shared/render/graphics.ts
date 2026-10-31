/**
 * Motion graphics made from captions (docs/design/captions-studio.md §10): defaults per kind,
 * placement clear of captions, the camera, the action and safe zones, and counter text.
 *
 * CONTRACT (part P1): signatures are frozen; bodies are to be written. GRAPHIC_DEFAULTS holds the
 * values of §10.1.
 */
import type { Rect } from '../engine/layout'
import type { CounterGraphic, Graphic, ItemMotion } from '../types'

/** The body of a frozen signature part P1 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

const pop: ItemMotion = { kind: 'pop', duration: 0.24, strength: 1 }
const rise: ItemMotion = { kind: 'rise', duration: 0.22, strength: 1 }
const fade: ItemMotion = { kind: 'fade', duration: 0.18, strength: 1 }

/** Per kind (§10.1): size (u), tall multiplier, length when added by hand (s), entrance and exit. */
export const GRAPHIC_DEFAULTS: Readonly<Record<Graphic['kind'], { size: number; tall: number; length: number; enter: ItemMotion; exit: ItemMotion }>> = {
  keyword: { size: 0.09, tall: 1.2, length: 1.6, enter: pop, exit: fade },
  emoji: { size: 0.12, tall: 1, length: 1.2, enter: pop, exit: fade },
  counter: { size: 0.11, tall: 1, length: 2.2, enter: pop, exit: fade },
  list: { size: 0.045, tall: 1.25, length: 4, enter: rise, exit: fade }
}

/** Candidate centres for a graphic of `kind`, in order (§10.3). */
export function graphicCandidates(kind: Graphic['kind'], w: number, h: number, avoid: { camera: Rect | null; action: Rect | null }, replacing?: Rect): { x: number; y: number }[] {
  return notImplemented('graphicCandidates', kind, w, h, avoid, replacing)
}

/** The first candidate with no overlap, else shrunk, else the least overlap that never covers a caption (§10.3). */
export function placeGraphic(
  box: { w: number; h: number },
  candidates: readonly { x: number; y: number }[],
  area: Rect,
  obstacles: { captions: readonly Rect[]; camera: readonly Rect[]; action: readonly Rect[]; safe: readonly Rect[]; graphics: readonly Rect[] }
): { x: number; y: number; scale: number } {
  return notImplemented('placeGraphic', box, candidates, area, obstacles)
}

/** A counter's text at `value` (locale digits, fixed decimals) and its digit cells. */
export function counterText(g: CounterGraphic, value: number): { text: string; cells: number } {
  return notImplemented('counterText', g, value)
}
