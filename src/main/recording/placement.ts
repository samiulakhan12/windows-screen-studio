import type { NormRect } from '../../shared/types'
import type { Rect } from './trackMath'

/** Smallest region side accepted, as a fraction of the display. */
export const MIN_REGION = 0.02

/** Validates a region coming from the overlay window; null when unusable. */
export function sanitizeRegion(value: unknown): NormRect | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const nums = [r.x, r.y, r.w, r.h]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const x = Math.min(1, Math.max(0, r.x as number))
  const y = Math.min(1, Math.max(0, r.y as number))
  const w = Math.min(1 - x, Math.max(0, r.w as number))
  const h = Math.min(1 - y, Math.max(0, r.h as number))
  if (w < MIN_REGION || h < MIN_REGION) return null
  return { x, y, w, h }
}

export function regionToRect(region: NormRect, bounds: Rect): Rect {
  return {
    x: Math.round(bounds.x + region.x * bounds.width),
    y: Math.round(bounds.y + region.y * bounds.height),
    width: Math.round(region.w * bounds.width),
    height: Math.round(region.h * bounds.height)
  }
}

/**
 * Where the floating toolbar goes: bottom-centre of the work area, or just below
 * (else above) a recorded region so it does not cover what is being recorded.
 */
export function toolbarPosition(
  workArea: Rect,
  size: { width: number; height: number },
  avoid: Rect | null = null,
  margin = 24
): { x: number; y: number } {
  const clampX = (x: number): number => Math.round(Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - size.width))
  const fallback = {
    x: clampX(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height - margin)
  }
  if (!avoid) return fallback
  const x = clampX(avoid.x + (avoid.width - size.width) / 2)
  const below = avoid.y + avoid.height + 12
  if (below + size.height <= workArea.y + workArea.height) return { x, y: Math.round(below) }
  const above = avoid.y - size.height - 12
  if (above >= workArea.y) return { x, y: Math.round(above) }
  return fallback
}

export const pointInRect = (p: { x: number; y: number }, r: Rect): boolean =>
  p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
