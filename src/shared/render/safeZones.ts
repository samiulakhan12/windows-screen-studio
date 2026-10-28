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
 * canvas): the compositor imports only textArea and COMMON_SAFE, which are placement rules.
 *
 * CONTRACT: the table and COMMON_SAFE are final (data); the functions belong to part P2.
 */
import type { NormRect, Project } from '../types'
import type { Rect } from '../engine/layout'

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

/** The boxes the preview shades for `choice` ('all': every platform's nine). */
export function zonesFor(choice: SafeChoice): SafeBox[] {
  return notImplemented(choice)
}

/**
 * Where captions, key presses, the logo and lower-third titles go in a w x h frame of a vw x vh
 * recording at source time `t` (output px, §6.3): COMMON_SAFE with appSafe in a tall frame, its
 * edge on the camera band's side moved to the screen's slot while following with a band; null
 * when neither applies (today's placement exactly).
 */
export function textArea(project: Project, w: number, h: number, vw: number, vh: number, t: number): Rect | null {
  return notImplemented(project, w, h, vw, vh, t)
}

/** How to move (and shrink, not below `minScale`) `box` into `area`: the shift and the scale about the box's centre. */
export function keepInArea(box: Rect, area: Rect, minScale?: number): { dx: number; dy: number; scale: number } {
  return notImplemented(box, area, minScale)
}

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
