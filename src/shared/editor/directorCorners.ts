/**
 * Where the camera bubble goes during the demo (docs/design/camera-director.md, step 10): a cost
 * per corner for how close the cursor, clicks and typing come to a bubble there, measured in
 * OUTPUT pixels exactly as the compositor draws them (sceneContentRect of the default layout,
 * frameCamera with the editor's focus path, toOutput), then a shortest-path search with a minimum
 * stay, so the bubble moves only when it has to and never flaps. Pure and deterministic. While the
 * view follows the action (docs/design/vertical-video.md §5.14) the screen is the default layout's
 * slot, the camera rests on the follow plan, and a point is seen when it is drawn in the slot.
 */
import { cursorAt, cursorOpacity, type SmoothedTrack } from '../engine/cursor'
import { frameCamera, type ViewScene } from '../engine/frameView'
import { baseView, followGeometry, followLevel, outputSize, styleContentRect, virtualRect, webcamRect, type Rect, type SceneLayout } from '../engine/layout'
import { toOutput } from '../engine/outputPoint'
import { followPlanFor } from '../engine/reframe'
import { followApplies } from '../engine/reframeData'
import { outputDuration } from '../engine/timeline'
import { activeWatermark } from '../engine/watermark'
import { TYPING_CLICK_WINDOW, zoomStyleOf } from '../engine/zoom'
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
  const horizontal = flip(home, 'x')
  const vertical = flip(home, 'y')
  return [home, horizontal, vertical, flip(horizontal, 'y')]
}

/**
 * What the corner costs depend on (layouts do not: bubble time is always the default layout).
 * While the view follows the action they also depend on the follow plan, which reads the layouts,
 * whether there is a camera, the shapes and the spotlights.
 */
export type CornerProject = Pick<
  Project,
  'duration' | 'clips' | 'zooms' | 'zoomSettings' | 'webcam' | 'style' | 'width' | 'height' | 'capture' | 'cursor' | 'watermark' | 'hasWebcam' | 'layouts' | 'reframe' | 'shapes' | 'spotlights'
>

/** Cost per corner at every output grid point (CORNERS_PLAN.grid), already dilated (lookBack, lookAhead). */
export interface CornerCosts {
  grid: number
  /** Grid points: point j is at output time (j + 0.5) * grid. */
  length: number
  costs: Record<Corner, Float32Array>
}

/**
 * The corner costs of a project. Output size: outputSize(style.aspectRatio, width, height, 1080);
 * the screen: styleContentRect (the default layout); each point mapped with toOutput(screen, the
 * camera of frameCamera: the zooms with the focus path when the cursor is valid, the project's
 * zoom style) at the source time of the grid point (outputToSource); a point outside the screen
 * is not seen. While following: the default layout's slot and virtual rectangle, the camera
 * resting on the follow plan, and a point is seen inside the slot.
 * `cursorPath` is the drawn cursor (new SmoothedTrack(samples, duration, cursor.smoothing)) and
 * `focusPath` the zoom camera's (focusPathFor), as the editor builds them. Cached per inputs.
 */
export function cornerCosts(project: CornerProject, track: CursorTrack, cursorPath: SmoothedTrack, focusPath: SmoothedTrack | null): CornerCosts {
  const key = costKey(project, track, cursorPath, focusPath)
  let byKey = costCache.get(track.samples)
  if (!byKey) costCache.set(track.samples, (byKey = new Map()))
  const cached = byKey.get(key)
  if (cached) return cached
  const costs = computeCosts(project, track, cursorPath, focusPath)
  // A handful of variants per recording (the editor changes one input at a time).
  if (byKey.size >= COST_CACHE_SIZE) byKey.delete(byKey.keys().next().value as string)
  byKey.set(key, costs)
  return costs
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
  const out: CornerRun[] = []
  let lastSeen: Corner | null = null
  for (const st of stretches) {
    if (!(st.end - st.start > 1e-9)) continue
    const bins = binCosts(costs, st, home)
    let scale = 1
    let path = searchStretch(bins, st, st.entry ?? lastSeen ?? home, home, scale)
    for (let r = 0; r < CORNERS_PLAN.maxReplans && busy(path, st); r++) {
      scale *= 2
      path = searchStretch(bins, st, st.entry ?? lastSeen ?? home, home, scale)
    }
    for (let b = 0; b < path.length; b++) {
      const start = st.start + b * CORNERS_PLAN.bin
      const end = b === path.length - 1 ? st.end : st.start + (b + 1) * CORNERS_PLAN.bin
      const last = out[out.length - 1]
      if (last && last.corner === path[b] && Math.abs(last.end - start) <= 1e-9) last.end = end
      else out.push({ start, end, corner: path[b] })
    }
    lastSeen = path[path.length - 1]
  }
  return out
}

