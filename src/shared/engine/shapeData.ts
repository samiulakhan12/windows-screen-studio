/**
 * Reading stored shapes and spotlights: defaults for missing fields, values clamped, and
 * entries that cannot be drawn rejected. One rule for loading a project (project.ts) and for
 * drawing it (render/shapes.ts), so the timeline lists exactly what the canvas draws.
 */
import type { Shape, ShapeKind, Spotlight } from '../types'
import { clamp } from './math'

const KINDS: ShapeKind[] = ['arrow', 'line', 'rect', 'ellipse', 'highlight', 'blur', 'pixelate']
const HEX = /^#[0-9a-f]{6}$/i
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const num = (v: unknown, fallback: number, min: number, max: number): number => (finite(v) ? clamp(v, min, max) : fallback)

/** A shape with every field usable, or null when it cannot be drawn (hand-edited or damaged files). */
export function readShape(raw: Partial<Shape> | null | undefined): Shape | null {
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind as ShapeKind)) return null
  if (!finite(raw.start) || !finite(raw.end) || !(raw.end > raw.start)) return null
  if (!finite(raw.x) || !finite(raw.y) || !finite(raw.w) || !finite(raw.h)) return null
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    kind: raw.kind as ShapeKind,
    start: raw.start,
    end: raw.end,
    x: raw.x,
    y: raw.y,
    w: raw.w,
    h: raw.h,
    color: typeof raw.color === 'string' && HEX.test(raw.color) ? raw.color : '#ff3b30',
    strokeWidth: num(raw.strokeWidth, 6, 0.5, 64),
    fill: raw.fill === true,
    opacity: num(raw.opacity, 1, 0, 1),
    strength: num(raw.strength, 0.5, 0, 1)
  }
}

/** A spotlight with every field usable, or null when it cannot be drawn. */
export function readSpotlight(raw: Partial<Spotlight> | null | undefined): Spotlight | null {
  if (!raw || typeof raw !== 'object' || (raw.mode !== 'cursor' && raw.mode !== 'region')) return null
  if (!finite(raw.start) || !finite(raw.end) || !(raw.end > raw.start)) return null
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    mode: raw.mode,
    start: raw.start,
    end: raw.end,
    x: num(raw.x, 0.3, -1, 2),
    y: num(raw.y, 0.3, -1, 2),
    w: num(raw.w, 0.4, 0.005, 2),
    h: num(raw.h, 0.4, 0.005, 2),
    shape: raw.shape === 'rect' ? 'rect' : 'ellipse',
    dim: num(raw.dim, 0.6, 0, 1),
    feather: num(raw.feather, 0.4, 0, 1)
  }
}

/**
 * The shapes or spotlights of a stored project, as `read` reads them. Entries the editor could
 * not draw, select or edit are left out: anything that is not an object, has no id (or the id of
 * an earlier one), or has unusable times or geometry.
 */
export function readItems<T extends { id: string }>(list: unknown, read: (raw: Partial<T>) => T | null): T[] {
  if (!Array.isArray(list)) return []
  const ids = new Set<string>()
  const out: T[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const id = (raw as { id?: unknown }).id
    if (typeof id !== 'string' || !id || ids.has(id)) continue
    const item = read(raw as Partial<T>)
    if (!item) continue
    ids.add(id)
    out.push(item)
  }
  return out
}
