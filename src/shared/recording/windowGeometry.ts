/**
 * Geometry for single-window recordings. The video keeps the window's initial size
 * (out.width x out.height); when the window is resized its content is scaled to FIT
 * inside that frame, centred, with black bars (the native helper and the proxy step use
 * this same rule). Cursor positions and clicks are mapped through the window's rectangle
 * at that moment into normalised (0..1) video coordinates.
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
  /** Rectangle in the cursor's coordinate space (Electron DIP on Windows). */
  dip: Rect
  /** Rectangle in physical pixels (the captured content size). */
  physical: Rect
  minimized?: boolean
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
 * Maps a screen point (same space as pose.dip) to normalised video coordinates.
 * Returns null while the window is minimised. Points outside the window map outside 0..1.
 */
export function mapPointToWindowVideo(point: { x: number; y: number }, pose: WindowPose, out: Size): { x: number; y: number } | null {
  if (pose.minimized || pose.dip.width <= 0 || pose.dip.height <= 0) return null
  const u = (point.x - pose.dip.x) / pose.dip.width
  const v = (point.y - pose.dip.y) / pose.dip.height
  const fit = fitContent(pose.physical, out)
  return { x: (fit.dx + u * fit.width) / out.width, y: (fit.dy + v * fit.height) / out.height }
}

/** True when a screen point lies inside the window's rectangle (and it is not minimised). */
export function insideWindow(point: { x: number; y: number }, pose: WindowPose): boolean {
  const r = pose.dip
  return !pose.minimized && point.x >= r.x && point.y >= r.y && point.x <= r.x + r.width && point.y <= r.y + r.height
}
