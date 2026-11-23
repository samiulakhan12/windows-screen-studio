/**
 * Covers on the editor's own pictures of the raw recording (docs/design/auto-blur.md §9 rows 18 and
 * 28): the timeline's filmstrip tiles and the Style tab's look chips. Both are filled in Dark.
 * Neither draws anything for a project without covers, or where no cover is active.
 */
import { cropOf, rectToCrop, visibleSize } from '../../../shared/engine/crop'
import { coverSlack, drawnBox } from '../../../shared/privacy/coverPath'
import { coverIndex, coversAt, coversIn } from '../../../shared/privacy/covers'
import { COVER_DARK } from '../../../shared/privacy/kinds'
import type { NormRect, Project } from '../../../shared/types'

/** How far back a filmstrip tile's picture can be (§9 row 18): one key-frame interval of 15 frames, and 0.02 s. */
export const TILE_REACH_FRAMES = 15
const TILE_REACH_EXTRA = 0.02

const clip01 = (b: NormRect): NormRect | null => {
  const x0 = Math.max(0, b.x)
  const y0 = Math.max(0, b.y)
  const x1 = Math.min(1, b.x + b.w)
  const y1 = Math.min(1, b.y + b.h)
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

/**
 * Fills, in Dark, the boxes of every cover active anywhere in [t − 15 / fps − 0.02, t] over each
 * tile (a tile shows the last key frame at or before its time, up to one key-frame interval
 * earlier). A cover's box there is the union of its boxes over that window, in the crop's view the
 * tile shows. Tiles are in the canvas's units; a tile cut short at the strip's end keeps the full
 * tile's scale (its picture is cut, not squeezed). No draw call without a cover in a tile's window.
 */
export function fillCoverTiles(ctx: CanvasRenderingContext2D, project: Project, fps: number, tiles: readonly { t: number; x: number; y: number; w: number; h: number }[]): void {
  const covers = project.covers
  if (!covers?.length || !tiles.length) return
  const index = coverIndex(covers)
  const crop = cropOf(project)
  const shown = visibleSize(project)
  const aspect = shown.height > 0 ? shown.width / shown.height : 16 / 9
  const reach = TILE_REACH_FRAMES / (Number.isFinite(fps) && fps > 0 ? fps : 60) + TILE_REACH_EXTRA
  let filled = false
  for (const tile of tiles) {
    const from = tile.t - reach
    const hits = coversIn(index, from, tile.t)
    if (!hits.length) continue
    // The full tile's width at its height (the strip's last tile can be cut short).
    const full = Math.max(tile.w, tile.h * aspect)
    for (const c of hits) {
      const box = drawnBox(c, (from + tile.t) / 2, (tile.t - from) / 2)
      const view = box && clip01(rectToCrop(crop, box))
      if (!view) continue
      const x0 = Math.floor(tile.x + view.x * full)
      const x1 = Math.min(tile.x + tile.w, Math.ceil(tile.x + (view.x + view.w) * full))
      const y0 = Math.floor(tile.y + view.y * tile.h)
      const y1 = Math.ceil(tile.y + (view.y + view.h) * tile.h)
      if (x1 <= x0 || y1 <= y0) continue
      if (!filled) {
        ctx.save()
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = COVER_DARK
        filled = true
      }
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    }
  }
  if (filled) ctx.restore()
}

const DARK = [parseInt(COVER_DARK.slice(1, 3), 16), parseInt(COVER_DARK.slice(3, 5), 16), parseInt(COVER_DARK.slice(5, 7), 16)]

/**
 * Fills, in Dark, the boxes of the covers active at `t` (with the frame's slack) into a look chip's
 * pixels (`width` × `height` RGBA of the whole frame) before grading, rounded outward. Touches
 * nothing without an active cover.
 */
export function fillCoverPixels(pixels: Uint8ClampedArray, width: number, height: number, project: Project, t: number): void {
  const covers = project.covers
  if (!covers?.length) return
  const slack = coverSlack(project.capture?.fps ?? 60)
  for (const c of coversAt(coverIndex(covers), t, slack)) {
    const b = drawnBox(c, t, slack)
    const box = b && clip01(b)
    if (!box) continue
    const x0 = Math.max(0, Math.floor(box.x * width))
    const y0 = Math.max(0, Math.floor(box.y * height))
    const x1 = Math.min(width, Math.ceil((box.x + box.w) * width))
    const y1 = Math.min(height, Math.ceil((box.y + box.h) * height))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4
        pixels[i] = DARK[0]
        pixels[i + 1] = DARK[1]
        pixels[i + 2] = DARK[2]
        pixels[i + 3] = 255
      }
    }
  }
}
