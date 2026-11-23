/**
 * A cover's colour (docs/design/auto-blur.md §8.4): the median of a 2 px ring just outside its box
 * in the frame it was made from (raw, before the grade), and how mixed that ring is. A ring over
 * mixed backgrounds (a spread over 24 levels) gives Dark. Settings' *Colour of new covers* can
 * replace the ring with a chip. Pure.
 */
import { COVER_COLOURS, COVER_DARK } from '../privacy/kinds'
import type { PrivacyPrefs } from '../types'

/** The ring's width outside the box, in pixels. */
export const RING_PX = 2
/** A ring whose largest per-channel median absolute deviation is over this many levels is mixed: Dark. */
export const MIXED_SPREAD = 24

const hex2 = (v: number): string => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')

/** The median of `values` (sorted in place). */
function median(values: number[]): number {
  values.sort((a, b) => a - b)
  const n = values.length
  if (!n) return 0
  return n % 2 ? values[(n - 1) >> 1] : (values[n / 2 - 1] + values[n / 2]) / 2
}

/**
 * The ring of `box` (pixels of a `width` × `height` RGBA picture): the median RGB of the pixels at
 * most RING_PX outside the box and inside the picture, and its spread (the largest per-channel
 * median absolute deviation). A box with no ring inside the picture (it fills the frame) gives Dark
 * with no spread.
 */
export function ringColour(pixels: Uint8ClampedArray, width: number, height: number, box: { x: number; y: number; w: number; h: number }): { color: string; spread: number } {
  const x0 = Math.floor(box.x)
  const y0 = Math.floor(box.y)
  const x1 = Math.ceil(box.x + box.w)
  const y1 = Math.ceil(box.y + box.h)
  const r: number[] = []
  const g: number[] = []
  const b: number[] = []
  for (let y = Math.max(0, y0 - RING_PX); y < Math.min(height, y1 + RING_PX); y++) {
    for (let x = Math.max(0, x0 - RING_PX); x < Math.min(width, x1 + RING_PX); x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue
      const i = (y * width + x) * 4
      r.push(pixels[i])
      g.push(pixels[i + 1])
      b.push(pixels[i + 2])
    }
  }
  if (!r.length) return { color: COVER_DARK, spread: 0 }
  const mr = median([...r])
  const mg = median([...g])
  const mb = median([...b])
  const mad = (vals: number[], m: number): number => median(vals.map((v) => Math.abs(v - m)))
  const spread = Math.max(mad(r, mr), mad(g, mg), mad(b, mb))
  return { color: `#${hex2(mr)}${hex2(mg)}${hex2(mb)}`, spread }
}

/** The colour a new cover takes (§8.4): a chip the preference names, else the ring's, else Dark for a mixed ring. */
export function coverColourOf(ring: { color: string; spread: number }, pref: PrivacyPrefs['colour']): string {
  if (pref && pref !== 'ring') return COVER_COLOURS[pref]
  return ring.spread > MIXED_SPREAD ? COVER_DARK : ring.color
}
