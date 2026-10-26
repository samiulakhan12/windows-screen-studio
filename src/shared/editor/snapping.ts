/**
 * Snapping on the timeline (E-05, docs/design/snapping.md): a dragged edge, a dragged point or
 * the scrubbed playhead catches cuts, splits, trims, freeze frames, chapters, used clicks, the
 * edges of other items, the playhead and the recording's ends. Everything is in source seconds;
 * thresholds are screen pixels converted with the current scale. Pure: the renderer session
 * (renderer/editor/snapControl.ts) only gates, tracks the current target and draws the guide.
 *
 * Contracts commit: types and constants are final; the functions pass values straight through
 * (nothing snaps) until E-05 lands (TODO(E-05) below), so every drag behaves exactly as before.
 */
import type { ClickRow } from '../engine/inputData'
import { formatTime } from '../engine/project'
import type { Chapter, Clip, Project } from '../types'

export const SNAP = {
  /** A target this close to a dragged edge (screen px) catches it. */
  enterPx: 8,
  /** A caught target holds until the edge is further than this (screen px). */
  leavePx: 12,
  /** Distances closer than this (px) are equal: current, priority, point order, time decide. */
  tiePx: 0.5,
  /** Scrubbing snaps once the pointer has moved at least this far from the press (px). */
  scrubSlopPx: 3,
  /** Targets closer than this (s) are one target. */
  mergeS: 1e-6,
  /** A resolved edge further than this (s) from its target lost the snap to a clamp. */
  exactS: 1e-9
} as const

export type SnapKind = 'playhead' | 'clip' | 'freeze' | 'chapter' | 'click' | 'segment' | 'bound'
/** Lower wins a tie. */
export const SNAP_PRIORITY: Readonly<Record<SnapKind, number>> = { playhead: 0, clip: 1, freeze: 2, chapter: 3, click: 4, segment: 5, bound: 6 }

export type SnapEdge = 'start' | 'end' | 'at'
export type DragMode = 'move' | 'start' | 'end'
export interface Span {
  start: number
  end: number
}

export interface SnapTarget {
  /** Source seconds. */
  t: number
  kind: SnapKind
  /** "Cut", "Split", "Trim", "Click", "Chapter · Intro", "Zoom start", "Playhead", "Start", "End", "Freeze frame". */
  label: string
  /** Owner key ('zoom:z1', 'trim:start', 'clips', 'chapter:h1', …); none for clicks, the playhead and the ends. */
  owner?: string
  edge?: SnapEdge
}

/** One block on a timeline track. */
export interface SnapSegment {
  owner: string
  label: string
  start: number
  end: number
}

export interface SnapSources {
  duration: number
  clips: readonly Clip[]
  /** Source times of used (not ignored) in-video clicks. */
  clicks: readonly number[]
  chapters: readonly Chapter[]
  segments: readonly SnapSegment[]
  /** Source times of freeze frames (E-11); [] until E-11 lands. */
  freezes: readonly number[]
  /** Playhead (source s), or null when it is not a target. */
  playhead: number | null
}

/** Leaves out an owner's targets: all of them, or one edge. */
export interface SnapExclude {
  owner: string
  edge?: SnapEdge
}

export interface SnapIndex {
  /** Sorted ascending, merged within SNAP.mergeS; times[i] === targets[i].t. */
  times: Float64Array
  targets: readonly SnapTarget[]
}

/** What one move sees: scale, the target holding the edge (hysteresis), the visible window. */
export interface SnapView {
  pxPerSec: number
  current: SnapTarget | null
  /** Source seconds; null = no limit. */
  visible?: { start: number; end: number } | null
}

export interface SnapResult {
  /** Seconds to add to the dragged time(s); 0 when nothing caught. */
  delta: number
  target: SnapTarget | null
  /** Index into `points` of the edge that caught it, or -1. */
  point: number
}

/** The blocks of the project's tracks as targets (camera layouts only when their track is shown). */
export function projectSnapSegments(p: Project, opts: { layouts: boolean }): SnapSegment[] {
  // TODO(E-05): zooms, text, shapes, spotlights, title cards, captions and (with opts.layouts) layouts.
  void p
  void opts
  return []
}

/** Everything a drag can snap to, read once at pointerdown. */
export function projectSnapSources(
  p: Project,
  rows: readonly ClickRow[],
  opts: { playhead: number | null; layouts: boolean; freezes?: readonly number[] }
): SnapSources {
  // TODO(E-05): used clicks from `rows`, chapters and projectSnapSegments(p, opts).
  void rows
  return { duration: p.duration, clips: p.clips, clicks: [], chapters: [], segments: [], freezes: opts.freezes ?? [], playhead: opts.playhead }
}

/** The sorted, merged targets of `src`, without the excluded owners' edges. */
export function buildSnapIndex(src: SnapSources, exclude?: readonly SnapExclude[]): SnapIndex {
  // TODO(E-05): bounds, clip edges, freezes, chapters, clicks, segments and the playhead.
  void src
  void exclude
  return { times: new Float64Array(0), targets: [] }
}

/** The dragged edges after a raw move of `dt`: the start, the end, or both. */
export function dragPoints(initial: Span, mode: DragMode, dt: number): number[] {
  if (mode === 'start') return [initial.start + dt]
  if (mode === 'end') return [initial.end + dt]
  return [initial.start + dt, initial.end + dt]
}

/** The target nearest (in pixels) to any of `points`, with hysteresis and the tie rules; nothing caught: delta 0. */
export function snapPoints(index: SnapIndex, points: readonly number[], view: SnapView, limit?: { min: number; max: number }): SnapResult {
  // TODO(E-05): binary search within SNAP.enterPx, keep view.current within SNAP.leavePx.
  void index
  void points
  void view
  void limit
  return { delta: 0, target: null, point: -1 }
}

/** A span drag snapped, then clamped by `resolve` (the drag helper); unsnapped when the clamp moves the edge off its target. */
export function snapSpan(
  index: SnapIndex,
  initial: Span,
  mode: DragMode,
  dt: number,
  view: SnapView,
  resolve: (dt: number) => Span
): { times: Span; target: SnapTarget | null } {
  // TODO(E-05): snapPoints, then the exact edge (SNAP.exactS) or the unsnapped result.
  void index
  void initial
  void mode
  void view
  return { times: resolve(dt), target: null }
}

/** A point drag snapped (targets outside `limit` ignored). */
export function snapAt(index: SnapIndex, t: number, view: SnapView, limit?: { min: number; max: number }): { t: number; target: SnapTarget | null } {
  // TODO(E-05): snapPoints(index, [t], view, limit).
  void index
  void view
  void limit
  return { t, target: null }
}

/** The guide's text: "Cut · 0:04.0". */
export function snapLabel(target: SnapTarget): string {
  return `${target.label} · ${formatTime(target.t)}`
}
