/**
 * Where the click-through demo puts a step's callout (docs/design/smart-tools.md §6.1): beside the
 * hotspot, to its right with a pointer to it, to its left when the hotspot is in the right 40% of
 * the picture, above or below when neither side has room, at the top left without a hotspot; never
 * over the hotspot. Below DEMO_NARROW px of page width the page's own styles put it under the
 * picture. Sizes are CSS pixels of the picture as shown. Pure.
 */

/** Page width (CSS px) below which the callout sits under the picture. */
export const DEMO_NARROW = 640

/** The hotspot's half size (a 44 px button), the gap to the callout and the margin at the corner. */
export const DEMO_HOTSPOT = 44
export const DEMO_GAP = 16
const CORNER = 16

/** The callout's place: its side of the hotspot and its top left corner in the picture. */
export function calloutPlace(
  hotspot: { x: number; y: number } | null,
  picture: { w: number; h: number },
  callout: { w: number; h: number }
): { side: 'right' | 'left' | 'above' | 'below' | 'corner'; x: number; y: number } {
  if (!hotspot) return { side: 'corner', x: CORNER, y: CORNER }
  const half = DEMO_HOTSPOT / 2
  const need = callout.w + DEMO_GAP
  const roomRight = picture.w - (hotspot.x + half)
  const roomLeft = hotspot.x - half
  const midY = Math.min(Math.max(0, hotspot.y - callout.h / 2), Math.max(0, picture.h - callout.h))
  const right = { side: 'right' as const, x: hotspot.x + half + DEMO_GAP, y: midY }
  const left = { side: 'left' as const, x: hotspot.x - half - DEMO_GAP - callout.w, y: midY }
  const preferLeft = hotspot.x > 0.6 * picture.w
  const first = preferLeft ? left : right
  const second = preferLeft ? right : left
  if ((preferLeft ? roomLeft : roomRight) >= need) return first
  if ((preferLeft ? roomRight : roomLeft) >= need) return second
  // Neither side: above or below, whichever has more room, never over the hotspot.
  const x = Math.min(Math.max(0, hotspot.x - callout.w / 2), Math.max(0, picture.w - callout.w))
  const roomAbove = hotspot.y - half - DEMO_GAP
  const roomBelow = picture.h - (hotspot.y + half + DEMO_GAP)
  if (roomBelow >= callout.h || roomBelow >= roomAbove) return { side: 'below', x, y: hotspot.y + half + DEMO_GAP }
  return { side: 'above', x, y: hotspot.y - half - DEMO_GAP - callout.h }
}
