/**
 * Brand fonts (docs/design/brand-kit.md §4.3): which font files a project or the brand kit may
 * hold, how a font file is recognised by its first bytes, and the CSS font stack a text draws
 * with. Pure, so main, the renderer and tests share one rule.
 */
import type { ProjectFont } from '../types'

/** A font in a project folder or the brand kit folder: font-<n>.<ttf|otf|woff2>. */
export const FONT_FILE_RE = /^font-([1-9][0-9]{0,8})\.(ttf|otf|woff2)$/i
/** Ids of fonts (ProjectFont.id), and of the text that names one. */
export const FONT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/
/** Longest font name kept. */
export const FONT_NAME_MAX = 60
/** Largest font file accepted. */
export const FONT_MAX_BYTES = 15 * 1024 * 1024
/** Most fonts a project keeps. */
export const MAX_PROJECT_FONTS = 20
/** What the default font is called in the menus. */
export const DEFAULT_FONT_LABEL = 'Segoe UI'

export type FontType = 'ttf' | 'otf' | 'woff2'
export const FONT_TYPES: readonly FontType[] = ['ttf', 'otf', 'woff2']
const FONT_NAMES: Record<FontType, string> = { ttf: 'a TrueType (.ttf)', otf: 'an OpenType (.otf)', woff2: 'a WOFF2 (.woff2)' }

const ascii = (head: Uint8Array, from: number, to: number): string => String.fromCharCode(...head.subarray(from, to))

/** The font format the first bytes of a file show, or null when it is not a font Flown takes. */
export function fontType(head: Uint8Array): FontType | null {
  if (head.length < 4) return null
  if (head[0] === 0x00 && head[1] === 0x01 && head[2] === 0x00 && head[3] === 0x00) return 'ttf'
  const tag = ascii(head, 0, 4)
  if (tag === 'true') return 'ttf'
  if (tag === 'OTTO') return 'otf'
  if (tag === 'wOF2') return 'woff2'
  return null
}

/** Why a font file with these first bytes and extension is refused, or null when it looks right. */
export function checkFont(head: Uint8Array, ext: string): string | null {
  const type = fontType(head)
  if (!type) return 'This file could not be read as a TTF, OTF or WOFF2 font.'
  // A TrueType-flavoured font is often named .otf; both load the same way.
  const named = ext.toLowerCase()
  if (type === named || (type === 'ttf' && named === 'otf') || (type === 'otf' && named === 'ttf')) return null
  return `This file is named .${named} but holds ${FONT_NAMES[type]} font: rename it to .${type} and add it again.`
}

/** The internal family a font is registered under, so a font named like a system font never replaces it. */
export const fontFamily = (id: string): string => `FlownFont-${id}`

/** A usable font id, or undefined. */
export const readFontId = (v: unknown): string | undefined => (typeof v === 'string' && FONT_ID_RE.test(v) ? v : undefined)

/** The font with id `id` in the project, or null (absent, unknown or not an id). */
export function fontOf(fonts: readonly ProjectFont[] | undefined, id: unknown): ProjectFont | null {
  const key = readFontId(id)
  return key ? (fonts?.find((f) => f.id === key) ?? null) : null
}

/**
 * The CSS font stack text with font `id` draws with: the project font first, then `fallback`
 * (the stack used before brand fonts), which also draws while the font loads or when it is missing.
 */
export function fontStack(fonts: readonly ProjectFont[] | undefined, id: unknown, fallback: string): string {
  const font = fontOf(fonts, id)
  return font ? `"${fontFamily(font.id)}", ${fallback}` : fallback
}

/** A readable font name from a file name: "brand-sans_bold.ttf" -> "brand sans bold". */
export function fontNameFromFile(file: string): string {
  const base = file.replace(/\.[^.]*$/, '').replace(/[-_]+/g, ' ')
  return cleanFontName(base) || 'Font'
}

/** A font name as stored: one line, trimmed, at most FONT_NAME_MAX characters. */
export const cleanFontName = (name: string): string => name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, FONT_NAME_MAX).trim()

let idCounter = 0
export const newFontId = (): string => `f${Date.now().toString(36)}${(idCounter++).toString(36)}`
