/**
 * The brand kit (E-03, docs/design/brand-kit.md): a logo, colours, fonts, an intro and an outro
 * title card and a style preset, saved once in Settings and applied to a project in one step.
 * Pure: the file and its folder live in src/main/brandKit.ts; this module reads a stored kit
 * and applies one to a project.
 */
import { clamp } from '../engine/math'
import { MAX_BRAND_COLORS, readColors } from '../engine/overlayData'
import { keptBounds, outputDuration, outputToSource } from '../engine/timeline'
import { cleanTitle } from '../engine/titleData'
import { DEFAULT_WATERMARK, WATERMARK_LIMITS, WATERMARK_POSITIONS } from '../engine/watermark'
import { captionsOf } from '../captions/settings'
import { cleanFontName, FONT_FILE_RE, MAX_PROJECT_FONTS, newFontId, readFontId } from '../render/fonts'
import type { Corner, Project, ProjectFont, TitleCard, TitleCardStyle, WatermarkSettings } from '../types'
import { applyPreset, presetName, sanitizePresetLook, type PresetLook } from './stylePresets'
import { createTitleCard } from './titles'

/** The kit's logo file in its folder: logo-<n>.<png|jpg|webp|svg> (a new name for every pick). */
export const BRAND_LOGO_FILE_RE = /^logo-([1-9][0-9]{0,8})\.(png|jpg|webp|svg)$/i
/** Most fonts a kit holds. */
export const MAX_BRAND_FONTS = 6
export { MAX_BRAND_COLORS }
/** Intro and outro lengths, output seconds. */
export const BRAND_CARD_LENGTH = { min: 1, max: 10, default: 3 }
/** An intro or outro shorter than this (a very short video) is left out. */
export const MIN_BRAND_CARD = 0.5

export interface BrandLogo {
  file: string
  position: Corner | 'center'
  /** As WatermarkSettings: width as a fraction of the shorter side, opacity, distance from the edge. */
  size: number
  opacity: number
  margin: number
}

export interface BrandCard {
  title: string
  subtitle?: string
  style: TitleCardStyle
  background: TitleCard['background']
  /** Output seconds. */
  length: number
}

export interface BrandKit {
  logo?: BrandLogo
  colors: string[]
  /** Font files in the kit's folder (font-<n>.<ext>). */
  fonts: ProjectFont[]
  /** Kit font ids. */
  headingFont?: string
  bodyFont?: string
  intro?: BrandCard
  outro?: BrandCard
  /** A style preset, its look copied in (deleting the preset later does not change the kit). */
  preset?: { name: string; look: PresetLook }
  /** New recordings start with the kit applied. */
  autoApply: boolean
}

export const EMPTY_BRAND_KIT: BrandKit = { colors: [], fonts: [], autoApply: false }

export const DEFAULT_BRAND_LOGO: Omit<BrandLogo, 'file'> = { position: 'bottom-right', size: 0.12, opacity: 0.9, margin: DEFAULT_WATERMARK.margin }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown, l: { min: number; max: number }, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, l.min, l.max) : d)
const STYLES: TitleCardStyle[] = ['centered', 'big', 'lower-third']
const BACKGROUNDS: TitleCard['background'][] = ['solid', 'blur', 'style']

function readLogo(v: unknown): BrandLogo | undefined {
  if (!isObject(v) || typeof v.file !== 'string' || !BRAND_LOGO_FILE_RE.test(v.file)) return undefined
  const d = DEFAULT_BRAND_LOGO
  return {
    file: v.file,
    position: WATERMARK_POSITIONS.includes(v.position as BrandLogo['position']) ? (v.position as BrandLogo['position']) : d.position,
    size: num(v.size, WATERMARK_LIMITS.size, d.size),
    opacity: num(v.opacity, WATERMARK_LIMITS.opacity, d.opacity),
    margin: num(v.margin, WATERMARK_LIMITS.margin, d.margin)
  }
}

