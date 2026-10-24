import type { Shape, ShapeKind, Spotlight } from '../types'

/** Default length (seconds) of a new shape or spotlight. */
export const DEFAULT_SHAPE_LENGTH = 3

let idCounter = 0
const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** A new shape of `kind` starting at source time `t`, clamped to the recording's `duration`. */
export function createShape(kind: ShapeKind, t: number, duration: number, init: Partial<Omit<Shape, 'id' | 'kind'>> = {}): Shape {
  const start = Math.max(0, Math.min(t, duration - 0.1))
  return {
    id: newId('s'),
    kind,
    start,
    end: Math.min(duration, start + DEFAULT_SHAPE_LENGTH),
    x: 0.35,
    y: 0.35,
    w: 0.3,
    h: 0.3,
    color: '#ff3b30',
    strokeWidth: 6,
    fill: false,
    opacity: 1,
    strength: 0.5,
    ...init
  }
}

/** A new spotlight starting at source time `t`. */
export function createSpotlight(mode: Spotlight['mode'], t: number, duration: number, init: Partial<Omit<Spotlight, 'id' | 'mode'>> = {}): Spotlight {
  const start = Math.max(0, Math.min(t, duration - 0.1))
  return {
    id: newId('l'),
    mode,
    start,
    end: Math.min(duration, start + DEFAULT_SHAPE_LENGTH),
    x: 0.3,
    y: 0.3,
    w: 0.4,
    h: 0.4,
    shape: 'ellipse',
    dim: 0.6,
    feather: 0.4,
    ...init
  }
}
