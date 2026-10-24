import { cardLook } from '../engine/cardStyle'
import { frameOf } from '../engine/deviceFrames'
import { zoomSettingsOf } from '../engine/zoom'
import { cursorLook } from '../render/cursorFx'
import type { CursorSettings, Project, StyleSettings } from '../types'
import { sanitizeCursorLook, sanitizeStyleLook, sanitizeZoomStyle, type ZoomStyleLook } from './styleDefaults'

/**
 * Named looks ("Style presets"): a background, the card (padding, corners, shadow, border,
 * device frame), a cursor look and the zoom style, applied to a project in one step. Built-in
 * presets ship with the app; the user's own are stored with window.api.setPref('stylePresets').
 * Pure: the Style panel does the storing.
 */

export type PresetStyle = Partial<Pick<StyleSettings, 'background' | 'padding' | 'cornerRadius' | 'shadow' | 'shadowStyle' | 'shadowColor' | 'border' | 'frame'>>
export type PresetCursor = Partial<Pick<CursorSettings, 'size' | 'style' | 'highlight' | 'clickStyle' | 'clickColor'>>

export interface PresetLook {
  style: PresetStyle
  cursor: PresetCursor
  zoom: ZoomStyleLook
}

export interface StylePreset {
  id: string
  name: string
  look: PresetLook
}

/** Longest preset name, and how many presets of your own are kept. */
export const PRESET_NAME_MAX = 40
export const MAX_USER_PRESETS = 50

const STYLE_KEYS = ['background', 'padding', 'cornerRadius', 'shadow', 'shadowStyle', 'shadowColor', 'border', 'frame'] as const
const CURSOR_KEYS = ['size', 'style', 'highlight', 'clickStyle', 'clickColor'] as const

const look = (style: PresetStyle, cursor: PresetCursor, zoom: ZoomStyleLook): PresetLook => ({ style, cursor, zoom })
const NO_BORDER = { width: 0, color: '#ffffff', glass: false }
const NO_FRAME = { kind: 'none', theme: 'light' } as const
const noHighlight = { enabled: false, color: '#facc15', size: 1, opacity: 0.35 }

