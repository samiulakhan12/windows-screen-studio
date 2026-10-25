/**
 * The live camera bubble shown while recording: where it sits on screen (a corner of the work
 * area, at one of three sizes), where a drag drops it (the nearest corner), and how its corner
 * changes during the recording become camera corners on the project's layout track. Pure, so
 * the main process, the renderer and the tests share it.
 */
import type { Corner, LayoutSegment } from '../types'

export type BubbleSize = 'S' | 'M' | 'L'

export const BUBBLE_SIZES: readonly BubbleSize[] = ['S', 'M', 'L']
/** Diameter of the bubble window (DIP) for each size. */
export const BUBBLE_DIAMETER: Record<BubbleSize, number> = { S: 128, M: 184, L: 260 }
export const DEFAULT_BUBBLE_SIZE: BubbleSize = 'M'
/** Gap between the bubble and the edges of the work area (DIP). */
export const BUBBLE_MARGIN = 24

export const CORNER_NAMES: Record<Corner, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right'
}
const CORNERS = Object.keys(CORNER_NAMES) as Corner[]
export const isCorner = (v: unknown): v is Corner => CORNERS.includes(v as Corner)
export const isBubbleSize = (v: unknown): v is BubbleSize => BUBBLE_SIZES.includes(v as BubbleSize)

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** The bubble's window in `corner` of `area` (a display's work area), at `size`. */
export function bubbleBounds(area: ScreenRect, corner: Corner, size: BubbleSize): ScreenRect {
  // Never larger than the area allows (a tiny display still shows the whole bubble).
  const d = Math.max(48, Math.min(BUBBLE_DIAMETER[size], area.width - 2 * BUBBLE_MARGIN, area.height - 2 * BUBBLE_MARGIN))
  const x = corner.endsWith('left') ? area.x + BUBBLE_MARGIN : area.x + area.width - BUBBLE_MARGIN - d
  const y = corner.startsWith('top') ? area.y + BUBBLE_MARGIN : area.y + area.height - BUBBLE_MARGIN - d
  return { x: Math.round(x), y: Math.round(y), width: Math.round(d), height: Math.round(d) }
}

/** The corner of `area` nearest to a bubble whose window is `bounds` (by the quadrant of its centre). */
export function nearestCorner(area: ScreenRect, bounds: ScreenRect): Corner {
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  const top = cy < area.y + area.height / 2
  const left = cx < area.x + area.width / 2
  return `${top ? 'top' : 'bottom'}-${left ? 'left' : 'right'}` as Corner
}

/** A move of the bubble to `corner` at `t` seconds of the recording (paused time left out). */
export interface CameraMove {
  t: number
  corner: Corner
}

/**
 * Shortest time (seconds) the camera stays in a corner. A quicker visit (dragged there and
 * straight back, or a move in the last moments of the recording) is left out: the camera goes
 * on to where it went next, without a flicker the eye cannot follow.
 */
export const MIN_CORNER_STAY = 1

let idCounter = 0
const newId = (): string => `c${Date.now().toString(36)}${(idCounter++).toString(36)}`

/**
 * The camera corners of a recording as layout segments: a 'default' segment with its `corner` for
 * each time the camera was somewhere other than `defaultCorner` (the project's corner, used
 * where there is no segment). `moves` are the bubble's corners over the recording, the first one
 * where it started (a move before 0, made during the countdown, applies from the start).
 * Segments of consecutive corners touch, so the camera moves straight from one corner to the
 * next; each move then animates like any change of layout.
 */
export function cornerSegments(moves: readonly CameraMove[], duration: number, defaultCorner: Corner, id: () => string = newId): LayoutSegment[] {
  if (!(duration > 0)) return []
  const valid = moves.filter((m) => Number.isFinite(m.t) && isCorner(m.corner)).sort((a, b) => a.t - b.t)
  // Where the camera is from each instant on, the first stay from 0.
  const stays: { start: number; corner: Corner }[] = []
  for (const m of valid) {
    if (m.t >= duration) break
    const start = Math.max(0, m.t)
    const last = stays[stays.length - 1]
    if (last && last.corner === m.corner) continue
    if (last && last.start === start) last.corner = m.corner
    else stays.push({ start, corner: m.corner })
  }
  if (stays.length === 0) return []
  const kept: { start: number; corner: Corner }[] = []
  stays.forEach((s, i) => {
    const end = i + 1 < stays.length ? stays[i + 1].start : duration
    // Too short: left out (the corner before it carries on; a first one hands the start to the next).
    if (end - s.start < MIN_CORNER_STAY) return
    const last = kept[kept.length - 1]
    if (last?.corner === s.corner) return
    kept.push({ start: kept.length === 0 ? 0 : s.start, corner: s.corner })
  })
  // Only quick visits (a very short recording): the camera stays where it went last.
  if (kept.length === 0) kept.push({ start: 0, corner: stays[stays.length - 1].corner })
  const out: LayoutSegment[] = []
  kept.forEach((s, i) => {
    if (s.corner === defaultCorner) return
    const end = i + 1 < kept.length ? kept[i + 1].start : duration
    out.push({ id: id(), start: s.start, end, layout: 'default', corner: s.corner })
  })
  return out
}