function readCard(v: unknown): BrandCard | undefined {
  if (!isObject(v)) return undefined
  const title = typeof v.title === 'string' ? cleanTitle(v.title) : ''
  const subtitle = typeof v.subtitle === 'string' ? cleanTitle(v.subtitle) : ''
  if (!title.trim() && !subtitle.trim()) return undefined
  const card: BrandCard = {
    title,
    style: STYLES.includes(v.style as TitleCardStyle) ? (v.style as TitleCardStyle) : 'centered',
    background: BACKGROUNDS.includes(v.background as TitleCard['background']) ? (v.background as TitleCard['background']) : 'solid',
    length: Math.round(num(v.length, BRAND_CARD_LENGTH, BRAND_CARD_LENGTH.default) * 10) / 10
  }
  if (subtitle.trim()) card.subtitle = subtitle
  return card
}

function readKitFonts(v: unknown): ProjectFont[] {
  if (!Array.isArray(v)) return []
  const out: ProjectFont[] = []
  for (const f of v) {
    if (!isObject(f)) continue
    const id = readFontId(f.id)
    if (!id || typeof f.file !== 'string' || !FONT_FILE_RE.test(f.file) || out.some((g) => g.id === id || g.file === f.file)) continue
    out.push({ id, name: (typeof f.name === 'string' && cleanFontName(f.name)) || 'Font', file: f.file })
    if (out.length >= MAX_BRAND_FONTS) break
  }
  return out
}

/** A stored kit with every field usable; anything unreadable is left out. Never throws. */
export function sanitizeBrandKit(raw: unknown): BrandKit {
  if (!isObject(raw)) return { ...EMPTY_BRAND_KIT, colors: [], fonts: [] }
  const fonts = readKitFonts(raw.fonts)
  const kit: BrandKit = { colors: readColors(raw.colors), fonts, autoApply: raw.autoApply === true }
  const logo = readLogo(raw.logo)
  if (logo) kit.logo = logo
  const heading = readFontId(raw.headingFont)
  const body = readFontId(raw.bodyFont)
  if (heading && fonts.some((f) => f.id === heading)) kit.headingFont = heading
  if (body && fonts.some((f) => f.id === body)) kit.bodyFont = body
  const intro = readCard(raw.intro)
  const outro = readCard(raw.outro)
  if (intro) kit.intro = intro
  if (outro) kit.outro = outro
  if (isObject(raw.preset)) {
    const name = presetName(raw.preset.name)
    const look = sanitizePresetLook(raw.preset.look)
    if (name && look) kit.preset = { name, look }
  }
  return kit
}

/**
 * The kit Settings shows after saving `edited`: the stored one, except that a card the user is still
 * editing stays while its title and subtitle are blank (the stored kit leaves such a card out until it
 * has text), so clearing a title to retype it keeps the card's style, background and length.
 */
export function shownBrandKit(stored: BrandKit, edited: BrandKit): BrandKit {
  const out = { ...stored }
  for (const which of ['intro', 'outro'] as const) if (!out[which] && edited[which]) out[which] = edited[which]
  return out
}

/** True when applying the kit would change nothing (nothing set up yet). */
export const brandKitIsEmpty = (kit: BrandKit): boolean => !kit.logo && !kit.colors.length && !kit.fonts.length && !kit.intro && !kit.outro && !kit.preset

/** The kit's files as copied into a project: the logo's project file, and each kit font's. */
export interface BrandFiles {
  logo?: string
  /** Kit font id -> project font file. */
  fonts: Record<string, string>
}

/** Source times of an intro (`end` false) or outro card `length` output seconds long, or null when the video is too short. */
export function brandCardTimes(clips: Project['clips'], length: number, end: boolean): { start: number; end: number } | null {
  const total = outputDuration(clips)
  const len = Math.min(length, total / 3)
  if (!(len >= MIN_BRAND_CARD)) return null
  const kept = keptBounds(clips)
  if (!end) return { start: kept.start, end: outputToSource(clips, len).time }
  return { start: outputToSource(clips, total - len).time, end: kept.end }
}