export const BUILT_IN_PRESETS: StylePreset[] = [
  {
    id: 'studio',
    name: 'Studio',
    look: look(
      { background: { type: 'wallpaper', id: 'violet-mesh' }, padding: 0.08, cornerRadius: 16, shadow: 0.65, shadowStyle: 'soft', border: NO_BORDER, frame: NO_FRAME },
      { size: 1.5, style: 'mac', highlight: noHighlight, clickStyle: 'ripple', clickColor: '#ffffff' },
      { defaultScale: 2, easing: 'smooth', transition: 0.7 }
    )
  },
  {
    id: 'minimal',
    name: 'Minimal',
    look: look(
      { background: { type: 'color', color: '#f4f4f5' }, padding: 0.06, cornerRadius: 12, shadow: 0.35, shadowStyle: 'soft', border: { width: 1, color: '#e4e4e7', glass: false }, frame: NO_FRAME },
      { size: 1.3, style: 'windows', highlight: noHighlight, clickStyle: 'ring', clickColor: '#111827' },
      { defaultScale: 1.8, easing: 'smooth', transition: 0.8 }
    )
  },
  {
    id: 'midnight-browser',
    name: 'Midnight browser',
    look: look(
      { background: { type: 'wallpaper', id: 'midnight-glow' }, padding: 0.08, cornerRadius: 12, shadow: 0.7, shadowStyle: 'soft', border: NO_BORDER, frame: { kind: 'browser', theme: 'dark' } },
      { size: 1.4, style: 'mac', highlight: noHighlight, clickStyle: 'ripple', clickColor: '#a78bfa' },
      { defaultScale: 2, easing: 'snappy', transition: 0.55 }
    )
  },
  {
    id: 'neon',
    name: 'Neon glow',
    look: look(
      { background: { type: 'color', color: '#0b0b14' }, padding: 0.1, cornerRadius: 18, shadow: 0.8, shadowStyle: 'glow', shadowColor: '#8b5cf6', border: { width: 2, color: '#a78bfa', glass: false }, frame: NO_FRAME },
      { size: 1.5, style: 'white', highlight: { enabled: true, color: '#8b5cf6', size: 1.2, opacity: 0.4 }, clickStyle: 'ring', clickColor: '#a78bfa' },
      { defaultScale: 2.2, easing: 'bouncy', transition: 0.6 }
    )
  },
  {
    id: 'pop',
    name: 'Pop',
    look: look(
      { background: { type: 'color', color: '#fde68a' }, padding: 0.08, cornerRadius: 10, shadow: 0.6, shadowStyle: 'hard', shadowColor: '#111827', border: { width: 3, color: '#111827', glass: false }, frame: NO_FRAME },
      { size: 1.6, style: 'black', highlight: noHighlight, clickStyle: 'pulse', clickColor: '#f472b6' },
      { defaultScale: 1.75, easing: 'snappy', transition: 0.5 }
    )
  },
  {
    id: 'showcase',
    name: 'Laptop showcase',
    look: look(
      { background: { type: 'wallpaper', id: 'dunes' }, padding: 0.1, cornerRadius: 14, shadow: 0.55, shadowStyle: 'soft', border: NO_BORDER, frame: { kind: 'laptop', theme: 'light' } },
      { size: 1.4, style: 'mac', highlight: noHighlight, clickStyle: 'ripple', clickColor: '#ffffff' },
      { defaultScale: 1.6, easing: 'smooth', transition: 1 }
    )
  },
  {
    id: 'frosted',
    name: 'Frosted glass',
    look: look(
      { background: { type: 'wallpaper', id: 'candy-pop', blur: 0.5 }, padding: 0.09, cornerRadius: 20, shadow: 0.5, shadowStyle: 'soft', border: { width: 10, color: '#ffffff', glass: true }, frame: NO_FRAME },
      { size: 1.5, style: 'mac', highlight: noHighlight, clickStyle: 'ripple', clickColor: '#ffffff' },
      { defaultScale: 2, easing: 'smooth', transition: 0.7 }
    )
  },
  {
    id: 'flow',
    name: 'Flow',
    look: look(
      { background: { type: 'animated', preset: 'aurora', speed: 1 }, padding: 0.07, cornerRadius: 14, shadow: 0.6, shadowStyle: 'soft', border: NO_BORDER, frame: NO_FRAME },
      { size: 1.4, style: 'auto', highlight: noHighlight, clickStyle: 'ripple', clickColor: '#ffffff' },
      { defaultScale: 2, easing: 'smooth', transition: 0.7 }
    )
  }
]

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {}
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k]
  return out
}

/**
 * The project's current look as a preset. Image backgrounds (the file lives in this project)
 * and a custom cursor image are left out; applying the preset then keeps the project's own.
 */
export function presetLookOf(project: Project): PresetLook {
  const style = pick(project.style, STYLE_KEYS)
  if (style.background?.type === 'image') delete style.background
  const cursor = pick(project.cursor, CURSOR_KEYS)
  if (cursor.style === 'custom') delete cursor.style
  const z = zoomSettingsOf(project)
  return sanitizePresetLook({ style, cursor, zoom: { defaultScale: z.defaultScale, easing: z.easing, transition: z.transition } }) ?? { style: {}, cursor: {}, zoom: {} }
}

/**
 * Returns `project` with the preset's look. Only what the preset sets changes: the aspect
 * ratio, cursor visibility, a custom cursor image and every zoom's own settings are kept.
 */
export function applyPreset(project: Project, preset: PresetLook): Project {
  const lookIn = sanitizePresetLook(preset)
  if (!lookIn) return project
  const style: StyleSettings = { ...project.style, ...lookIn.style }
  const cursor: CursorSettings = { ...project.cursor, ...lookIn.cursor }
  const out: Project = { ...project, style, cursor }
  if (Object.keys(lookIn.zoom).length) out.zoomSettings = { ...zoomSettingsOf(project), ...lookIn.zoom }
  return out
}

