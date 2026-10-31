/**
 * Editing a Captions Studio look (docs/design/captions-studio.md §5.7, §5.8): picking a tile, the
 * Studio twin of a legacy look, edits that set `picked`, the size shown in tall frames, line
 * lengths and speaker names. Pure: each function gives the settings of one undo step.
 */
import { isTall } from '../engine/reframeData'
import type { CaptionPreset, CaptionSettings, CaptionStudio } from '../types'
import { luminance } from './colors'
import { captionLook, withPreset } from './settings'
import { STUDIO_LIMITS } from './studioData'
import { LINE_LENGTHS, studioPreset } from './studioPresets'

/** Legacy looks' own numbers for their twins (§5.8 table). */
const TWIN: Record<CaptionPreset, { weight: number; lineHeight: number; upper: boolean; spoken: CaptionStudio['spoken'] }> = {
  clean: { weight: 600, lineHeight: 1.28, upper: false, spoken: 'none' },
  bold: { weight: 800, lineHeight: 1.18, upper: true, spoken: 'color' },
  boxed: { weight: 600, lineHeight: 1.42, upper: false, spoken: 'none' },
  karaoke: { weight: 700, lineHeight: 1.42, upper: false, spoken: 'pill' },
  minimal: { weight: 500, lineHeight: 1.26, upper: false, spoken: 'none' }
}

/**
 * The Studio look that draws a legacy look the same way (§5.8), with `legacyAnchor`: today's font
 * (or the brand font in `captions.font`), size, weight, case and line height; the text colour and
 * the highlight colour; the look's outline or the background's, its shadow or its box (dark text
 * gets a light outline and box, as today); phrases on `maxLines` lines without a character limit
 * at today's anchors; a fade in and out. It does not keep clear of the action, as the legacy look
 * did not; the Layout section can turn that on.
 */
export function legacyTwin(settings: CaptionSettings): CaptionStudio {
  const look = captionLook(settings.preset)
  const twin = TWIN[settings.preset] ?? TWIN.clean
  const dark = luminance(settings.color) < 0.35
  const edgeColour = dark ? '#ffffff' : '#000000'
  const lookOutline = look.outline
  const bg = settings.background
  const outline = lookOutline > 0 ? lookOutline : bg === 'box' ? 0 : bg === 'none' ? 0.08 : 0.05
  const size = Math.min(STUDIO_LIMITS.size.max, Math.max(STUDIO_LIMITS.size.min, settings.size * look.scale))
  return {
    from: settings.preset,
    text: { font: settings.font ?? 'system', weight: twin.weight, case: twin.upper ? 'upper' : 'asis', tracking: 0, lineHeight: twin.lineHeight, size, tall: 1 },
    emphasis: { weight: Math.min(1000, twin.weight + 200), scale: 1, mark: 'none' },
    theme: {
      text: settings.color,
      spoken: settings.highlightColor,
      emphasis: settings.highlightColor,
      outline: edgeColour,
      shadow: edgeColour,
      box: dark ? '#ffffff' : '#0a0a10',
      glow: settings.highlightColor
    },
    edge: {
      outline,
      outlineAlpha: dark ? 0.85 : 0.82,
      ...(bg === 'shadow' ? { shadow: { x: 0, y: 0.05, blur: 0.3, alpha: dark ? 0.6 : 0.7 } } : {}),
      glow: 0
    },
    box: bg === 'box' ? { kind: 'line', alpha: dark ? 0.9 : 0.68, padX: 0.42, padY: 0.12, radius: 0.32, border: 0, gap: 0.08 } : { kind: 'none', alpha: 0.75, padX: 0.42, padY: 0.12, radius: 0.32, border: 0 },
    spoken: twin.spoken,
    layout: { chunk: 'phrase', words: 3, lines: settings.maxLines, chars: 0, tallChars: 0, position: settings.position, legacyAnchor: true, avoid: false },
    motion: { enter: 'fade', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1, strength: 1, speed: 1, tilt: 0, tiltOn: 'chunk' }
  }
}

/** A saved look's id from a tile ('mine:<id>'), or null. */
const savedId = (tile: string): string | null => (tile.startsWith('mine:') ? tile.slice(5) : null)

/**
 * The legacy look a Studio look falls back to for older builds (§4.5): its built-in tile's; for a
 * saved or brand look the nearest: Boxed with a background, Karaoke with a spoken box, pill or
 * fill, Bold in capitals, else Clean.
 */
function fallbackOf(look: CaptionStudio): CaptionPreset {
  const tile = studioPreset(look.from)
  if (tile) return tile.fallback
  if (look.box.kind !== 'none') return 'boxed'
  if (look.spoken === 'box' || look.spoken === 'pill' || look.spoken === 'fill') return 'karaoke'
  return look.text.case === 'upper' ? 'bold' : 'clean'
}

