/**
 * Where the camera bubble goes during the demo (docs/design/camera-director.md, step 10): a cost
 * per corner for how close the cursor, clicks and typing come to a bubble there, measured in
 * OUTPUT pixels exactly as the compositor draws them (sceneContentRect of the default layout,
 * cameraAt with the editor's focus path, toOutput), then a shortest-path search with a minimum
 * stay, so the bubble moves only when it has to and never flaps. Pure and deterministic.
 *
 * CONTRACT (workstream A): signatures and constants are frozen; bodies are to be written.
 */
import type { SmoothedTrack } from '../engine/cursor'
import type { Corner, CursorTrack, Project } from '../types'

/**
 * The search: a grid of `grid` s, pooled into `bin` s bins; each grid point's cost is the
 * highest within `lookBack` s before and `lookAhead` s after it (the bubble leaves before the
 * action arrives and does not come straight back). A bubble rectangle is padded by `pad` of the
 * output's shorter side and its cost falls to 0 at `falloff` of it. A corner is held at least
 * `minStay` s; a move costs `switchCost` (same edge) or `diagonalCost` weight-seconds; a corner
 * other than the one the bubble is in costs `entryCost` when it appears; `homeBias` per second
 * away from the project's corner breaks ties. A stretch moving more than `maxSwitchesPerMinute`
 * is searched again with doubled move costs, at most `maxReplans` times.
 */
export const CORNERS_PLAN = {
  grid: 0.1,
  bin: 0.5,
  lookBack: 1.0,
  lookAhead: 0.6,
  pad: 0.03,
  falloff: 0.1,
  minStay: 6.0,
  switchCost: 3.0,
  diagonalCost: 4.5,
  entryCost: 0.4,
  homeBias: 0.005,
  maxSwitchesPerMinute: 2,
  maxReplans: 3
} as const

/**
 * Weights of what draws the eye (per second): the drawn cursor moving (more than `moveEps` in
 * the last 0.1 s) or resting; times `hiddenCursor` when the smooth cursor is off, at least
 * `idleFloor` while it fades out when idle. Clicks within `clickSpan` s; typing from its start to
 * `typingTail` s after it, at the field typed into. A shown watermark costs its corner
 * `watermark` per second.
 */
export const ATTENTION = {
  moving: 1.0,
  resting: 0.5,
  moveEps: 0.004,
  hiddenCursor: 0.3,
  idleFloor: 0.2,
  click: 2.0,
  clickSpan: 0.75,
  typing: 1.5,
  typingTail: 1.0,
  watermark: 0.5
} as const

/** Corners in tie-break order from a home corner: itself, its neighbour on the same horizontal edge, on the same side, the diagonal one. */
export function cornerOrder(home: Corner): Corner[] {
  return notImplemented(home)
}

/** What the corner costs depend on (layouts do not: bubble time is always the default layout). */
export type CornerProject = Pick<Project, 'duration' | 'clips' | 'zooms' | 'zoomSettings' | 'webcam' | 'style' | 'width' | 'height' | 'capture' | 'cursor' | 'watermark'>

/** Cost per corner at every output grid point (CORNERS_PLAN.grid), already dilated (lookBack, lookAhead). */
export interface CornerCosts {
  grid: number
  /** Grid points: point j is at output time (j + 0.5) * grid. */
  length: number
  costs: Record<Corner, Float32Array>
}

/**
 * The corner costs of a project. Output size: outputSize(style.aspectRatio, width, height, 1080);
 * the screen: styleContentRect (the default layout); each point mapped with
 * toOutput(screen, cameraAt(zooms, t, cursor.valid ? focusPath : null, zoomStyleOf(project))) at
 * the source time of the grid point (outputToSource); a point outside the screen is not seen.
 * `cursorPath` is the drawn cursor (new SmoothedTrack(samples, duration, cursor.smoothing)) and
 * `focusPath` the zoom camera's (focusPathFor), as the editor builds them. Cached per inputs.
 */
export function cornerCosts(project: CornerProject, track: CursorTrack, cursorPath: SmoothedTrack, focusPath: SmoothedTrack | null): CornerCosts {
  return notImplemented(project, track, cursorPath, focusPath)
}

/** Bubble time between two other states, in which the director picks corners (output seconds). */
export interface CornerStretch {
  start: number
  end: number
  /**
   * The corner the camera is in right before the stretch: a camera position's or a layout
   * change's of the user's touching it; null: where the bubble was last seen (the previous
   * stretch's last corner), else the project's corner.
   */
  entry: Corner | null
  /** Whether the camera is visible in `entry` right before: then starting in another corner is a move (switch cost); else it appears there (entry cost). */
  enterVisible: boolean
  /** The corner of a camera position touching the end, which the bubble moves to there (switch cost, no minimum stay), or null. */
  exit: Corner | null
}

/** A corner held over output time. */
export interface CornerRun {
  start: number
  end: number
  corner: Corner
}

/**
 * The corners for `stretches` (in time order): runs covering each stretch, sorted. Within a
 * stretch a corner is held at least CORNERS_PLAN.minStay (unless the stretch is shorter, then
 * one corner), the last move at least minStay before its end; ties go to staying, then to
 * cornerOrder(home).
 */
export function planCorners(costs: CornerCosts, stretches: readonly CornerStretch[], home: Corner): CornerRun[] {
  return notImplemented(costs, stretches, home)
}

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
