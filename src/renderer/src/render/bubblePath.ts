/**
 * Speech-bubble paths: Captions Studio's Speech Bubble look (moved here from studioLayer.ts, its
 * drawing unchanged) and editing polish's speech-bubble callouts (docs/design/editing-polish.md
 * §7.4). Each builds one path for the body and its tail, so a shadow and an edge drawn with it
 * join without a seam.
 */
import type { Rect } from '../../../shared/engine/layout'

type Point = { x: number; y: number }

/** A rounded bubble with a tail of `tail` px pointing at `target` (straight down without one). */
export function bubblePath(c: CanvasRenderingContext2D, r: Rect, radius: number, tail: number, target: { x: number; y: number } | null): void {
  c.beginPath()
  c.roundRect(r.x, r.y, r.w, r.h, radius)
  if (tail <= 0) return
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const to = target ?? { x: cx, y: r.y + r.h + tail * 4 }
  const dx = to.x - cx
  const dy = to.y - cy
  const half = Math.min(tail * 0.55, Math.min(r.w, r.h) / 4)
  const inset = Math.min(radius + half, Math.min(r.w, r.h) / 2)
  // On the side facing the target, its base slid toward the target, clear of the corners; the tip leans toward it.
  if (Math.abs(dx) / Math.max(1, r.w) > Math.abs(dy) / Math.max(1, r.h)) {
    const dir = dx > 0 ? 1 : -1
    const sx = dx > 0 ? r.x + r.w : r.x
    const by = Math.max(r.y + inset, Math.min(r.y + r.h - inset, to.y))
    c.moveTo(sx - dir, by - half)
    c.lineTo(sx + dir * tail, by + Math.max(-half, Math.min(half, (to.y - by) * 0.3)))
    c.lineTo(sx - dir, by + half)
  } else {
    const dir = dy > 0 ? 1 : -1
    const sy = dy > 0 ? r.y + r.h : r.y
    const bx = Math.max(r.x + inset, Math.min(r.x + r.w - inset, to.x))
    c.moveTo(bx - half, sy - dir)
    c.lineTo(bx + Math.max(-half, Math.min(half, (to.x - bx) * 0.3)), sy + dir * tail)
    c.lineTo(bx + half, sy - dir)
  }
  c.closePath()
}

/**
 * A speech-bubble callout's outline (§7.4) as one closed contour: the rounded body traced
 * clockwise from its top-left corner, with the tail (`callouts.ts` bubbleTail: its base on one
 * edge, its tip) let into that edge. Filled, its shadow has no seam; stroked, the outline runs
 * round the tail without crossing it. Without a tail, the rounded body alone.
 */
export function calloutBubblePath(c: CanvasRenderingContext2D, r: Rect, radius: number, tail: { base: [Point, Point]; tip: Point } | null): void {
  c.beginPath()
  const rr = Math.max(0, Math.min(radius, r.w / 2, r.h / 2))
  if (!tail) {
    c.roundRect(r.x, r.y, r.w, r.h, rr)
    return
  }
  const x0 = r.x
  const y0 = r.y
  const x1 = r.x + r.w
  const y1 = r.y + r.h
  const [a, b] = tail.base
  const on = (side: 'top' | 'right' | 'bottom' | 'left'): boolean =>
    side === 'top' ? a.y === y0 && b.y === y0 : side === 'bottom' ? a.y === y1 && b.y === y1 : side === 'left' ? a.x === x0 && b.x === x0 : a.x === x1 && b.x === x1
  // Clockwise: top left to right, right top to bottom, bottom right to left, left bottom to top.
  const lo = (u: Point, v: Point, key: 'x' | 'y', up: boolean): [Point, Point] => ((up ? u[key] <= v[key] : u[key] >= v[key]) ? [u, v] : [v, u])
  c.moveTo(x0 + rr, y0)
  if (on('top')) {
    const [p, q] = lo(a, b, 'x', true)
    c.lineTo(p.x, p.y)
    c.lineTo(tail.tip.x, tail.tip.y)
    c.lineTo(q.x, q.y)
  }
  c.lineTo(x1 - rr, y0)
  c.arcTo(x1, y0, x1, y0 + rr, rr)
  if (on('right')) {
    const [p, q] = lo(a, b, 'y', true)
    c.lineTo(p.x, p.y)
    c.lineTo(tail.tip.x, tail.tip.y)
    c.lineTo(q.x, q.y)
  }
  c.lineTo(x1, y1 - rr)
  c.arcTo(x1, y1, x1 - rr, y1, rr)
  if (on('bottom')) {
    const [p, q] = lo(a, b, 'x', false)
    c.lineTo(p.x, p.y)
    c.lineTo(tail.tip.x, tail.tip.y)
    c.lineTo(q.x, q.y)
  }
  c.lineTo(x0 + rr, y1)
  c.arcTo(x0, y1, x0, y1 - rr, rr)
  if (on('left')) {
    const [p, q] = lo(a, b, 'y', false)
    c.lineTo(p.x, p.y)
    c.lineTo(tail.tip.x, tail.tip.y)
    c.lineTo(q.x, q.y)
  }
  c.lineTo(x0, y0 + rr)
  c.arcTo(x0, y0, x0 + rr, y0, rr)
  c.closePath()
}