/**
 * Settings with gallery tile `tile` picked (§5.8): a built-in id, 'mine:<id>' (a saved look) or
 * 'brand'. The look comes from the tile with `from` set to the tile; `picked` is set; show,
 * showSpeaker, track, size, font and a dragged place are kept; the tile's fallback preset is
 * written with its colours and background (withPreset) for older builds. Calm motion is the
 * tile's own, never the PC's animation setting. The settings unchanged for an unknown tile.
 */
export function withStudioTile(
  settings: CaptionSettings,
  tile: string,
  frame: { w: number; h: number },
  opts?: { saved?: readonly { id: string; look: CaptionStudio }[]; brand?: CaptionStudio }
): CaptionSettings {
  void frame
  const mine = savedId(tile)
  const source = mine !== null ? opts?.saved?.find((s) => s.id === mine)?.look : tile === 'brand' ? opts?.brand : studioPreset(tile)?.look
  if (!source) return settings
  const look: CaptionStudio = { ...structuredClone(source), from: tile }
  const place = settings.studio?.layout.place
  const { place: _gone, ...layout } = look.layout
  void _gone
  look.layout = place ? { ...layout, place: { ...place } } : layout
  const fallback = fallbackOf(look)
  return { ...withPreset(settings, fallback), studio: look, picked: true }
}

/** Settings with a legacy tile picked: withPreset, `picked`, no `studio` (show, showSpeaker and track kept). */
export function withLegacyTile(settings: CaptionSettings, preset: CaptionPreset): CaptionSettings {
  const { studio: _studio, ...rest } = withPreset(settings, preset)
  void _studio
  return { ...rest, picked: true }
}

/**
 * Settings with the look changed by `patch` (made from the Studio twin on a legacy look, §5.8),
 * `picked` set. The settings themselves when the patch changes nothing.
 */
export function editStudio(settings: CaptionSettings, patch: (s: CaptionStudio) => CaptionStudio): CaptionSettings {
  const base = settings.studio ?? legacyTwin(settings)
  const next = patch(base)
  if (next === base || deepEqual(next, base)) return settings
  return { ...settings, studio: next, picked: true }
}

/** Structural equality of plain data. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** The look without what is not part of it as a tile: where it came from and where it was dragged. */
function lookOnly(s: CaptionStudio): CaptionStudio {
  const { place: _p, ...layout } = s.layout
  void _p
  return { ...s, from: '', layout }
}

/**
 * Whether the look differs from its tile's (the name line's "(edited)", §5.7): a built-in or saved
 * tile's look compared without `from` and a dragged place; a legacy look's twin is always edited
 * (it is "your own version of Clean"); the brand look is its own reference (false).
 */
export function studioEdited(studio: CaptionStudio, saved?: readonly { id: string; look: CaptionStudio }[]): boolean {
  const mine = savedId(studio.from)
  const ref = mine !== null ? saved?.find((s) => s.id === mine)?.look : studioPreset(studio.from)?.look
  if (!ref) return studio.from !== 'brand'
  return !deepEqual(lookOnly(studio), lookOnly(ref))
}

/** The size shown and drawn in a `w` x `h` frame (`size × tall` in tall frames). */
export function studioSize(studio: CaptionStudio, w: number, h: number): number {
  return studio.text.size * (isTall(w, h) ? studio.text.tall : 1)
}

/** The look with the size shown in a `w` x `h` frame set to `shown` (in a tall frame, `size` = shown / tall), within the limits. */
export function setStudioSize(studio: CaptionStudio, shown: number, w: number, h: number): CaptionStudio {
  const size = Math.min(STUDIO_LIMITS.size.max, Math.max(STUDIO_LIMITS.size.min, shown / (isTall(w, h) ? studio.text.tall : 1)))
  return size === studio.text.size ? studio : { ...studio, text: { ...studio.text, size } }
}

/** The Line length chip the look's characters match, or null (§2.6). */
export function lineLengthOf(studio: CaptionStudio): 'short' | 'medium' | 'long' | null {
  for (const key of ['short', 'medium', 'long'] as const) {
    const l = LINE_LENGTHS[key]
    if (studio.layout.chars === l.chars && studio.layout.tallChars === l.tallChars) return key
  }
  return null
}

/** The look with line length `l` (LINE_LENGTHS). */
export function withLineLength(studio: CaptionStudio, l: 'short' | 'medium' | 'long'): CaptionStudio {
  const { chars, tallChars } = LINE_LENGTHS[l]
  return { ...studio, layout: { ...studio.layout, chars, tallChars } }
}

/** Speaker names on or off; off also turns speaker colours off, so colour is never the only cue (§2.6). */
export function withSpeakerNames(settings: CaptionSettings, on: boolean): CaptionSettings {
  if (on) return settings.showSpeaker ? settings : { ...settings, showSpeaker: true }
  const { showSpeaker: _s, ...rest } = settings
  void _s
  if (!settings.studio?.speakerColors) return settings.showSpeaker ? rest : settings
  const { speakerColors: _c, ...studio } = settings.studio
  void _c
  return { ...rest, studio }
}
