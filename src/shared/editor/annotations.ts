import { clamp } from '../engine/math'
import type { Annotation } from '../types'

export const DEFAULT_ANNOTATION_LENGTH = 3
export const MIN_ANNOTATION_LENGTH = 0.3
export const ANNOTATION_SIZE = { min: 0.02, max: 0.14, default: 0.05 }

let idCounter = 0
export const newAnnotationId = (): string => `a${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** A new text overlay starting at `t` (or ending at the recording's end when `t` is too late). */
export function createAnnotation(t: number, duration: number, init: Partial<Omit<Annotation, 'id'>> = {}): Annotation {
  const length = Math.min(DEFAULT_ANNOTATION_LENGTH, duration)
  const start = clamp(t, 0, Math.max(0, duration - length))
  return {
    id: newAnnotationId(),
    start,
    end: Math.min(duration, start + length),
    text: 'Add your text',
    x: 0.5,
    y: 0.86,
    size: ANNOTATION_SIZE.default,
    style: 'pill',
    ...init
  }
}

/** New start/end for a move or edge drag; overlays may overlap each other freely. */
export function dragAnnotationTimes(
  initial: { start: number; end: number },
  mode: 'move' | 'start' | 'end',
  dt: number,
  duration: number
): { start: number; end: number } {
  let { start, end } = initial
  if (mode === 'move') {
    const len = end - start
    start = clamp(start + dt, 0, Math.max(0, duration - len))
    end = start + len
  } else if (mode === 'start') {
    start = clamp(start + dt, 0, end - MIN_ANNOTATION_LENGTH)
  } else {
    end = clamp(end + dt, start + MIN_ANNOTATION_LENGTH, duration)
  }
  return { start, end }
}

/**
 * Assigns overlapping overlays to stacked lanes (greedy interval partitioning),
 * so every one of them stays visible and grabbable on the timeline.
 */
export function annotationLanes(annotations: Annotation[]): { lanes: Map<string, number>; count: number } {
  const sorted = [...annotations].sort((a, b) => a.start - b.start || a.end - b.end)
  const laneEnds: number[] = []
  const lanes = new Map<string, number>()
  for (const a of sorted) {
    let lane = laneEnds.findIndex((end) => end <= a.start + 1e-9)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(a.end)
    } else {
      laneEnds[lane] = a.end
    }
    lanes.set(a.id, lane)
  }
  return { lanes, count: Math.max(1, laneEnds.length) }
}

export const annotationVisibleAt = (a: Annotation, t: number): boolean => t >= a.start && t < a.end
