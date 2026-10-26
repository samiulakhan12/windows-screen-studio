/**
 * Snapping on the timeline (E-05, docs/design/snapping.md): a dragged edge, a dragged point or
 * the scrubbed playhead catches cuts, splits, trims, freeze frames, chapters, used clicks, the
 * edges of other items, the playhead and the recording's ends. Everything is in source seconds;
 * thresholds are screen pixels converted with the current scale. Pure: the renderer session
 * (renderer/editor/snapControl.ts) only gates, tracks the current target and draws the guide.
 *
 * Snapping only chooses the numbers an existing drag writes: nothing is stored in the project.
 */
import { freezePlan, freezeSnapTargets, planOf } from '../engine/freeze'
import type { ClickRow } from '../engine/inputData'
import { formatTime } from '../engine/project'
import type { Chapter, Clip, Project } from '../types'
import { timelineGaps } from './clips'
import { shapeLabel } from './shapes'

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
  const out: SnapSegment[] = []
  const add = (prefix: string, label: string, list: readonly { id: string; start: number; end: number }[] | undefined): void => {
    for (const s of list ?? []) out.push({ owner: `${prefix}:${s.id}`, label, start: s.start, end: s.end })
  }
  add('zoom', 'Zoom', p.zooms)
  add('annotation', 'Text', p.annotations)
  for (const s of p.shapes ?? []) out.push({ owner: `shape:${s.id}`, label: shapeLabel(s.kind), start: s.start, end: s.end })
  for (const s of p.spotlights ?? []) out.push({ owner: `spotlight:${s.id}`, label: s.mode === 'cursor' ? 'Cursor spotlight' : 'Spotlight', start: s.start, end: s.end })
  add('title', 'Title card', p.titles)
  add('caption', 'Caption', p.transcript?.segments)
  if (opts.layouts) add('layout', 'Camera layout', p.layouts)
  return out
}

/**
 * Freeze frames (E-11) as targets: those of the plan without the excluded freezes ('freeze:<id>'),
 * so a dragged freeze never catches its own anchor or still end.
 */
export function projectFreezeTargets(p: Pick<Project, 'clips' | 'freezes'>, exclude: readonly SnapExclude[] = []): number[] {
  const dragged = new Set(exclude.filter((x) => x.owner.startsWith('freeze:')).map((x) => x.owner.slice('freeze:'.length)))
  if (dragged.size === 0) return freezeSnapTargets(p.clips, planOf(p))
  return freezeSnapTargets(p.clips, freezePlan(p.clips, (p.freezes ?? []).filter((f) => !dragged.has(f.id))))
}

/**
 * Everything a drag can snap to, read once at pointerdown. Freeze frames come from the project's
 * freeze plan unless `opts.freezes` gives them (projectFreezeTargets).
 */
export function projectSnapSources(
  p: Project,
  rows: readonly ClickRow[],
  opts: { playhead: number | null; layouts: boolean; freezes?: readonly number[] }
): SnapSources {
  return {
    duration: p.duration,
    clips: p.clips,
    clicks: rows.filter((r) => r.ignored === null).map((r) => r.click.t),
    chapters: p.chapters ?? [],
    segments: projectSnapSegments(p, opts),
    freezes: opts.freezes ?? projectFreezeTargets(p),
    playhead: opts.playhead
  }
}

/** The kept clips' edges strictly inside the recording: trims, cuts and splits. */
function clipTargets(clips: readonly Clip[], duration: number): SnapTarget[] {
  if (clips.length === 0) return []
  const cutEdges = new Set<number>()
  for (const g of timelineGaps(clips as Clip[], duration)) {
    if (g.kind !== 'cut') continue
    cutEdges.add(g.start)
    cutEdges.add(g.end)
  }
  const inner = (t: number): string => (cutEdges.has(t) ? 'Cut' : 'Split')
  const last = clips.length - 1
  const out: SnapTarget[] = []
  clips.forEach((c, i) => {
    out.push(i === 0 ? { t: c.start, kind: 'clip', label: 'Trim', owner: 'trim:start' } : { t: c.start, kind: 'clip', label: inner(c.start), owner: 'clips' })
    out.push(i === last ? { t: c.end, kind: 'clip', label: 'Trim', owner: 'trim:end' } : { t: c.end, kind: 'clip', label: inner(c.end), owner: 'clips' })
  })
  return out.filter((x) => x.t > 0 && x.t < duration)
}

const excluded = (x: SnapTarget, exclude: readonly SnapExclude[]): boolean =>
  exclude.some((e) => e.owner === x.owner && (e.edge === undefined || e.edge === x.edge))