/** The corners in the order of CornerCosts.costs' arrays when they are walked by index. */
const CORNER_LIST: readonly Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

/** The corner across the vertical ('x': same top or bottom edge) or the horizontal ('y': same side) middle line. */
function flip(c: Corner, axis: 'x' | 'y'): Corner {
  const [v, h] = c.split('-') as ['top' | 'bottom', 'left' | 'right']
  return axis === 'x' ? `${v}-${h === 'left' ? 'right' : 'left'}` : `${v === 'top' ? 'bottom' : 'top'}-${h}`
}

/** What moving the bubble from `a` to `b` costs (weight-seconds), times `scale`. */
function moveCost(a: Corner, b: Corner, scale: number): number {
  if (a === b) return 0
  const [av, ah] = a.split('-')
  const [bv, bh] = b.split('-')
  return (av === bv || ah === bh ? CORNERS_PLAN.switchCost : CORNERS_PLAN.diagonalCost) * scale
}

/* ---------- costs ---------- */

const COST_CACHE_SIZE = 8
const costCache = new WeakMap<CursorTrack['samples'], Map<string, CornerCosts>>()
const objectIds = new WeakMap<object, number>()
let nextObjectId = 1
const objectId = (o: object | null | undefined): number => {
  if (!o) return 0
  let id = objectIds.get(o)
  if (!id) objectIds.set(o, (id = nextObjectId++))
  return id
}

/** Everything the costs depend on besides the samples (the cache's outer key). */
function costKey(project: CornerProject, track: CursorTrack, cursorPath: SmoothedTrack, focusPath: SmoothedTrack | null): string {
  const style = zoomStyleOf(project)
  const wm = activeWatermark(project)
  const frame = outputSize(project.style.aspectRatio, project.width, project.height, 1080)
  // While following, the plan reads more of the project (layouts, shapes...): its identity stands for them.
  const plan = followApplies(project, frame.width, frame.height, project.width, project.height) ? followPlanFor(project, track) : null
  return JSON.stringify([
    objectId(cursorPath),
    objectId(focusPath),
    objectId(track.clicks),
    objectId(track.typing),
    track.valid,
    project.clips.map((c) => [c.start, c.end, c.speed]),
    project.zooms,
    style.easing,
    style.transition,
    project.style.aspectRatio,
    project.style.padding,
    project.style.frame ?? null,
    project.width,
    project.height,
    project.webcam.size,
    project.capture.cursorInVideo,
    project.cursor.show,
    project.cursor.hideWhenIdle,
    wm?.position ?? null,
    project.reframe ?? null,
    objectId(plan)
  ])
}

/**
 * Where the screen is drawn while measuring (the default layout, as the bubble's) and the scene
 * the camera is asked with. Following: the default layout's slot, its view and virtual rectangle.
 */
function measuredScene(project: CornerProject, track: CursorTrack, focusPath: SmoothedTrack | null, W: number, H: number): { layout: SceneLayout; scene: ViewScene; seen: Rect } {
  const vw = project.width
  const vh = project.height
  const drawn = project as Project
  if (!followApplies(project, W, H, vw, vh)) {
    const screen = styleContentRect(W, H, vw, vh, project.style)
    // Without a focus path the camera follows no cursor, as before.
    const scene: ViewScene = { project: drawn, cursor: focusPath ? track : { ...track, valid: false }, focusPath: focusPath ?? NO_PATH }
    return { layout: { screen, camera: null, moving: false }, scene, seen: screen }
  }
  const g = followGeometry('default', project, W, H, vw, vh)
  const base = baseView(g.slot, vw, vh, followLevel(project, vw, vh))
  const layout: SceneLayout = { screen: virtualRect(g.slot, base), camera: g.camera, moving: false, follow: { slot: g.slot, base, band: g.band } }
  return { layout, scene: { project: drawn, cursor: track, focusPath: focusPath ?? NO_PATH }, seen: g.slot }
}

/** A path for a scene without one (never read: the camera is then asked without cursor data, or follows the plan). */
const NO_PATH = { at: (): { x: number; y: number } => ({ x: 0.5, y: 0.5 }) }

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