/**
 * Project fonts after adding the kit's: the same file reuses its font, others get an id of their
 * own, up to MAX_PROJECT_FONTS (a project keeps no more when it is opened again). Returns kit id ->
 * project id, and the names of the kit fonts left out for the limit (they get no id, so nothing uses them).
 */
function mergeFonts(project: Project, kit: BrandKit, files: BrandFiles): { fonts: ProjectFont[]; ids: Record<string, string>; full: string[] } {
  const fonts = [...(project.fonts ?? [])]
  const ids: Record<string, string> = {}
  const full: string[] = []
  for (const f of kit.fonts) {
    const file = files.fonts[f.id]
    if (!file || !FONT_FILE_RE.test(file)) continue
    const same = fonts.find((g) => g.file === file)
    if (same) {
      ids[f.id] = same.id
      continue
    }
    if (fonts.length >= MAX_PROJECT_FONTS) {
      full.push(f.name)
      continue
    }
    const id = fonts.some((g) => g.id === f.id) ? newFontId() : f.id
    fonts.push({ id, name: f.name, file })
    ids[f.id] = id
  }
  return { fonts, ids, full }
}

/** Names of the kit's fonts that applying it to `project` leaves out, because the project already has MAX_PROJECT_FONTS fonts. */
export const brandFontsLeftOut = (project: Project, kit: BrandKit, files: BrandFiles): string[] => mergeFonts(project, kit, files).full

/**
 * The project with the brand kit applied (docs/design/brand-kit.md §2 decision 20), in this order:
 * the style preset; the logo as the watermark; the kit's fonts added, captions and the text and
 * title cards that use the default font switched to the body and heading fonts (a font chosen by
 * hand is kept); the kit's earlier intro and outro replaced by the current ones; the colours and
 * fonts kept on the project for the pickers. Parts whose files were not copied (`files`) are left
 * out. Returns `project` itself when nothing changes.
 */
export function applyBrandKit(project: Project, kit: BrandKit, files: BrandFiles): Project {
  if (brandKitIsEmpty(kit)) return project
  let p: Project = kit.preset ? applyPreset(project, kit.preset.look) : { ...project }
  if (kit.logo && files.logo) {
    const wm: WatermarkSettings = { show: true, kind: 'image', path: files.logo, position: kit.logo.position, size: kit.logo.size, opacity: kit.logo.opacity, margin: kit.logo.margin }
    p.watermark = wm
  }
  const { fonts, ids } = mergeFonts(p, kit, files)
  if (fonts.length) p.fonts = fonts
  const heading = kit.headingFont ? ids[kit.headingFont] : undefined
  const body = kit.bodyFont ? ids[kit.bodyFont] : undefined
  if (body) {
    p.captions = { ...captionsOf(p), font: body }
    p.annotations = p.annotations.map((a) => (a.font ? a : { ...a, font: body }))
  }
  const headingOrBody = heading ?? body
  const others = (p.titles ?? []).filter((c) => !c.brand)
  const titles: TitleCard[] = headingOrBody ? others.map((c) => (c.font ? c : { ...c, font: headingOrBody })) : others
  const color = kit.colors[0]
  for (const which of ['intro', 'outro'] as const) {
    const card = kit[which]
    if (!card) continue
    const times = brandCardTimes(p.clips, card.length, which === 'outro')
    if (!times) continue
    const made = createTitleCard(times.start, p.duration, { ...times, title: card.title, style: card.style, background: card.background, brand: which })
    if (card.subtitle) made.subtitle = card.subtitle
    if (color) made.color = color
    if (headingOrBody) made.font = headingOrBody
    titles.push(made)
  }
  if (titles.length || p.titles) p.titles = titles
  p.brand = { colors: kit.colors.slice(0, MAX_BRAND_COLORS), ...(heading ? { headingFont: heading } : {}), ...(body ? { bodyFont: body } : {}) }
  return p
}
