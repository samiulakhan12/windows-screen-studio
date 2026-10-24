/**
 * The camera's settings and layout segments: defaults for the fields older projects lack (read
 * time, so an old project draws exactly as before), and sanitising of stored values (a
 * hand-edited or damaged project.json still opens and draws).
 */
import type { CameraLayout, Corner, LayoutSegment, WebcamSettings } from '../types'
import { clamp } from './math'

export const CAMERA_LAYOUTS: CameraLayout[] = ['default', 'camera-only', 'screen-only', 'side-by-side', 'camera-large']
export const WEBCAM_SHAPES: WebcamSettings['shape'][] = ['circle', 'rounded', 'square']
const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

/** The ring every camera had before the border could be changed. */
export const DEFAULT_WEBCAM_BORDER: NonNullable<WebcamSettings['border']> = { width: 3, color: 'rgba(255,255,255,0.9)' }
/** Shadow strength that draws the drop shadow every camera had before it could be changed. */
export const DEFAULT_WEBCAM_SHADOW = 0.6

export const WEBCAM_LIMITS = {
  borderWidth: { min: 0, max: 16 },
  shadow: { min: 0, max: 1 },
  backgroundBlur: { min: 0, max: 1 },
  zoom: { min: 1, max: 3 }
} as const

/** Shortest layout segment (seconds). */
export const MIN_LAYOUT_LENGTH = 0.2

/** The camera look with every optional field filled in. */
export interface WebcamLook {
  border: { width: number; color: string }
  mirror: boolean
  shadow: number
  backgroundBlur: number
  zoom: number
  cropX: number
  cropY: number
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const HEX = /^#[0-9a-f]{6}$/i
const RGB = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/i

/** A colour a camera border may have: #rrggbb, or rgb()/rgba() (the original ring is translucent white). */
export const isBorderColor = (v: unknown): v is string => typeof v === 'string' && (HEX.test(v) || RGB.test(v))

/** How the camera is drawn: the stored settings, with the original look for anything not set. */
export function webcamLook(w: WebcamSettings): WebcamLook {
  return {
    border: w.border && finite(w.border.width) && isBorderColor(w.border.color) ? w.border : DEFAULT_WEBCAM_BORDER,
    mirror: w.mirror ?? true,
    shadow: finite(w.shadow) ? clamp(w.shadow, 0, 1) : DEFAULT_WEBCAM_SHADOW,
    backgroundBlur: finite(w.backgroundBlur) ? clamp(w.backgroundBlur, 0, 1) : 0,
    zoom: finite(w.zoom) ? clamp(w.zoom, 1, 3) : 1,
    cropX: finite(w.cropX) ? clamp(w.cropX, 0, 1) : 0.5,
    cropY: finite(w.cropY) ? clamp(w.cropY, 0, 1) : 0.5
  }
}

/**
 * Stored camera settings, sanitised: required fields get their defaults when missing or invalid;
 * optional fields are kept only when valid (clamped), and never added, so an older project keeps
 * drawing exactly as before.
 */
export function readWebcam(raw: unknown, hasWebcam: boolean): WebcamSettings {
  const w = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: WebcamSettings = {
    show: typeof w.show === 'boolean' ? w.show : hasWebcam,
    corner: CORNERS.includes(w.corner as Corner) ? (w.corner as Corner) : 'bottom-right',
    size: finite(w.size) ? clamp(w.size, 0.05, 1) : 0.24,
    shape: WEBCAM_SHAPES.includes(w.shape as WebcamSettings['shape']) ? (w.shape as WebcamSettings['shape']) : 'circle'
  }
  Object.assign(out, readWebcamLook(w))
  if (finite(w.zoom)) out.zoom = clamp(w.zoom, 1, 3)
  if (finite(w.cropX)) out.cropX = clamp(w.cropX, 0, 1)
  if (finite(w.cropY)) out.cropY = clamp(w.cropY, 0, 1)
  return out
}

/**
 * The valid look fields of stored camera settings (border, mirror, shadow, background blur),
 * clamped; missing or invalid ones are left out. A saved default look carries these, but not
 * the framing (zoom and crop), which belongs to one recording.
 */
export function readWebcamLook(w: Record<string, unknown>): Pick<WebcamSettings, 'border' | 'mirror' | 'shadow' | 'backgroundBlur'> {
  const out: Pick<WebcamSettings, 'border' | 'mirror' | 'shadow' | 'backgroundBlur'> = {}
  const b = w.border as Record<string, unknown> | undefined
  if (b && typeof b === 'object' && finite(b.width) && isBorderColor(b.color)) {
    out.border = { width: clamp(b.width, WEBCAM_LIMITS.borderWidth.min, WEBCAM_LIMITS.borderWidth.max), color: b.color }
  }
  if (typeof w.mirror === 'boolean') out.mirror = w.mirror
  if (finite(w.shadow)) out.shadow = clamp(w.shadow, 0, 1)
  if (finite(w.backgroundBlur)) out.backgroundBlur = clamp(w.backgroundBlur, 0, 1)
  return out
}

/**
 * Stored layout segments, sanitised: entries that are not objects, have no (or a repeated) id,
 * an unknown layout or unusable times are dropped; the rest are clamped to the recording,
 * sorted, and trimmed so none overlaps the one before it (one layout at a time).
 */
export function readLayouts(list: unknown, duration: number): LayoutSegment[] {
  if (!Array.isArray(list)) return []
  const ids = new Set<string>()
  const items: LayoutSegment[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const s = raw as Partial<LayoutSegment>
    if (typeof s.id !== 'string' || !s.id || ids.has(s.id)) continue
    if (!CAMERA_LAYOUTS.includes(s.layout as CameraLayout) || !finite(s.start) || !finite(s.end)) continue
    const start = clamp(s.start, 0, duration)
    const end = clamp(s.end, 0, duration)
    if (end - start < 0.05) continue
    ids.add(s.id)
    items.push({ id: s.id, start, end, layout: s.layout as CameraLayout })
  }
  items.sort((a, b) => a.start - b.start)
  const out: LayoutSegment[] = []
  for (const s of items) {
    const prev = out[out.length - 1]
    const start = prev ? Math.max(s.start, prev.end) : s.start
    if (s.end - start < 0.05) continue
    out.push(start === s.start ? s : { ...s, start })
  }
  return out
}