/** What a look shows, with absent fields resolved to what renders (no frame, no border, soft shadow …). */
function canonical(project: Project): string {
  const s = project.style
  const card = cardLook(s)
  const c = cursorLook(project.cursor)
  const z = zoomSettingsOf(project)
  const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v)
  return JSON.stringify({
    background: s.background,
    padding: s.padding,
    cornerRadius: s.cornerRadius,
    shadow: s.shadow,
    shadowStyle: card.shadowStyle,
    shadowColor: card.shadowStyle === 'soft' ? null : lower(card.shadowColor),
    border: card.border && { ...card.border, color: lower(card.border.color) },
    frame: frameOf(s),
    cursor: [project.cursor.size, c.style, { ...c.highlight, color: lower(c.highlight.color) }, c.clickStyle, lower(c.clickColor)],
    zoom: [z.defaultScale, z.easing, z.transition]
  })
}

/** True when the project already looks like `preset`: applying it would change nothing visible. */
export function presetMatches(project: Project, preset: PresetLook): boolean {
  const applied = applyPreset(project, preset)
  return applied !== project && canonical(applied) === canonical(project)
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A preset look with every field validated (same rules as saved defaults); null when nothing is left. */
export function sanitizePresetLook(raw: unknown): PresetLook | null {
  if (!isObject(raw)) return null
  const style = pick(sanitizeStyleLook(isObject(raw.style) ? raw.style : {}), STYLE_KEYS)
  const cursor = pick(sanitizeCursorLook(isObject(raw.cursor) ? raw.cursor : {}), CURSOR_KEYS)
  const zoom = sanitizeZoomStyle(raw.zoom)
  if (!Object.keys(style).length && !Object.keys(cursor).length && !Object.keys(zoom).length) return null
  return { style, cursor, zoom }
}

/** A usable preset name (trimmed, at most PRESET_NAME_MAX characters), or null. */
export function presetName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX).trim()
  return name || null
}

/**
 * The user's presets read back from the preferences file: anything malformed (not a list,
 * entries without an id, a name or a usable look, duplicate ids) is skipped, not fatal.
 */
export function parseUserPresets(raw: unknown): StylePreset[] {
  if (!Array.isArray(raw)) return []
  const out: StylePreset[] = []
  const ids = new Set<string>()
  for (const entry of raw) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !/^[\w-]{1,64}$/.test(entry.id) || ids.has(entry.id)) continue
    const name = presetName(entry.name)
    const l = sanitizePresetLook(entry.look)
    if (!name || !l) continue
    ids.add(entry.id)
    out.push({ id: entry.id, name, look: l })
    if (out.length >= MAX_USER_PRESETS) break
  }
  return out
}

/** `name`, or "name (2)", "name (3)" … when another preset already has it. */
export function uniqueName(list: StylePreset[], name: string, exceptId?: string): string {
  const taken = new Set(list.filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`
    const candidate = `${name.slice(0, PRESET_NAME_MAX - suffix.length)}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

let idCounter = 0
export const newPresetId = (): string => `u${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** Adds a preset (newest first); throws with a readable message when the name or look is unusable or the list is full. */
export function addUserPreset(list: StylePreset[], rawName: unknown, lookIn: PresetLook, id = newPresetId()): { list: StylePreset[]; preset: StylePreset } {
  const name = presetName(rawName)
  if (!name) throw new Error('Give the preset a name')
  const l = sanitizePresetLook(lookIn)
  if (!l) throw new Error('This look cannot be saved as a preset')
  if (list.length >= MAX_USER_PRESETS) throw new Error(`You can keep up to ${MAX_USER_PRESETS} presets: delete one first`)
  const preset = { id, name: uniqueName(list, name), look: l }
  return { list: [preset, ...list], preset }
}

export function renameUserPreset(list: StylePreset[], id: string, rawName: unknown): StylePreset[] {
  const name = presetName(rawName)
  if (!name) throw new Error('Give the preset a name')
  return list.map((p) => (p.id === id ? { ...p, name: uniqueName(list, name, id) } : p))
}

export const deleteUserPreset = (list: StylePreset[], id: string): StylePreset[] => list.filter((p) => p.id !== id)
