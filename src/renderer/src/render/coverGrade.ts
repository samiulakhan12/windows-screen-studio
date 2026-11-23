/**
 * A cover's colour through the screen's grade, and the preview-only outlines (docs/design/auto-blur.md
 * §8.4, §8.5). A cover on a graded recording takes its colour run through the screen's grade and
 * LUT with the CPU grade's maths on one pixel, so it matches its graded background; with Compare on,
 * the ungraded colour. Peek's outlines (2 px) and *Show where covers are* (1 px dashed) are drawn in
 * the accent colour with a black halo outside, only on a scene the player's preview made (forOutput
 * strips both from every output).
 */
import { effectiveGrade, gradePixelsCpu, gradeTable, resolveGrade } from '../../../shared/render/colorGrade'
import type { CubeLut } from '../../../shared/render/cubeLut'
import { coverSlack, drawnBox } from '../../../shared/privacy/coverPath'
import { coverIndex, coversAt } from '../../../shared/privacy/covers'
import type { ColorGrade, Cover } from '../../../shared/types'
import type { RenderScene } from './compositor'
import type { OutputView } from './coverLayer'

/** The `--accent-400` token (src/renderer/src/styles.css): Peek's and the cover marks' outline. */
export const COVER_OUTLINE = '#6b5dfd'
/** The halo outside the outline, so it shows on any frame. */
export const COVER_HALO = '#000000'

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const hex2 = (v: number): string => v.toString(16).padStart(2, '0')

/** Graded colours, per grade object, then LUT, then colour (a grade is a new object when it changes). */
const graded = new WeakMap<ColorGrade, Map<CubeLut | null, Map<string, string>>>()

/**
 * `color` run through the screen's `grade` and `lut` on one pixel (gradePixelsCpu, as the CPU path
 * grades the frame), cached per colour, grade and LUT. Without a grade, a grade that changes
 * nothing, or with Compare on (`compare`): `color` itself.
 */
export function gradedCoverColour(color: string, grade: ColorGrade | undefined, lut: CubeLut | null, compare?: boolean): string {
  if (compare || !grade) return color
  const m = HEX.exec(color)
  if (!m) return color
  let byLut = graded.get(grade)
  if (!byLut) graded.set(grade, (byLut = new Map()))
  let byColour = byLut.get(lut)
  if (!byColour) byLut.set(lut, (byColour = new Map()))
  const hit = byColour.get(color)
  if (hit) return hit
  const g = effectiveGrade(resolveGrade(grade, 'screen'), lut)
  let out = color
  if (g) {
    const px = new Uint8ClampedArray([parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255])
    gradePixelsCpu(px, g, gradeTable(g), lut && g.lutStrength > 0 ? lut : null)
    out = `#${hex2(px[0])}${hex2(px[1])}${hex2(px[2])}`
  }
  if (byColour.size > 256) byColour.clear()
  byColour.set(color, out)
  return out
}

type Box = { x: number; y: number; w: number; h: number }

/** The covers active at `t` with the frame's slack, each with its drawn box. */
function activeBoxes(scene: RenderScene, t: number, only: ((c: Cover) => boolean) | null): Box[] {
  const covers = scene.project.covers
  if (!covers?.length) return []
  const slack = coverSlack(scene.project.capture?.fps ?? 60)
  const out: Box[] = []
  for (const c of coversAt(coverIndex(covers), t, slack)) {
    if (only && !only(c)) continue
    const b = drawnBox(c, t, slack)
    if (b) out.push(b)
  }
  return out
}

/** A box's output rectangle through `view`: the bounding box of its four mapped corners, rounded outward. */
function outRect(view: OutputView, b: Box): Box {
  const corners = [view.toOut(b.x, b.y), view.toOut(b.x + b.w, b.y), view.toOut(b.x, b.y + b.h), view.toOut(b.x + b.w, b.y + b.h)]
  const x0 = Math.floor(Math.min(...corners.map((p) => p.x)))
  const y0 = Math.floor(Math.min(...corners.map((p) => p.y)))
  const x1 = Math.ceil(Math.max(...corners.map((p) => p.x)))
  const y1 = Math.ceil(Math.max(...corners.map((p) => p.y)))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Outlines `boxes` just outside their output rectangles: a `width` px line (dashed when asked) in the accent colour, a 1 px black halo outside it. */
function outline(c: CanvasRenderingContext2D, boxes: readonly Box[], views: readonly OutputView[], width: number, dashed: boolean): void {
  if (!boxes.length || !views.length) return
  // The main camera's view (the first): an outline is a mark, not a cover, and is not motion blurred.
  const view = views[0]
  c.save()
  c.globalAlpha = 1
  c.globalCompositeOperation = 'source-over'
  for (const b of boxes) {
    const r = outRect(view, b)
    c.setLineDash([])
    c.lineWidth = 1
    c.strokeStyle = COVER_HALO
    c.strokeRect(r.x - width - 0.5, r.y - width - 0.5, r.w + 2 * width + 1, r.h + 2 * width + 1)
    c.lineWidth = width
    c.strokeStyle = COVER_OUTLINE
    c.setLineDash(dashed ? [4, 3] : [])
    c.strokeRect(r.x - width / 2, r.y - width / 2, r.w + width, r.h + width)
  }
  c.restore()
}

/** Peeked covers as 2 px accent outlines on the output (the editor's preview only; coverScreen and drawCoverOutput leave them unfilled). */
export function drawCoverPeek(c: CanvasRenderingContext2D, scene: RenderScene, t: number, views: readonly OutputView[]): void {
  const ids = scene.peek?.ids
  if (!ids) return
  outline(c, activeBoxes(scene, t, ids === 'all' ? null : (cover) => ids.includes(cover.id)), views, 2, false)
}

/** *Show where covers are* (§2.1): a 1 px dashed accent outline with a black halo around every active cover (the editor's preview only). */
export function drawCoverMarks(c: CanvasRenderingContext2D, scene: RenderScene, t: number, views: readonly OutputView[]): void {
  if (!scene.coverMarks) return
  outline(c, activeBoxes(scene, t, null), views, 1, true)
}