/** The sorted, merged targets of `src`, without the excluded owners' edges. */
export function buildSnapIndex(src: SnapSources, exclude: readonly SnapExclude[] = []): SnapIndex {
  const { duration } = src
  const all: SnapTarget[] = [
    { t: 0, kind: 'bound', label: 'Start' },
    { t: duration, kind: 'bound', label: 'End' },
    ...clipTargets(src.clips, duration),
    ...src.freezes.map((t): SnapTarget => ({ t, kind: 'freeze', label: 'Freeze frame' })),
    ...src.chapters.map((c): SnapTarget => ({ t: c.t, kind: 'chapter', label: c.title ? `Chapter · ${c.title}` : 'Chapter', owner: `chapter:${c.id}`, edge: 'at' })),
    ...src.clicks.map((t): SnapTarget => ({ t, kind: 'click', label: 'Click' })),
    ...src.segments.flatMap((s): SnapTarget[] => [
      { t: s.start, kind: 'segment', label: `${s.label} start`, owner: s.owner, edge: 'start' },
      { t: s.end, kind: 'segment', label: `${s.label} end`, owner: s.owner, edge: 'end' }
    ])
  ]
  if (src.playhead !== null) all.push({ t: src.playhead, kind: 'playhead', label: 'Playhead' })
  const kept = all
    .filter((x) => Number.isFinite(x.t) && x.t >= 0 && x.t <= duration && !excluded(x, exclude))
    .sort((a, b) => a.t - b.t || SNAP_PRIORITY[a.kind] - SNAP_PRIORITY[b.kind])
  // Targets closer than SNAP.mergeS are one: the highest priority keeps the slot, with its own time.
  const targets: SnapTarget[] = []
  let groupStart = -Infinity
  for (const x of kept) {
    if (x.t - groupStart < SNAP.mergeS) {
      const i = targets.length - 1
      if (SNAP_PRIORITY[x.kind] < SNAP_PRIORITY[targets[i].kind]) targets[i] = x
      continue
    }
    groupStart = x.t
    targets.push(x)
  }
  return { times: Float64Array.from(targets, (x) => x.t), targets }
}

/** The dragged edges after a raw move of `dt`: the start, the end, or both. */
export function dragPoints(initial: Span, mode: DragMode, dt: number): number[] {
  if (mode === 'start') return [initial.start + dt]
  if (mode === 'end') return [initial.end + dt]
  return [initial.start + dt, initial.end + dt]
}

/** First index of `times` at or after `t`. */
function lowerBound(times: Float64Array, t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

const sameTarget = (a: SnapTarget, b: SnapTarget | null): boolean =>
  !!b && (a === b || (a.t === b.t && a.kind === b.kind && a.label === b.label && a.owner === b.owner && a.edge === b.edge))

interface Candidate {
  target: SnapTarget
  /** Seconds from the point. */
  d: number
  point: number
  current: boolean
}

/** The target nearest (in pixels) to any of `points`, with hysteresis and the tie rules; nothing caught: delta 0. */
export function snapPoints(index: SnapIndex, points: readonly number[], view: SnapView, limit?: { min: number; max: number }): SnapResult {
  const none: SnapResult = { delta: 0, target: null, point: -1 }
  const px = view.pxPerSec
  if (!(px > 0) || !Number.isFinite(px)) return none
  const enter = SNAP.enterPx / px
  const leave = SNAP.leavePx / px
  const tie = SNAP.tiePx / px
  const visible = view.visible ?? null
  const allowed = (t: number): boolean => !limit || (t >= limit.min && t <= limit.max)
  const current = view.current && allowed(view.current.t) ? view.current : null
  const cands: Candidate[] = []
  let held: Candidate | null = null
  for (let point = 0; point < points.length; point++) {
    const p = points[point]
    // An edge outside the visible part of the timeline catches nothing.
    if (!Number.isFinite(p) || (visible && (p < visible.start || p > visible.end))) continue
    for (let i = lowerBound(index.times, p - enter); i < index.times.length && index.times[i] <= p + enter; i++) {
      const target = index.targets[i]
      if (allowed(target.t) && !sameTarget(target, current)) cands.push({ target, d: Math.abs(target.t - p), point, current: false })
    }
    // The target already holding the edge keeps it out to SNAP.leavePx.
    if (current) {
      const d = Math.abs(current.t - p)
      if (d <= leave && (!held || d < held.d)) held = { target: current, d, point, current: true }
    }
  }
  if (held) cands.push(held)
  if (cands.length === 0) return none
  const nearest = Math.min(...cands.map((c) => c.d))
  const best = cands
    .filter((c) => c.d <= nearest + tie)
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        SNAP_PRIORITY[a.target.kind] - SNAP_PRIORITY[b.target.kind] ||
        a.point - b.point ||
        a.target.t - b.target.t
    )[0]
  return { delta: best.target.t - points[best.point], target: best.target, point: best.point }
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
  const r = snapPoints(index, dragPoints(initial, mode, dt), view)
  if (!r.target) return { times: resolve(dt), target: null }
  const out = resolve(dt + r.delta)
  const edge = mode === 'start' || (mode === 'move' && r.point === 0) ? 'start' : 'end'
  const t = r.target.t
  // A bound or a minimum length moved the edge off its target: the drag goes where the pointer says.
  if (Math.abs(out[edge] - t) > SNAP.exactS) return { times: resolve(dt), target: null }
  if (mode !== 'move') return { times: { ...out, [edge]: t }, target: r.target }
  // Written exactly: the snapped edge is the target, the other keeps the item's length.
  const len = initial.end - initial.start
  return { times: edge === 'start' ? { start: t, end: t + len } : { start: t - len, end: t }, target: r.target }
}

/** A point drag snapped (targets outside `limit` ignored). */
export function snapAt(index: SnapIndex, t: number, view: SnapView, limit?: { min: number; max: number }): { t: number; target: SnapTarget | null } {
  const r = snapPoints(index, [t], view, limit)
  return { t: r.target ? r.target.t : t, target: r.target }
}

/** The guide's text: "Cut · 0:04.0". */
export function snapLabel(target: SnapTarget): string {
  return `${target.label} · ${formatTime(target.t)}`
}
