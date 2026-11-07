/**
 * The progress bar (docs/design/editing-polish.md §8): its layout from the chapters, the band it
 * takes from the text area, and its state at a video time. Pure.
 *
 * Contracts step: the exported signatures of part P2 (§17.2), stubs that lay out no bar and take
 * no band (textArea is unchanged). Part P2 writes the bodies.
 */
import type { Rect } from '../engine/layout'
import type { ChapterBar, Project } from '../types'

export const CHAPTER_BAR: {
  inset: 0.03
  thick: 0.008
  edgeThick: 0.006
  gap: 0.005
  label: 0.042
  labelTall: 0.036
  labelGap: 0.01
  pillAlpha: 0.55
  grow: 1.5
  growTime: 0.15
  fade: 0.3
  show: 3
  cross: 0.2
} = {
  inset: 0.03,
  thick: 0.008,
  edgeThick: 0.006,
  gap: 0.005,
  label: 0.042,
  labelTall: 0.036,
  labelGap: 0.01,
  pillAlpha: 0.55,
  grow: 1.5,
  growTime: 0.15,
  fade: 0.3,
  show: 3,
  cross: 0.2
}

export interface BarSegment {
  from: number
  to: number
  title: string | null
  x0: number
  x1: number
}

export interface BarLayout {
  edge: 'top' | 'bottom'
  x0: number
  x1: number
  y: number
  th: number
  gap: number
  round: boolean
  color: string
  labels: ChapterBar['labels']
  labelPx: number
  segments: BarSegment[]
}

/** Whether the captions show and sit in the top half of a w × h frame. */
export function captionsAtTop(project: Project, w: number, h: number): boolean {
  void project
  void w
  void h
  return false
}

/** The bar in a w × h frame inside `area` (the text area without the bar), or null when it does not show. */
export function chapterBarLayout(project: Project, w: number, h: number, area: Rect | null): BarLayout | null {
  void project
  void w
  void h
  void area
  return null
}

/** The band the bar takes from the text area at its edge, or null without a bar. */
export function barBand(project: Project, w: number, h: number): { edge: 'top' | 'bottom'; size: number } | null {
  void project
  void w
  void h
  return null
}

/** The bar's opacity (the full-frame title card's fade included), current segment, its growth and its names' opacity. */
export function barState(layout: BarLayout, video: number, t: number, project: Project): { alpha: number; current: number; grow: number; labelAlpha: number } {
  void layout
  void video
  void t
  void project
  return { alpha: 0, current: -1, grow: 1, labelAlpha: 0 }
}
