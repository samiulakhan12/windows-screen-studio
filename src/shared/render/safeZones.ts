/**
 * Where TikTok, Instagram Reels and YouTube Shorts put their buttons and captions over a tall
 * video (docs/design/vertical-video.md §7), and the area all three leave free, which captions,
 * key presses, the logo and lower-third titles keep to when Project.reframe.appSafe is on (§6.3).
 *
 * The boxes are fractions of a 1080 x 1920 frame (x, w of the width; y, h of the height), rounded
 * to 0.01. They are approximate, in line with common creator guidance as of October 2026, not
 * measurements: the apps change their layouts from time to time, and they differ between phones,
 * languages, account types and paid placements. Before release someone compares them with the
 * three apps on a phone and records that date in each platform's `checked` field; until then it
 * holds the date the numbers were taken from that guidance. An update is one edit to this table
 * (it is never stored in projects).
 *
 * The box table is drawn only by the editor's safe-zone preview (DOM over the preview, never a
 * canvas): the render code imports only the placement rules (textArea, TEXT_INSET).
 *
 * CONTRACT: the table and COMMON_SAFE are final (data).
 */
import type { CameraLayout, Corner, NormRect, Project } from '../types'
import { bandSide, followGeometry, layoutPhaseAt, type Rect } from '../engine/layout'
import { clamp, easeInOutCubic, lerp } from '../engine/math'
import { followApplies, isTall } from '../engine/reframeData'

export type SafePlatform = 'tiktok' | 'reels' | 'shorts'
export type SafeChoice = SafePlatform | 'all'

/** An area an app covers, normalised to the frame, and what covers it. */
export interface SafeBox {
  x: number
  y: number
  w: number
  h: number
  label: string
}

export const SAFE_ZONES: Readonly<Record<SafePlatform, { name: string; checked: string; boxes: readonly SafeBox[] }>> = Object.freeze({
  tiktok: Object.freeze({
    name: 'TikTok',
    checked: '2026-10-28',
    boxes: Object.freeze([
      { x: 0, y: 0, w: 1, h: 0.08, label: 'Tabs and search' },
      { x: 0.86, y: 0.38, w: 0.14, h: 0.42, label: 'Like, comment, share' },
      { x: 0, y: 0.78, w: 1, h: 0.22, label: 'Name, caption and sound' }
    ])
  }),
  reels: Object.freeze({
    name: 'Instagram Reels',
    checked: '2026-10-28',
    boxes: Object.freeze([
      { x: 0, y: 0, w: 1, h: 0.11, label: 'Reels and camera' },
      { x: 0.87, y: 0.45, w: 0.13, h: 0.37, label: 'Like, comment, share' },
      { x: 0, y: 0.78, w: 1, h: 0.22, label: 'Name, caption and audio' }
    ])
  }),
  shorts: Object.freeze({
    name: 'YouTube Shorts',
    checked: '2026-10-28',
    boxes: Object.freeze([
      { x: 0, y: 0, w: 1, h: 0.08, label: 'Search and menu' },
      { x: 0.86, y: 0.4, w: 0.14, h: 0.44, label: 'Like, comment, share, remix' },
      { x: 0, y: 0.79, w: 1, h: 0.21, label: 'Title, channel and subscribe' }
    ])
  })
})

/**
 * The area all three apps leave free (§7), used for placement: top 0.11 (the deepest top bar,
 * Reels); bottom 0.76 (the highest bottom zone, 0.78, less 0.02 because the apps' captions grow
 * upward with long text); right 0.86 (the leftmost button column, TikTok and Shorts, over the full
 * height); left 0.06 (no buttons, but phones taller than 9:16 crop the sides).
 */
export const COMMON_SAFE: Readonly<NormRect> = Object.freeze({ x: 0.06, y: 0.11, w: 0.8, h: 0.65 })

/** Distance text keeps from the edges of a text area, as a fraction of the frame's shorter side (§6.3). */
export const TEXT_INSET = 0.02
/** Smallest share of its size an item is shrunk to by keepInArea unless told otherwise (§6.4). */
const MIN_FIT = 0.6

const PLATFORMS = Object.keys(SAFE_ZONES) as SafePlatform[]

