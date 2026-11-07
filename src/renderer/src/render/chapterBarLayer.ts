/**
 * Drawing the progress bar (docs/design/editing-polish.md §8): between the title cards and the
 * watermark, at the frame's video time, so it keeps moving through pause holds. Each segment has a
 * dark backing and a light unplayed part, the played part in the bar's colour with a thin dark
 * outline (visible on light and dark pages alike); the current segment grows a little; names sit on
 * dark pills in the bundled script fonts, so a Bangla or Arabic name draws the same on every PC.
 */
import { barLabels, barState, CHAPTER_BAR, chapterBarLayout, type BarLayout, type BarSegment } from '../../../shared/render/chapterBar'
import { textAreaWithoutBar } from '../../../shared/render/safeZones'
import { TITLE_FONT } from '../../../shared/render/titleCards'
import { clamp } from '../../../shared/engine/math'
import type { Project } from '../../../shared/types'
import { ensureCaptionFonts, fontGeneration } from './fontLoader'
import type { FrameContext } from './frameContext'
import { CATALOG_FALLBACK } from './titleCardLayer'

type Ctx = CanvasRenderingContext2D

/** The names' font: the title font's Segoe UI, then the bundled script fonts and emoji (§7.6), then the title font. */
export const BAR_FONT = `'Segoe UI Variable Display', 'Segoe UI', ${CATALOG_FALLBACK}, ${TITLE_FONT}`
const WEIGHT = 700

/** Name widths, measured once per text and size (and font generation: widths measured while a font loaded are dropped). */
const widths = new Map<string, number>()

function measureOn(ctx: Ctx, px: number): (text: string) => number {
  return (text) => {
    const key = `${fontGeneration()}|${px}|${text}`
    let w = widths.get(key)
    if (w === undefined) {
      ctx.font = `${WEIGHT} ${px}px ${BAR_FONT}`
      w = ctx.measureText(text).width
      if (widths.size > 2000) widths.clear()
      widths.set(key, w)
    }
    return w
  }
}

/** A bar piece's path: rounded ends on a Floating bar, square on an Edge bar. */
function piece(ctx: Ctx, x: number, y: number, w: number, h: number, round: boolean): void {
  ctx.beginPath()
  if (round) ctx.roundRect(x, y, w, h, Math.max(0, Math.min(h / 2, w / 2)))
  else ctx.rect(x, y, w, h)
}

/** A segment's top and thickness: the current one grows toward the frame's inside, its outer edge staying put. */
function band(layout: BarLayout, thick: number): { y: number; h: number } {
  return layout.edge === 'top' ? { y: layout.y, h: thick } : { y: layout.y + layout.th - thick, h: thick }
}

function drawSegment(ctx: Ctx, layout: BarLayout, s: BarSegment, thick: number, video: number): void {
  const { y, h } = band(layout, thick)
  const w = s.x1 - s.x0
  if (!(w > 0 && h > 0)) return
  piece(ctx, s.x0, y, w, h, layout.round)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)'
  ctx.fill()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
  ctx.fill()
  if (!(video > s.from)) return
  // The played part: linear in video time, never eased.
  const p = s.to > s.from ? clamp((video - s.from) / (s.to - s.from), 0, 1) : 1
  const pw = w * p
  if (!(pw > 0)) return
  piece(ctx, s.x0, y, pw, h, layout.round)
  ctx.fillStyle = layout.color
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)'
  ctx.stroke()
}

/** Draws the progress bar at video time `video`; nothing without chapterBar.show (every project from before). */
export function drawChapterBar(fc: FrameContext, video: number): void {
  if (!fc.project.chapterBar?.show) return
  const { ctx, w, h, project } = fc
  const layout = chapterBarLayout(project, w, h, textAreaWithoutBar(project, w, h, fc.vw, fc.vh, fc.t))
  if (!layout) return
  const state = barState(layout, video, fc.t, project)
  if (state.alpha <= 0.002) return
  ctx.save()
  ctx.globalAlpha = state.alpha
  layout.segments.forEach((s, k) => drawSegment(ctx, layout, s, k === state.current ? layout.th * state.grow : layout.th, video))
  if (layout.labels !== 'none' && state.labelAlpha > 0) drawNames(ctx, fc, project, layout, state, video)
  ctx.restore()
}

function drawNames(ctx: Ctx, fc: FrameContext, project: Project, layout: BarLayout, state: { alpha: number; current: number; labelAlpha: number }, video: number): void {
  // The bundled script fonts load as the editor draws; the export waits for them (editingFontIds).
  ensureCaptionFonts(project)
  const px = layout.labelPx
  const labels = barLabels(layout, state, video, Math.min(fc.w, fc.h), measureOn(ctx, px))
  if (!labels.length) return
  ctx.font = `${WEIGHT} ${px}px ${BAR_FONT}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  for (const l of labels) {
    const a = state.alpha * state.labelAlpha * l.alpha
    if (a <= 0.002) continue
    ctx.globalAlpha = a
    ctx.beginPath()
    ctx.roundRect(l.x, l.y, l.w, l.h, l.h / 2)
    ctx.fillStyle = `rgba(0, 0, 0, ${CHAPTER_BAR.pillAlpha})`
    ctx.fill()
    ctx.direction = l.rtl ? 'rtl' : 'ltr'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(l.text, l.x + l.w / 2, l.y + l.h / 2)
  }
}
