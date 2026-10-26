import { rectsOverlap } from '../../shared/notes/placement'
import { isUsableRegion } from '../../shared/recording/regionGeometry'
import type { NormRect } from '../../shared/types'
import type { Rect } from './trackMath'

/**
 * Validates a region (normalised to a display of `display` DIP size) coming from the
 * overlay window or the renderer; null when malformed or smaller than the picker allows.
 */
export function sanitizeRegion(value: unknown, display: { width: number; height: number }): NormRect | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const nums = [r.x, r.y, r.w, r.h]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const x = Math.min(1, Math.max(0, r.x as number))
  const y = Math.min(1, Math.max(0, r.y as number))
  const w = Math.min(1 - x, Math.max(0, r.w as number))
  const h = Math.min(1 - y, Math.max(0, r.h as number))
  const region = { x, y, w, h }
  return isUsableRegion(region, { w: display.width, h: display.height }) ? region : null
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
 * (else above) a recorded region so it does not cover what is being recorded. Never
 * under anything in `keepClear` (the speaker notes, which would hide its buttons):
 * a spot under one moves to its left or right, and when the bottom-centre is under
 * one too, the bar goes just below (else above) it. The first spot clear of both
 * wins; else the first clear of the region (on Windows before 10 version 2004 a bar
 * inside it is a black box in the video); else the first clear of the notes; else
 * the first choice. Always inside the work area: notes on another display are
 * ignored, and a spot beside them that leaves the work area is never used.
 */
export function toolbarPosition(
  workArea: Rect,
  size: { width: number; height: number },
  avoid: Rect | null = null,
  keepClear: readonly Rect[] = [],
  margin = 24
): { x: number; y: number } {
  const clampX = (x: number): number => Math.round(Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - size.width))
  const fallback = {
    x: clampX(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height - margin)
  }
  /** Just below `r`, then just above it, where the work area has room. */
  const beside = (r: Rect, x: number): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = []
    const below = r.y + r.height + 12
    if (below + size.height <= workArea.y + workArea.height) out.push({ x, y: Math.round(below) })
    const above = r.y - size.height - 12
    if (above >= workArea.y) out.push({ x, y: Math.round(above) })
    return out
  }
  // Notes on another display cannot cover the bar.
  const notes = keepClear.filter((r) => rectsOverlap(r, workArea))
  const nearArea = avoid ? beside(avoid, clampX(avoid.x + (avoid.width - size.width) / 2)) : []
  const spots = [...nearArea]
  // The same heights, to the left and the right of each of the notes.
  for (const p of nearArea) for (const r of notes) spots.push({ x: clampX(r.x - 12 - size.width), y: p.y }, { x: clampX(r.x + r.width + 12), y: p.y })
  spots.push(fallback)
  for (const r of notes) spots.push(...beside(r, fallback.x))
  const inside = spots.filter((p) => p.y >= workArea.y && p.y + size.height <= workArea.y + workArea.height)
  const bar = (p: { x: number; y: number }): Rect => ({ ...p, ...size })
  const notesClear = (p: { x: number; y: number }): boolean => !notes.some((r) => rectsOverlap(bar(p), r))
  const areaClear = (p: { x: number; y: number }): boolean => !avoid || !rectsOverlap(bar(p), avoid)
  return inside.find((p) => notesClear(p) && areaClear(p)) ?? inside.find(areaClear) ?? inside.find(notesClear) ?? inside[0] ?? fallback
}

export const pointInRect = (p: { x: number; y: number }, r: Rect): boolean =>
  p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
