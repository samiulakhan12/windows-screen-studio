/**
 * Reading stored image overlays, project fonts and the brand kit's traces on a project
 * (docs/design/brand-kit.md §3): defaults for missing fields, numbers clamped, and entries that
 * cannot be shown rejected. One rule for loading a project (project.ts) and the editor.
 */
import { cleanFontName, FONT_FILE_RE, MAX_PROJECT_FONTS, readFontId } from '../render/fonts'
import { isSticker } from '../render/stickers'
import type { ImageOverlay, ProjectBrand, ProjectFont } from '../types'
import { clamp } from './math'

/** An image overlay file in a project folder: overlay-<n>.<png|jpg|webp|svg|gif>. */
export const OVERLAY_FILE_RE = /^overlay-([1-9][0-9]{0,8})\.(png|jpg|webp|svg|gif)$/i
/** Largest image, and largest SVG, accepted as an overlay. */
export const OVERLAY_MAX_BYTES = 25 * 1024 * 1024
export const OVERLAY_SVG_MAX_BYTES = 2 * 1024 * 1024
/** Most overlays a project keeps. */
export const MAX_OVERLAYS = 200
/** Longest overlay name kept. */
export const OVERLAY_NAME_MAX = 80
/** Shortest overlay kept when a project is read (seconds). */
const MIN_STORED = 0.05

export const OVERLAY_LIMITS = {
  /** Width or height, as a fraction of the frame's shorter side. */
  side: { min: 0.02, max: 2 },
  rotation: { min: -180, max: 180 },
  opacity: { min: 0.05, max: 1 },
  fade: { min: 0, max: 3 },
  /** Centre: a little beyond the frame, so an image can hang off an edge. */
  pos: { min: -0.5, max: 1.5 }
} as const

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const num = (v: unknown, l: { min: number; max: number }, d: number): number => (finite(v) ? clamp(v, l.min, l.max) : d)

/** An overlay name as stored and shown: one line, at most OVERLAY_NAME_MAX characters. */
export const cleanOverlayName = (name: string): string => name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, OVERLAY_NAME_MAX)

/** Angle in -180..180 (an angle of 190 is -170). */
export function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  const a = ((((deg + 180) % 360) + 360) % 360) - 180
  return a === -180 ? 180 : a
}

/**
 * A stored overlay with every field usable, inside a recording of `duration` seconds, or null when
 * it cannot be shown: no times, too short, neither a project image file nor a known sticker.
 */
export function readOverlay(raw: unknown, duration = Infinity): ImageOverlay | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Partial<Record<keyof ImageOverlay, unknown>>
  if (!finite(r.start) || !finite(r.end)) return null
  const start = Math.max(0, r.start)
  const end = Math.min(r.end, duration)
  if (!(end - start >= MIN_STORED)) return null
  const file = typeof r.file === 'string' && OVERLAY_FILE_RE.test(r.file) ? r.file : undefined
  const sticker = !file && isSticker(r.sticker) ? r.sticker : undefined
  if (!file && !sticker) return null
  const L = OVERLAY_LIMITS
  const out: ImageOverlay = {
    id: typeof r.id === 'string' ? r.id : '',
    start,
    end,
    x: num(r.x, L.pos, 0.5),
    y: num(r.y, L.pos, 0.5),
    w: num(r.w, L.side, 0.3),
    h: num(r.h, L.side, 0.3),
    rotation: finite(r.rotation) ? normalizeAngle(r.rotation) : 0,
    opacity: num(r.opacity, L.opacity, 1),
    fadeIn: num(r.fadeIn, L.fade, 0),
    fadeOut: num(r.fadeOut, L.fade, 0)
  }
  if (file) out.file = file
  if (sticker) out.sticker = sticker
  if (typeof r.name === 'string' && cleanOverlayName(r.name)) out.name = cleanOverlayName(r.name)
  return out
}

/** The stored overlays that can be shown, at most MAX_OVERLAYS, with unique ids; undefined when absent. */
export function readOverlays(raw: unknown, duration = Infinity): ImageOverlay[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ImageOverlay[] = []
  for (const item of raw) {
    const o = readOverlay(item, duration)
    if (!o) continue
    if (!o.id || seen.has(o.id)) o.id = `o${out.length}-${seen.size}`
    seen.add(o.id)
    out.push(o)
    if (out.length >= MAX_OVERLAYS) break
  }
  return out
}

/** A stored project font, or null (bad id or file). */
export function readFont(raw: unknown): ProjectFont | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Partial<Record<keyof ProjectFont, unknown>>
  const id = readFontId(r.id)
  if (!id || typeof r.file !== 'string' || !FONT_FILE_RE.test(r.file)) return null
  return { id, name: (typeof r.name === 'string' && cleanFontName(r.name)) || 'Font', file: r.file }
}

/** The stored project fonts, unique by id, at most MAX_PROJECT_FONTS; undefined when absent. */
export function readFonts(raw: unknown): ProjectFont[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return []
  const out: ProjectFont[] = []
  for (const item of raw) {
    const f = readFont(item)
    if (f && !out.some((g) => g.id === f.id)) out.push(f)
    if (out.length >= MAX_PROJECT_FONTS) break
  }
  return out
}

const HEX = /^#[0-9a-f]{6}$/i
/** Most brand colours kept. */
export const MAX_BRAND_COLORS = 6

/** Up to MAX_BRAND_COLORS unique #rrggbb colours, lower case. */
export function readColors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const c of raw) {
    if (typeof c !== 'string' || !HEX.test(c)) continue
    const v = c.toLowerCase()
    if (!out.includes(v)) out.push(v)
    if (out.length >= MAX_BRAND_COLORS) break
  }
  return out
}

/** The brand kit's traces on a stored project, or undefined (absent or not an object). */
export function readBrand(raw: unknown): ProjectBrand | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Partial<Record<keyof ProjectBrand, unknown>>
  const out: ProjectBrand = { colors: readColors(r.colors) }
  const heading = readFontId(r.headingFont)
  const body = readFontId(r.bodyFont)
  if (heading) out.headingFont = heading
  if (body) out.bodyFont = body
  return out
}
