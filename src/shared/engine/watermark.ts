import type { Corner, Project, WatermarkSettings } from '../types'
import type { Rect } from './layout'
import { clamp } from './math'
import { nextPickFile, pickNumber, stalePickFiles, type PickedFiles } from './picks'

/** Logo or text stamped on every frame (Project.watermark). */

export const WATERMARK_POSITIONS: WatermarkSettings['position'][] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']
export const WATERMARK_LIMITS = {
  size: { min: 0.02, max: 0.4 },
  opacity: { min: 0.1, max: 1 },
  margin: { min: 0, max: 0.15 }
} as const
/** Longest watermark text. */
export const WATERMARK_TEXT_MAX = 80
/**
 * Files a watermark image may be stored as in a project folder: watermark.<ext>, or
 * watermark-<n>.<ext> for the n-th logo picked. Each pick gets a new name, so a pick never
 * overwrites the logo in use (undo can go back to it, and an unreadable pick changes nothing).
 */
export const WATERMARK_FILE_RE = /^watermark(-[1-9][0-9]{0,8})?\.(png|jpg|webp|svg)$/i
/** Largest watermark image accepted. */
export const WATERMARK_MAX_BYTES = 20 * 1024 * 1024
/** How many of the latest logo picks a project folder keeps (besides the one its saved project uses). */
export const WATERMARK_KEEP_PICKS = 5
const LOGO_PICKS: PickedFiles = { base: 'watermark', re: WATERMARK_FILE_RE, keep: WATERMARK_KEEP_PICKS }

/** The pick number of watermark file `name` (0 for watermark.<ext>), or -1 when it is not one. */
export const watermarkPickNumber = (name: string): number => pickNumber(LOGO_PICKS, name)

/** The file name of a new logo pick with extension `ext`, after the files already in the folder. */
export const nextWatermarkFile = (existing: readonly string[], ext: string): string => nextPickFile(LOGO_PICKS, existing, ext)

/**
 * Watermark files in a folder that can go after a new pick: all but the newest
 * WATERMARK_KEEP_PICKS picks and the files in `keep` (the new pick, the saved project's logo).
 */
export const staleWatermarkFiles = (existing: readonly string[], keep: ReadonlySet<string>): string[] => stalePickFiles(LOGO_PICKS, existing, keep)

/** watermark-<n>.<ext> -> watermark.<ext>: the name a saved look keeps its logo under. */
export function plainWatermarkFile(name: string): string {
  return name.replace(/^watermark-[0-9]+\./i, 'watermark.')
}

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
 * In a text area (docs/design/vertical-video.md §6.3) a corner is the area's, the margin applied
 * within it, and the logo is never larger than the area; the centre stays the frame's.
 */
export function watermarkRect(
  w: number,
  h: number,
  wm: Pick<WatermarkSettings, 'kind' | 'size' | 'position' | 'margin'>,
  aspect: number,
  /** The text area (render/safeZones.ts textArea, output px) the corners keep to; absent or null: the whole frame, as always. */
  area?: Rect | null
): Rect {
  const m = Math.min(w, h)
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  let bw = wm.kind === 'image' ? wm.size * m : wm.size * m * a
  let bh = bw / a
  // Never larger than the frame (in a corner of a text area, the area) inside the margins.
  const margin = wm.margin * m
  const box = area && wm.position !== 'center' ? area : { x: 0, y: 0, w, h }
  const fit = Math.min(1, (box.w - margin * 2) / bw, (box.h - margin * 2) / bh)
  if (fit > 0 && fit < 1) {
    bw *= fit
    bh *= fit
  }
  if (wm.position === 'center') return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh }
  const corner: Corner = wm.position
  const x = corner.endsWith('left') ? box.x + margin : box.x + box.w - margin - bw
  const y = corner.startsWith('top') ? box.y + margin : box.y + box.h - margin - bh
  return { x, y, w: bw, h: bh }
}
