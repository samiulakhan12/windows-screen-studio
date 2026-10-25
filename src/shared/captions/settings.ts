/**
 * How captions look: the defaults, the five presets (each a good-looking combination of colour,
 * highlight and background), and reading stored caption settings. Pure: shared by the Captions
 * tab, the render layer and project loading (engine/project.ts).
 */
import type { CaptionPreset, CaptionSettings } from '../types'

/** Text height limits, as a fraction of the output's shorter side. */
export const CAPTION_SIZE = { min: 0.025, max: 0.09 }

export const HEX = /^#[0-9a-f]{6}$/i

export const DEFAULT_CAPTIONS: CaptionSettings = {
  show: true,
  preset: 'clean',
  position: 'bottom',
  size: 0.045,
  color: '#ffffff',
  highlightColor: '#facc15',
  background: 'shadow',
  maxLines: 2
}

/** What a preset sets when picked: the rest (position, size, lines) stays as the user had it. */
export type PresetLook = Pick<CaptionSettings, 'color' | 'highlightColor' | 'background'>

export const CAPTION_PRESETS: { value: CaptionPreset; label: string; title: string; look: PresetLook }[] = [
  { value: 'clean', label: 'Clean', title: 'White text with a soft shadow', look: { color: '#ffffff', highlightColor: '#facc15', background: 'shadow' } },
  { value: 'bold', label: 'Bold', title: 'Big outlined capitals; the spoken word lights up', look: { color: '#ffffff', highlightColor: '#facc15', background: 'shadow' } },
  { value: 'boxed', label: 'Boxed', title: 'Text on a dark box, like TV subtitles', look: { color: '#ffffff', highlightColor: '#facc15', background: 'box' } },
  { value: 'karaoke', label: 'Karaoke', title: 'Each word lights up as it is spoken', look: { color: '#ffffff', highlightColor: '#22d3ee', background: 'box' } },
  { value: 'minimal', label: 'Minimal', title: 'Light, small text with a thin outline', look: { color: '#f8fafc', highlightColor: '#facc15', background: 'none' } }
]

export const CAPTION_COLORS = ['#ffffff', '#facc15', '#a5f3fc', '#f9a8d4', '#14141c']
export const HIGHLIGHT_COLORS = ['#facc15', '#22d3ee', '#a3e635', '#f472b6', '#fb923c']

/** How a preset draws its text (beyond the colours and background in CaptionSettings). */
export interface CaptionLook {
  weight: number
  uppercase: boolean
  /** The spoken word is drawn in the highlight colour (needs word timings, else spread evenly). */
  karaoke: boolean
  /** Dark outline width, as a fraction of the text size (0 = none). */
  outline: number
  /** Line height, as a multiple of the text size. */
  lineHeight: number
  /** Text size multiplier (bold is a little bigger, minimal a little smaller). */
  scale: number
}

const LOOKS: Record<CaptionPreset, CaptionLook> = {
  clean: { weight: 600, uppercase: false, karaoke: false, outline: 0, lineHeight: 1.28, scale: 1 },
  bold: { weight: 800, uppercase: true, karaoke: true, outline: 0.16, lineHeight: 1.18, scale: 1.12 },
  boxed: { weight: 600, uppercase: false, karaoke: false, outline: 0, lineHeight: 1.42, scale: 1 },
  karaoke: { weight: 700, uppercase: false, karaoke: true, outline: 0, lineHeight: 1.42, scale: 1.04 },
  minimal: { weight: 500, uppercase: false, karaoke: false, outline: 0.07, lineHeight: 1.26, scale: 0.88 }
}

export const captionLook = (preset: CaptionPreset): CaptionLook => LOOKS[preset] ?? LOOKS.clean

/** The project's caption settings, or the defaults when it has none (older projects). */
export const captionsOf = (p: { captions?: CaptionSettings }): CaptionSettings => p.captions ?? DEFAULT_CAPTIONS

/** Settings with `preset` picked: its colours and background, the rest kept. */
export const withPreset = (s: CaptionSettings, preset: CaptionPreset): CaptionSettings => ({
  ...s,
  preset,
  ...(CAPTION_PRESETS.find((p) => p.value === preset)?.look ?? {})
})

const PRESETS = CAPTION_PRESETS.map((p) => p.value)
const POSITIONS: CaptionSettings['position'][] = ['bottom', 'middle', 'top']
const BACKGROUNDS: CaptionSettings['background'][] = ['none', 'box', 'shadow']

/**
 * Stored caption settings with every field usable: unknown values fall back to the defaults,
 * the size is clamped, colours must be #rrggbb. Anything that is not an object reads as absent.
 */
export function readCaptionSettings(raw: unknown): CaptionSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Partial<Record<keyof CaptionSettings, unknown>>
  const d = DEFAULT_CAPTIONS
  const pick = <T>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)
  const size = typeof r.size === 'number' && Number.isFinite(r.size) ? Math.min(CAPTION_SIZE.max, Math.max(CAPTION_SIZE.min, r.size)) : d.size
  return {
    show: typeof r.show === 'boolean' ? r.show : d.show,
    preset: pick(r.preset, PRESETS, d.preset),
    position: pick(r.position, POSITIONS, d.position),
    size,
    color: typeof r.color === 'string' && HEX.test(r.color) ? r.color.toLowerCase() : d.color,
    highlightColor: typeof r.highlightColor === 'string' && HEX.test(r.highlightColor) ? r.highlightColor.toLowerCase() : d.highlightColor,
    background: pick(r.background, BACKGROUNDS, d.background),
    maxLines: r.maxLines === 1 ? 1 : 2
  }
}
