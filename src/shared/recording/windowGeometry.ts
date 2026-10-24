/**
 * Geometry for single-window recordings. The video keeps the window's initial size
 * (out.width x out.height); when the window is resized its content is scaled to FIT
 * inside that frame, centred, with black bars (the native helper and the proxy step use
 * this same rule). Cursor positions and clicks are mapped through the window's rectangle
 * at that moment into normalised (0..1) video coordinates: inside the window onto the
 * fitted content, outside it outside 0..1 (never into the bars), so the compositor's
 * "inside the video" test hides the cursor wherever the window is not.
 */

export interface Size {
  width: number
  height: number
}

export interface Rect extends Size {
  x: number
  y: number
}

export interface Fit {
  scale: number
  /** Offset and size of the content inside the output frame, in output pixels. */
  dx: number
  dy: number
  width: number
  height: number
}

/** Fits `content` inside `out` keeping its aspect ratio, centred. */
export function fitContent(content: Size, out: Size): Fit {
  const cw = Math.max(1, content.width)
  const ch = Math.max(1, content.height)
  const scale = Math.min(out.width / cw, out.height / ch)
  const width = cw * scale
  const height = ch * scale
  return { scale, dx: (out.width - width) / 2, dy: (out.height - height) / 2, width, height }
}

/** A window rectangle in both coordinate spaces at one moment. */
export interface WindowPose {
  /** Epoch ms (or any clock shared with the points being mapped). */
  at: number
  /**
   * Rectangle in the space of the points being mapped. Window recordings map in physical
   * pixels (positions are converted per point, which is exact on mixed-DPI setups), so this
   * is usually the same as `physical`.
   */
  dip: Rect
  /** Rectangle in physical pixels (the captured content size). */
  physical: Rect
  minimized?: boolean
  /**
   * False while the cursor is over another window that covers the recorded one (the capture
   * does not show that window): clicks there are not on the recorded content and the cursor
   * is hidden. Absent when unknown (older helpers, X11): treated as over the window.
   */
  cursorOver?: boolean
}

/** Index of the last pose at or before `at` (poses sorted by time); 0 before the first. */
export function poseIndexAt(poses: WindowPose[], at: number): number {
  let lo = 0
  let hi = poses.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (poses[mid].at <= at) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/**
 * How often the helper polls the window's rectangle (ms, a little over its ~16 ms tick). It
 * reports a rectangle only when it changed, so the window stood still at one pose until at
 * most one poll before the next pose.
 */
export const WINDOW_POLL_MS = 17

const sameSize = (a: Rect, b: Rect): boolean => a.width === b.width && a.height === b.height
const lerpRect = (a: Rect, b: Rect, k: number): Rect => ({ ...a, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k })

/**
 * The window's pose at `at`: the last reported one, except while the window is being moved,
 * where its position is interpolated across the last poll interval before the next pose (so
 * a cursor dragging the window by its title bar stays on the title bar, instead of running
 * ahead of it by up to one poll). Only a move is interpolated: a resize, or a minimised
 * window on either side, keeps the reported pose.
 */
export function poseAt(poses: WindowPose[], at: number, pollMs = WINDOW_POLL_MS): WindowPose {
  const i = poseIndexAt(poses, at)
  const a = poses[i]
  const b = poses[i + 1]
  if (!b || at <= a.at || a.minimized || b.minimized || !sameSize(a.physical, b.physical) || !sameSize(a.dip, b.dip)) return a
  const from = Math.max(a.at, b.at - pollMs)
  if (at <= from || b.at <= from) return a
  const k = (at - from) / (b.at - from)
  return { ...a, dip: lerpRect(a.dip, b.dip, k), physical: lerpRect(a.physical, b.physical, k) }
}

/**
 * Maps a screen point (same space as pose.dip) to normalised video coordinates.
 * Returns null while the window is minimised. Inside the window the point lands on the
 * fitted content; outside it, outside 0..1 (measured from the video's edge, so a point
 * beside a resized window never lands in the black bars).
 */
export function mapPointToWindowVideo(point: { x: number; y: number }, pose: WindowPose, out: Size): { x: number; y: number } | null {
  if (pose.minimized || pose.dip.width <= 0 || pose.dip.height <= 0) return null
  const u = (point.x - pose.dip.x) / pose.dip.width
  const v = (point.y - pose.dip.y) / pose.dip.height
  const fit = fitContent(pose.physical, out)
  const axis = (n: number, offset: number, size: number, total: number): number =>
    n < 0 ? (n * size) / total : n > 1 ? 1 + ((n - 1) * size) / total : (offset + n * size) / total
  return { x: axis(u, fit.dx, fit.width, out.width), y: axis(v, fit.dy, fit.height, out.height) }
}

/** How far outside the video (normalised) a hidden cursor is placed. */
const HIDDEN_MARGIN = 1

/**
 * Where a cursor that must not be drawn goes (normalised video coordinates): just past the
 * video edge nearest to `p`, so the drawn cursor leaves the frame there at once and the
 * zoom camera, which clamps its focus to the frame, stays on that side.
 */
export function hiddenPoint(p: { x: number; y: number }): { x: number; y: number } {
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return p
  const edges = [
    { d: p.x, at: { x: -HIDDEN_MARGIN, y: p.y } },
    { d: 1 - p.x, at: { x: 1 + HIDDEN_MARGIN, y: p.y } },
    { d: p.y, at: { x: p.x, y: -HIDDEN_MARGIN } },
    { d: 1 - p.y, at: { x: p.x, y: 1 + HIDDEN_MARGIN } }
  ]
  return edges.reduce((a, b) => (b.d < a.d ? b : a)).at
}

/** True when a screen point lies inside the window's rectangle (and it is not minimised). */
export function insideWindow(point: { x: number; y: number }, pose: WindowPose): boolean {
  const r = pose.dip
  return !pose.minimized && point.x >= r.x && point.y >= r.y && point.x <= r.x + r.width && point.y <= r.y + r.height
}

/** False while another window covers the recorded one under the cursor (unknown counts as over). */
export const cursorOverWindow = (pose: WindowPose): boolean => pose.cursorOver !== false

/** A window rectangle as the capture helper reports it: physical pixels at epoch ms `at`. */
export interface WindowRectSample extends Rect {
  at: number
  minimized?: boolean
  /** See WindowPose.cursorOver. */
  cursorOver?: boolean
}

const finite = (...v: unknown[]): boolean => v.every((n) => typeof n === 'number' && Number.isFinite(n))

/**
 * Turns the helper's rectangle timeline (physical pixels) into poses sorted by time.
 * `toDip` converts a physical rectangle into the space of the points being mapped (the
 * identity for window recordings, whose points are converted to physical pixels instead).
 * Malformed entries are skipped. A minimised window's rectangle is meaningless (Windows
 * parks it at -32000, -32000), so it is kept as is and never converted.
 */
export function posesFromRects(rects: readonly WindowRectSample[], toDip: (r: Rect) => Rect = (r) => r): WindowPose[] {
  const poses: WindowPose[] = []
  for (const r of rects) {
    if (!r || !finite(r.at, r.x, r.y, r.width, r.height)) continue
    const physical = { x: r.x, y: r.y, width: r.width, height: r.height }
    const minimized = r.minimized === true
    if (!minimized && (r.width <= 0 || r.height <= 0)) continue
    poses.push({ at: r.at, dip: minimized ? { ...physical } : toDip(physical), physical, minimized, ...(r.cursorOver === false ? { cursorOver: false } : {}) })
  }
  // Stable: rectangles reported at the same instant keep their order (the later one wins).
  return poses.sort((a, b) => a.at - b.at)
}
