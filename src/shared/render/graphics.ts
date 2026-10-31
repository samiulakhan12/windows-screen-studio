/**
 * Motion graphics made from captions (docs/design/captions-studio.md §10): defaults per kind,
 * placement clear of captions, the camera, the action and safe zones, and counter text. Pure.
 */
import type { Rect } from '../engine/layout'
import { isTall } from '../engine/reframeData'
import { numberingFor } from '../captions/words'
import type { CounterGraphic, Graphic, ItemMotion } from '../types'
import { keepInArea } from './safeZones'

const pop: ItemMotion = { kind: 'pop', duration: 0.24, strength: 1 }
const rise: ItemMotion = { kind: 'rise', duration: 0.22, strength: 1 }
const fade: ItemMotion = { kind: 'fade', duration: 0.18, strength: 1 }

/**
 * Per kind (§10.1): size (u), tall multiplier, length when added by hand (s), entrance and exit. A
 * counter's 2.2 s is its count for up to four digits (max(1.2 s, min(2.0 s, 0.3 s per digit))) and
 * the 1.0 s it holds; a list card added by hand starts with one item and gets 4 s, room for the
 * next items before it would hide (6 s without one).
 */
export const GRAPHIC_DEFAULTS: Readonly<Record<Graphic['kind'], { size: number; tall: number; length: number; enter: ItemMotion; exit: ItemMotion }>> = {
  keyword: { size: 0.09, tall: 1.2, length: 1.6, enter: pop, exit: fade },
  emoji: { size: 0.12, tall: 1, length: 1.2, enter: pop, exit: fade },
  counter: { size: 0.11, tall: 1, length: 2.2, enter: pop, exit: fade },
  list: { size: 0.045, tall: 1.25, length: 4, enter: rise, exit: fade }
}

/** The thirds of the frame's width a list or counter can take, away from the camera and the action. */
function awayThird(w: number, avoid: { camera: Rect | null; action: Rect | null }): number {
  const thirds = [0.22 * w, 0.5 * w, 0.78 * w]
  const busy = [avoid.camera, avoid.action].filter((r): r is Rect => !!r)
  if (!busy.length) return 0.5 * w
  // The third farthest from what is on screen (the nearest of them counts).
  let best = thirds[1]
  let far = -Infinity
  for (const x of thirds) {
    const d = Math.min(...busy.map((r) => Math.abs(x - (r.x + r.w / 2)) - r.w / 2))
    if (d > far + 1e-9) {
      far = d
      best = x
    }
  }
  return best
}

/**
 * Candidate centres for a graphic of `kind`, in order (§10.3), wide / tall: a keyword replacing its
 * chunk at that chunk's centre, then (0.5 W, 0.28 H / 0.30 H), the middle, (0.5 W, 0.62 H); an
 * emoji anchored to a word (`replacing`: the word's box) centred above it, 0.15 em over the line,
 * a free one at (0.80 W, 0.25 H) then (0.20 W, 0.25 H); a counter at (0.5 W, 0.35 H) then the third
 * away from the camera and the action at 0.45 H; a list in that third at 0.45 H, then the middle.
 */
export function graphicCandidates(kind: Graphic['kind'], w: number, h: number, avoid: { camera: Rect | null; action: Rect | null }, replacing?: Rect): { x: number; y: number }[] {
  const tall = isTall(w, h)
  const u = Math.min(w, h)
  const centre = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
  switch (kind) {
    case 'keyword':
      return [...(replacing ? [centre(replacing)] : []), { x: 0.5 * w, y: (tall ? 0.3 : 0.28) * h }, { x: 0.5 * w, y: 0.5 * h }, { x: 0.5 * w, y: 0.62 * h }]
    case 'emoji': {
      const free = [
        { x: 0.8 * w, y: 0.25 * h },
        { x: 0.2 * w, y: 0.25 * h }
      ]
      if (!replacing) return free
      // Above the word: its line's em is about its box height; the emoji at its default size.
      const em = replacing.h / 1.2
      const half = (GRAPHIC_DEFAULTS.emoji.size * (tall ? GRAPHIC_DEFAULTS.emoji.tall : 1) * u) / 2
      return [{ x: replacing.x + replacing.w / 2, y: replacing.y - 0.15 * em - half }, ...free]
    }
    case 'counter':
      return [
        { x: 0.5 * w, y: 0.35 * h },
        { x: awayThird(w, avoid), y: 0.45 * h }
      ]
    case 'list':
      return [
        { x: awayThird(w, avoid), y: 0.45 * h },
        { x: 0.5 * w, y: 0.5 * h }
      ]
  }
}