/** The boxes the preview shades for `choice` ('all': every platform's nine), as copies. */
export function zonesFor(choice: SafeChoice): SafeBox[] {
  const platforms = choice === 'all' ? PLATFORMS : SAFE_ZONES[choice] ? [choice] : []
  return platforms.flatMap((p) => SAFE_ZONES[p].boxes.map((b) => ({ ...b })))
}

/**
 * Where captions, key presses, the logo and lower-third titles go in a w x h frame of a vw x vh
 * recording at source time `t` (output px, §6.3): COMMON_SAFE with appSafe in a tall frame, its
 * edge on the camera band's side moved to the screen's slot while following with a band; null
 * when neither applies (today's placement exactly). With a band the area is there all the time,
 * whole or pushed, so text never jumps between the two rules as the band hides and shows.
 */
export function textArea(project: Project, w: number, h: number, vw: number, vh: number, t: number): Rect | null {
  const reframe = project.reframe
  if (!reframe || !(w > 0 && h > 0)) return null
  const tall = isTall(w, h)
  const safe = reframe.appSafe && tall
  // Only a tall frame that follows has a band (bandSide says whether the camera is in one).
  const follows = tall && followApplies(project, w, h, vw, vh)
  if (!safe && !(follows && bandSide(project, w, h, vw, vh))) return null
  const area: Rect = safe ? { x: COMMON_SAFE.x * w, y: COMMON_SAFE.y * h, w: COMMON_SAFE.w * w, h: COMMON_SAFE.h * h } : { x: 0, y: 0, w, h }
  if (!follows) return area
  const [top, bottom] = bandEdges(project, w, h, vw, vh, t, area.y, area.y + area.h)
  return { ...area, y: top, h: Math.max(0, bottom - top) }
}

/**
 * The text area's top and bottom at source time `t` (output px) while following: the edge on a
 * band's side moved to the slot's (a band above the slot pushes the top down, one below it the
 * bottom up), none in screen-only (the band collapsed) and camera-only (the camera fills the
 * frame), eased between layouts as sceneLayout moves the slot (layoutPhaseAt), so text glides
 * with the band.
 */
function bandEdges(project: Project, w: number, h: number, vw: number, vh: number, t: number, top: number, bottom: number): [number, number] {
  const edges = (layout: CameraLayout, corner: Corner | undefined): [number, number] => {
    if (layout === 'screen-only' || layout === 'camera-only') return [top, bottom]
    const g = followGeometry(layout, project, w, h, vw, vh, corner)
    if (!g.band || !(g.band.h >= 1)) return [top, bottom]
    return g.band.y < g.slot.y ? [Math.max(top, g.slot.y), bottom] : [top, Math.min(bottom, g.slot.y + g.slot.h)]
  }
  const p = layoutPhaseAt(project, t)
  const to = edges(p.to, p.toCorner)
  if (p.progress >= 1 || (p.from === p.to && p.fromCorner === p.toCorner)) return to
  const from = edges(p.from, p.fromCorner)
  const e = easeInOutCubic(clamp(p.progress, 0, 1))
  return [lerp(from[0], to[0], e), lerp(from[1], to[1], e)]
}

/**
 * How to move (and shrink, not below `minScale`, 0.6 by default) `box` into `area`: the shift and
 * the scale about the box's centre. A box already inside gets { dx: 0, dy: 0, scale: 1 } exactly;
 * one still larger than the area at `minScale` is centred on it along that axis.
 */
export function keepInArea(box: Rect, area: Rect, minScale?: number): { dx: number; dy: number; scale: number } {
  if (![box.x, box.y, box.w, box.h, area.x, area.y, area.w, area.h].every(Number.isFinite)) return { dx: 0, dy: 0, scale: 1 }
  const floor = clamp(minScale !== undefined && Number.isFinite(minScale) ? minScale : MIN_FIT, 0, 1)
  const fit = Math.min(1, box.w > 0 ? area.w / box.w : 1, box.h > 0 ? area.h / box.h : 1)
  const scale = Math.max(floor, fit)
  const shift = (from: number, size: number, lo: number, room: number): number => {
    const s = size * scale
    const at = from + (size - s) / 2
    return s > room ? lo + (room - s) / 2 - at : clamp(at, lo, lo + room - s) - at
  }
  return { dx: shift(box.x, box.w, area.x, area.w), dy: shift(box.y, box.h, area.y, area.h), scale }
}
