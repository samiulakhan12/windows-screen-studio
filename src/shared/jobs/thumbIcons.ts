/**
 * The taskbar thumbnail buttons' icons (Pause, Resume, Stop), drawn in code as white glyphs on a
 * transparent square: no image files to ship. Pure: RGBA (also valid BGRA, since only white and
 * transparent pixels are used) for nativeImage.createFromBitmap.
 */
import type { ThumbAction } from './longJobs'

export function thumbIcon(action: ThumbAction, size = 16): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const s = size / 16
  const inside = (x: number, y: number): boolean => {
    // Pixel centres in a 16-unit design grid.
    const u = (x + 0.5) / s
    const v = (y + 0.5) / s
    if (action === 'stop') return u >= 4 && u <= 12 && v >= 4 && v <= 12
    if (action === 'pause') return v >= 3.5 && v <= 12.5 && ((u >= 4 && u <= 6.5) || (u >= 9.5 && u <= 12))
    // resume: a right-pointing triangle from (4.5, 3) to (4.5, 13) and (12.5, 8)
    if (u < 4.5 || u > 12.5) return false
    const half = 5 * (1 - (u - 4.5) / 8)
    return Math.abs(v - 8) <= half
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inside(x, y)) continue
      px.set([255, 255, 255, 255], (y * size + x) * 4)
    }
  }
  return px
}
