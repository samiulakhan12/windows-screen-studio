/**
 * A guide's steps from the recording (docs/design/smart-tools.md §5.1). Part P1 writes it; the
 * contracts' stub gives its types and exported names, and finds no steps.
 */
import type { SceneScan } from '../api/projects'
import type { Rect } from '../engine/layout'
import type { CursorShape, CursorTrack, Project } from '../types'

export type StepKind = 'click' | 'double' | 'right' | 'middle' | 'drag' | 'type' | 'keys' | 'screen' | 'badge' | 'added'

export interface GuideStep {
  key: string
  t: number
  kind: StepKind
  x?: number
  y?: number
  to?: { x: number; y: number }
  times?: number
  keys?: string
  typing?: { t: number; end: number; place: { x: number; y: number } }
  then?: string
  scroll?: 'up' | 'down' | 'left' | 'right'
  shape?: CursorShape
  place?: { x: number; y: number }
  badge?: { label: string; section?: string }
  hiddenByDefault?: true
}

export const STEP_RULES = {
  doubleS: 0.5,
  doublePx: 4,
  dragHeldS: 0.25,
  dragTravel: 0.02,
  repeatS: 1.5,
  repeatPx: 12,
  typingJoinS: 5,
  typingMinS: 0.5,
  typingPauseS: 6,
  typingTailS: 0.3,
  keyAfterTypingS: 1.5,
  screenAfterKeyS: 1.5,
  scrollAheadS: 10,
  maxSteps: 200
} as const

export function findSteps(input: { track: CursorTrack; project: Pick<Project, 'clips' | 'duration' | 'width' | 'height' | 'capture' | 'guide' | 'annotations' | 'chapters' | 'effects'>; scan: SceneScan | null }): GuideStep[] {
  void input
  return []
}

/** 'c' + the click's time in ms, 'k' a key press's, 't' a lone burst's, 's' a screen change's, 'b' a badge's, 'a' an added step's. */
export function stepKey(kind: StepKind, t: number): string {
  const prefix = kind === 'keys' ? 'k' : kind === 'type' ? 't' : kind === 'screen' ? 's' : kind === 'badge' ? 'b' : kind === 'added' ? 'a' : 'c'
  return `${prefix}${Math.round(t * 1000)}`
}

export function typedBefore(steps: readonly GuideStep[], shots: ReadonlyMap<string, { t: number; rect: Rect; whole: boolean }>, scan: SceneScan | null, frame: { w: number; h: number }): ReadonlyMap<string, string> {
  void steps
  void shots
  void scan
  void frame
  return new Map()
}