function computeCosts(project: CornerProject, track: CursorTrack, cursorPath: SmoothedTrack, focusPath: SmoothedTrack | null): CornerCosts {
  const G = CORNERS_PLAN.grid
  const clips = project.clips
  const total = outputDuration(clips)
  const length = Math.max(0, Math.ceil(total / G - 1e-9))
  const raw = CORNER_LIST.map(() => new Float32Array(length))
  const { width: W, height: H } = outputSize(project.style.aspectRatio, project.width, project.height, 1080)
  const { layout, scene, seen } = measuredScene(project, track, focusPath, W, H)
  const m = Math.min(W, H)
  const pad = CORNERS_PLAN.pad * m
  const falloff = CORNERS_PLAN.falloff * m
  const boxes: Box[] = CORNER_LIST.map((corner) => {
    const r = webcamRect(W, H, { corner, size: project.webcam.size })
    return { x0: r.x - pad, y0: r.y - pad, x1: r.x + r.w + pad, y1: r.y + r.h + pad }
  })
  const samples = track.samples
  const valid = track.valid && samples.length > 0
  const inUnit = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
  const clicks = valid ? track.clicks.filter((c) => Number.isFinite(c.t) && inUnit(c)).sort((a, b) => a.t - b.t) : []
  // Typing is watched at the field typed into: its auto zoom's anchor, else the click before it.
  const typing = (valid ? (track.typing ?? []) : [])
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.end))
    .map((b) => {
      const zoom = project.zooms.find((z) => z.auto && z.anchor && z.start <= b.t + 1e-9 && z.end >= b.t - 1e-9)
      const click = clicks.filter((c) => c.t <= b.t && c.t >= b.t - TYPING_CLICK_WINDOW).pop()
      const at = zoom?.anchor ?? click ?? null
      return { from: b.t, to: b.end + ATTENTION.typingTail, at: at && inUnit(at) ? { x: at.x, y: at.y } : null }
    })
    .sort((a, b) => a.from - b.from)
  const cursorWeight = (t: number): number => {
    if (project.capture.cursorInVideo) return 1
    if (!project.cursor.show) return ATTENTION.hiddenCursor
    return project.cursor.hideWhenIdle ? Math.max(ATTENTION.idleFloor, cursorOpacity(samples, t)) : 1
  }

  let ci = 0
  let acc = 0
  let clickLo = 0
  for (let j = 0; j < length; j++) {
    const o = (j + 0.5) * G
    while (ci < clips.length - 1 && o >= acc + (clips[ci].end - clips[ci].start) / clips[ci].speed) {
      acc += (clips[ci].end - clips[ci].start) / clips[ci].speed
      ci++
    }
    const clip = clips[ci]
    const t = Math.min(clip.start + (o - acc) * clip.speed, clip.end)
    if (!valid) continue
    const map = toOutput(layout.screen, frameCamera(scene, layout, t))
    const add = (x: number, y: number, w: number): void => {
      const q = map(x, y)
      // Zoomed in (or outside the followed view), a point is not seen.
      if (q.x < seen.x || q.x > seen.x + seen.w || q.y < seen.y || q.y > seen.y + seen.h) return
      for (let c = 0; c < 4; c++) {
        const b = boxes[c]
        const d = Math.hypot(Math.max(b.x0 - q.x, 0, q.x - b.x1), Math.max(b.y0 - q.y, 0, q.y - b.y1))
        const prox = 1 - d / falloff
        if (prox > 0) raw[c][j] += w * prox
      }
    }
    const here = cursorAt(samples, t)!
    const drawn = project.capture.cursorInVideo ? here : cursorPath.at(t)
    if (inUnit(here)) {
      const before = cursorAt(samples, t - 0.1)!
      const moving = Math.hypot(here.x - before.x, here.y - before.y) > ATTENTION.moveEps
      add(drawn.x, drawn.y, (moving ? ATTENTION.moving : ATTENTION.resting) * cursorWeight(t))
    }
    while (clickLo < clicks.length && clicks[clickLo].t < t - ATTENTION.clickSpan) clickLo++
    for (let k = clickLo; k < clicks.length && clicks[k].t <= t + ATTENTION.clickSpan; k++) add(clicks[k].x, clicks[k].y, ATTENTION.click)
    for (const b of typing) {
      if (b.from > t) break
      if (t <= b.to) {
        const at = b.at ?? drawn
        add(at.x, at.y, ATTENTION.typing)
      }
    }
  }

  // The bubble leaves before the action arrives and does not come straight back.
  const back = Math.round(CORNERS_PLAN.lookBack / G)
  const ahead = Math.round(CORNERS_PLAN.lookAhead / G)
  const wm = activeWatermark(project)
  const out = {} as Record<Corner, Float32Array>
  CORNER_LIST.forEach((corner, c) => {
    const src = raw[c]
    const dst = new Float32Array(length)
    const extra = wm && wm.position === corner ? ATTENTION.watermark : 0
    for (let j = 0; j < length; j++) {
      let v = 0
      for (let k = Math.max(0, j - back); k <= Math.min(length - 1, j + ahead); k++) if (src[k] > v) v = src[k]
      dst[j] = v + extra
    }
    out[corner] = dst
  })
  return { grid: G, length, costs: out }
}

