import type { Corner, Project, WatermarkSettings } from '../types'
import type { Rect } from './layout'
import { clamp } from './math'

/** Logo or text stamped on every frame (Project.watermark). */

export const WATERMARK_POSITIONS: WatermarkSettings['position'][] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']
export const WATERMARK_LIMITS = {
  size: { min: 0.02, max: 0.4 },
  opacity: { min: 0.1, max: 1 },
  margin: { min: 0, max: 0.15 }
} as const
/** Longest watermark text. */
export const WATERMARK_TEXT_MAX = 80
/** Files a watermark image may be stored as in a project folder. */
export const WATERMARK_FILE_RE = /^watermark\.(png|jpg|webp|svg)$/i
/** Largest watermark image accepted. */
export const WATERMARK_MAX_BYTES = 20 * 1024 * 1024

/** A good size for each kind: text height is much smaller than a logo's width. */
export const WATERMARK_SIZE: Record<WatermarkSettings['kind'], number> = { image: 0.12, text: 0.035 }

export const DEFAULT_WATERMARK: WatermarkSettings = {
  show: true,
  kind: 'text',
  text: '',
  position: 'bottom-right',
  size: WATERMARK_SIZE.text,
  opacity: 0.85,
  margin: 0.035
}

const num = (v: unknown, l: { min: number; max: number }, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, l.min, l.max) : d)

/** The project's watermark settings with every field valid (defaults for missing ones), or null without any. */
export function watermarkSettings(raw: WatermarkSettings | undefined | null): WatermarkSettings | null {
  if (!raw || typeof raw !== 'object') return null
  const kind = raw.kind === 'image' ? 'image' : 'text'
  const out: WatermarkSettings = {
    show: raw.show !== false,
    kind,
    text: typeof raw.text === 'string' ? raw.text.slice(0, WATERMARK_TEXT_MAX) : '',
    position: WATERMARK_POSITIONS.includes(raw.position) ? raw.position : DEFAULT_WATERMARK.position,
    size: num(raw.size, WATERMARK_LIMITS.size, WATERMARK_SIZE[kind]),
    opacity: num(raw.opacity, WATERMARK_LIMITS.opacity, DEFAULT_WATERMARK.opacity),
    margin: num(raw.margin, WATERMARK_LIMITS.margin, DEFAULT_WATERMARK.margin)
  }
  if (typeof raw.path === 'string' && WATERMARK_FILE_RE.test(raw.path)) out.path = raw.path
  return out
}

/** What to draw: the watermark when it is shown and has something to show, else null. */
export function activeWatermark(project: Pick<Project, 'watermark'>): WatermarkSettings | null {
  const wm = watermarkSettings(project.watermark)
  if (!wm || !wm.show) return null
  if (wm.kind === 'image' ? !wm.path : !wm.text?.trim()) return null
  return wm
}

/**
 * Where the watermark goes in a w x h frame. `aspect` is the width / height of what is drawn
 * (the image, or the measured text). An image is `size` x the shorter side wide; text is that tall.
 */
export function watermarkRect(w: number, h: number, wm: Pick<WatermarkSettings, 'kind' | 'size' | 'position' | 'margin'>, aspect: number): Rect {
  const m = Math.min(w, h)
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  let bw = wm.kind === 'image' ? wm.size * m : wm.size * m * a
  let bh = bw / a
  // Never larger than the frame inside the margins.
  const margin = wm.margin * m
  const fit = Math.min(1, (w - margin * 2) / bw, (h - margin * 2) / bh)
  if (fit > 0 && fit < 1) {
    bw *= fit
    bh *= fit
  }
  if (wm.position === 'center') return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh }
  const corner: Corner = wm.position
  const x = corner.endsWith('left') ? margin : w - margin - bw
  const y = corner.startsWith('top') ? margin : h - margin - bh
  return { x, y, w: bw, h: bh }
}
