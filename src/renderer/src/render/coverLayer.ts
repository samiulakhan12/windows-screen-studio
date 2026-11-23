/**
 * Covers drawn (docs/design/auto-blur.md §8): filled into the screen picture after the crop and the
 * grade, before anything samples it (coverScreen), and again on the output through every sub-frame's
 * camera (drawCoverOutput). The covers come from the scene's project, already in view space (the
 * crop's, §4.8), and are never mapped through the crop again. A project without covers, or a frame
 * with none active, draws exactly as before.
 */
import { coverSlack, drawnBox } from '../../../shared/privacy/coverPath'
import { coverIndex, coversAt } from '../../../shared/privacy/covers'
import type { Cover } from '../../../shared/types'
import type { FrameImage, RenderScene } from './compositor'
import { drawCoverMarks, drawCoverPeek, gradedCoverColour } from './coverGrade'
import { lutFor } from './lutCache'

/** One camera the picture is drawn through: normalised view coordinates to output pixels. */
export interface OutputView {
  toOut(x: number, y: number): { x: number; y: number }
}

const NONE: readonly Cover[] = Object.freeze([])

/** The covers drawn at `t`: those the index finds with the frame's slack, the peeked ones apart. */
function activeCovers(scene: RenderScene, t: number): { fill: readonly Cover[]; any: boolean } {
  const covers = scene.project.covers
  if (!covers?.length) return { fill: NONE, any: false }
  const active = coversAt(coverIndex(covers), t, coverSlack(scene.project.capture?.fps ?? 60))
  if (!active.length) return { fill: NONE, any: false }
  const peek = scene.peek?.ids
  if (!peek) return { fill: active, any: true }
  if (peek === 'all') return { fill: NONE, any: true }
  return { fill: active.filter((c) => !peek.includes(c.id)), any: true }
}

const colourOf = (scene: RenderScene, cover: Cover): string => gradedCoverColour(cover.color, scene.project.grade?.screen, lutFor(scene.project, 'screen'), scene.compare)

const coverCopies = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>()

/** `screen` copied 1:1 into a canvas of this target's own (a picture the compositor does not own is never drawn into). */
function ownCopy(target: CanvasRenderingContext2D, screen: FrameImage): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null
  let canvas = coverCopies.get(target)
  if (!canvas) {
    canvas = document.createElement('canvas')
    coverCopies.set(target, canvas)
  }
  const w = Math.max(1, Math.round(screen.width))
  const h = Math.max(1, Math.round(screen.height))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(screen.image, 0, 0, w, h)
  return { canvas, ctx }
}

/**
 * The screen picture with the covers active at `t` filled in (§8.1). `screen` is the picture as
 * graded (or cropped), `full` the decoded frame. No cover active: `screen` itself, and no canvas is
 * made. A picture the compositor owns (the crop's copy, the grade's canvas) is filled in place; the
 * video element, a VideoFrame or a shared ImageBitmap is copied first. Each box is the cover's drawn
 * box in view space mapped straight to the picture's pixels, rounded outward and clipped to it.
 */
export function coverScreen(target: CanvasRenderingContext2D, screen: FrameImage, full: FrameImage, scene: RenderScene, t: number): FrameImage {
  const { fill } = activeCovers(scene, t)
  if (!fill.length) return screen
  let ctx: CanvasRenderingContext2D | null = null
  let out = screen
  const owned = screen.image !== full.image && typeof HTMLCanvasElement !== 'undefined' && screen.image instanceof HTMLCanvasElement
  if (owned) ctx = (screen.image as HTMLCanvasElement).getContext('2d')
  if (!ctx) {
    const copy = ownCopy(target, screen)
    if (!copy) return screen
    ctx = copy.ctx
    out = { image: copy.canvas, width: copy.canvas.width, height: copy.canvas.height }
  }
  const w = (out.image as HTMLCanvasElement).width || out.width
  const h = (out.image as HTMLCanvasElement).height || out.height
  const slack = coverSlack(scene.project.capture?.fps ?? 60)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  for (const cover of fill) {
    const box = drawnBox(cover, t, slack)
    if (!box) continue
    const x0 = Math.max(0, Math.floor(box.x * w))
    const y0 = Math.max(0, Math.floor(box.y * h))
    const x1 = Math.min(w, Math.ceil((box.x + box.w) * w))
    const y1 = Math.min(h, Math.ceil((box.y + box.h) * h))
    if (x1 <= x0 || y1 <= y0) continue
    ctx.fillStyle = colourOf(scene, cover)
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
  }
  ctx.restore()
  return out
}

/**
 * The covers active at `t` filled again on the output (§8.2), through every sub-frame's camera
 * (`views`): each box's four corners mapped, their bounding box rounded outward and grown by one
 * output pixel, in the same graded colour. Then the preview's outlines (Peek, Show where covers are),
 * which an export's scene never asks for (forOutput). Nothing without an active cover.
 */
export function drawCoverOutput(c: CanvasRenderingContext2D, scene: RenderScene, t: number, views: readonly OutputView[]): void {
  if (scene.alpha === 'overlays') return
  const { fill, any } = activeCovers(scene, t)
  if (!any) return
  const slack = coverSlack(scene.project.capture?.fps ?? 60)
  for (const cover of fill) {
    const box = drawnBox(cover, t, slack)
    if (!box) continue
    c.fillStyle = colourOf(scene, cover)
    for (const view of views) {
      const corners = [view.toOut(box.x, box.y), view.toOut(box.x + box.w, box.y), view.toOut(box.x, box.y + box.h), view.toOut(box.x + box.w, box.y + box.h)]
      const x0 = Math.floor(Math.min(...corners.map((p) => p.x))) - 1
      const y0 = Math.floor(Math.min(...corners.map((p) => p.y))) - 1
      const x1 = Math.ceil(Math.max(...corners.map((p) => p.x))) + 1
      const y1 = Math.ceil(Math.max(...corners.map((p) => p.y))) + 1
      c.fillRect(x0, y0, x1 - x0, y1 - y0)
    }
  }
  if (scene.peek) drawCoverPeek(c, scene, t, views)
  if (scene.coverMarks) drawCoverMarks(c, scene, t, views)
}

/** The scene an output draws: without the preview's Peek and cover outlines (§8.5). The scene itself when it has neither. */
export function forOutput<S extends RenderScene>(scene: S): S {
  if (scene.peek === undefined && scene.coverMarks === undefined) return scene
  const { peek: _peek, coverMarks: _marks, ...rest } = scene
  void _peek
  void _marks
  return rest as S
}