const overlapArea = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

/**
 * The first candidate with no overlap, else the first shrunk (down to 0.6) until it fits clear,
 * else the candidate with the least overlap that never covers a caption (§10.3). Overlap is
 * weighed in the order captions, the camera and face, the action, app safe zones, other graphics.
 * Boxes are kept inside `area`. Returns the centre and the scale. Pure, so a graphic placed with
 * the obstacles over its whole time never moves while it shows.
 */
export function placeGraphic(
  box: { w: number; h: number },
  candidates: readonly { x: number; y: number }[],
  area: Rect,
  obstacles: { captions: readonly Rect[]; camera: readonly Rect[]; action: readonly Rect[]; safe: readonly Rect[]; graphics: readonly Rect[] }
): { x: number; y: number; scale: number } {
  const groups = [obstacles.captions, obstacles.camera, obstacles.action, obstacles.safe, obstacles.graphics]
  const at = (c: { x: number; y: number }, scale: number): Rect => {
    const r = { x: c.x - (box.w * scale) / 2, y: c.y - (box.h * scale) / 2, w: box.w * scale, h: box.h * scale }
    const k = keepInArea(r, area, 1)
    return { x: r.x + k.dx, y: r.y + k.dy, w: r.w, h: r.h }
  }
  const costs = (r: Rect): number[] => groups.map((g) => g.reduce((s, o) => s + overlapArea(r, o), 0))
  const clear = (r: Rect): boolean => costs(r).every((c) => c <= 0)
  const result = (r: Rect, scale: number): { x: number; y: number; scale: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2, scale })
  if (!candidates.length) return result(at({ x: area.x + area.w / 2, y: area.y + area.h / 2 }, 1), 1)
  for (const c of candidates) {
    const r = at(c, 1)
    if (clear(r)) return result(r, 1)
  }
  for (let scale = 0.95; scale >= 0.6 - 1e-9; scale -= 0.05) {
    const r = at(candidates[0], scale)
    if (clear(r)) return result(r, Math.round(scale * 100) / 100)
  }
  // The least overlap, captions first: a candidate that covers no caption wins over any that does.
  let best = at(candidates[0], 1)
  let bestCost = costs(best)
  for (const c of candidates.slice(1)) {
    const r = at(c, 1)
    const cost = costs(r)
    for (let i = 0; i < cost.length; i++) {
      if (cost[i] < bestCost[i] - 1e-9) {
        best = r
        bestCost = cost
        break
      }
      if (cost[i] > bestCost[i] + 1e-9) break
    }
  }
  return result(best, 1)
}

/**
 * A counter's text at `value` (§10.1): its prefix, the number formatted for its locale with fixed
 * decimals (Bengali digits for bn, ১২,৩৪,৫৬৭.৫; the Digits choice of §0.2 when given), and its
 * suffix; and how many digit cells it has (each drawn as wide as the font's widest digit).
 */
export function counterText(g: CounterGraphic, value: number, digits?: 'native' | 'western'): { text: string; cells: number } {
  const v = Number.isFinite(value) ? value : 0
  const numbering = numberingFor(digits, g.locale)
  const options: Intl.NumberFormatOptions = { minimumFractionDigits: g.decimals, maximumFractionDigits: g.decimals, ...(numbering ? { numberingSystem: numbering } : {}) }
  let formatted: string
  try {
    formatted = new Intl.NumberFormat(g.locale, options).format(v)
  } catch {
    formatted = new Intl.NumberFormat('en', options).format(v)
  }
  const text = `${g.prefix}${formatted}${g.suffix}`
  return { text, cells: (formatted.match(/\p{Nd}/gu) ?? []).length }
}