/* ---------- search ---------- */

/** Cost of each corner (CORNER_LIST order) per bin of `st`, with the tie-break against leaving home. */
function binCosts(costs: CornerCosts, st: CornerStretch, home: Corner): Float64Array[] {
  const { bin, homeBias } = CORNERS_PLAN
  const G = costs.grid
  const count = Math.max(1, Math.ceil((st.end - st.start) / bin - 1e-9))
  return CORNER_LIST.map((corner) => {
    const arr = costs.costs[corner]
    const out = new Float64Array(count)
    for (let b = 0; b < count; b++) {
      const t0 = st.start + b * bin
      const t1 = b === count - 1 ? st.end : t0 + bin
      let sum = 0
      // Grid point j (at (j + 0.5) * G) belongs to the bin it lies in.
      for (let j = Math.max(0, Math.ceil(t0 / G - 0.5 - 1e-9)); j < costs.length && (j + 0.5) * G < t1 - 1e-9; j++) sum += arr[j] * G
      out[b] = sum + (corner === home ? 0 : homeBias * (t1 - t0))
    }
    return out
  })
}

/**
 * The cheapest corner per bin: states (corner, bins since the last move, saturating at the
 * minimum stay); staying is free, a move is allowed only after the minimum stay. Ties: staying,
 * then cornerOrder(home).
 */
function searchStretch(bins: Float64Array[], st: CornerStretch, entry: Corner, home: Corner, scale: number): Corner[] {
  const D = Math.round(CORNERS_PLAN.minStay / CORNERS_PLAN.bin)
  const nb = bins[0].length
  const order = cornerOrder(home).map((c) => CORNER_LIST.indexOf(c))
  const S = 4 * D
  const idx = (c: number, k: number): number => c * D + (k - 1)
  let cost = new Float64Array(S).fill(Infinity)
  let next = new Float64Array(S)
  const back = new Int16Array(nb * S).fill(-1)
  for (const c of order) {
    const corner = CORNER_LIST[c]
    const start = corner === entry ? 0 : st.enterVisible ? moveCost(entry, corner, scale) : CORNERS_PLAN.entryCost
    cost[idx(c, 1)] = start + bins[c][0]
  }
  for (let b = 1; b < nb; b++) {
    next.fill(Infinity)
    for (const c of order) {
      for (let k = 1; k <= D; k++) {
        let best = Infinity
        let from = -1
        const consider = (p: number, extra: number): void => {
          const v = cost[p] + extra
          if (v < best - 1e-9) {
            best = v
            from = p
          }
        }
        if (k === D) consider(idx(c, D), 0)
        if (k >= 2) consider(idx(c, k - 1), 0)
        if (k === 1) for (const p of order) if (p !== c) consider(idx(p, D), moveCost(CORNER_LIST[p], CORNER_LIST[c], scale))
        if (from >= 0) {
          next[idx(c, k)] = best + bins[c][b]
          back[b * S + idx(c, k)] = from
        }
      }
    }
    const swap = cost
    cost = next
    next = swap
  }
  // The last corner is held the minimum stay too (unless the stretch is shorter than it).
  let best = Infinity
  let end = -1
  for (const c of order) {
    for (let k = D; k >= (nb >= D ? D : 1); k--) {
      const v = cost[idx(c, k)] + (st.exit ? moveCost(CORNER_LIST[c], st.exit, scale) : 0)
      if (v < best - 1e-9) {
        best = v
        end = idx(c, k)
      }
    }
  }
  const path: Corner[] = new Array(nb)
  for (let b = nb - 1, s = end; b >= 0; b--) {
    path[b] = CORNER_LIST[Math.floor(s / D)]
    s = back[b * S + s]
  }
  return path
}

/** Whether a stretch's corners move more than CORNERS_PLAN.maxSwitchesPerMinute (and more than once). */
function busy(path: readonly Corner[], st: CornerStretch): boolean {
  let moves = 0
  for (let b = 1; b < path.length; b++) if (path[b] !== path[b - 1]) moves++
  return moves > 1 && moves > (CORNERS_PLAN.maxSwitchesPerMinute * (st.end - st.start)) / 60
}
