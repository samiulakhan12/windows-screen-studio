/*
 * Stand-ins for the other parts' functions the Captions Studio editor UI calls (docs/design/
 * captions-studio.md §14.1, §14.2, §14.4), for the UI tests of part P3 while those parts are built
 * alongside: they do what the design says in a few lines, and record their calls. After the parts
 * merge, the tests still check the UI against these, so a test fails only for the UI's own code.
 */
import { withPreset } from '../src/shared/captions/settings'
import { LINE_LENGTHS, studioPreset, type SavedLook } from '../src/shared/captions/studioPresets'
import type { CaptionPreset, CaptionSettings, CaptionStudio, StudioTheme } from '../src/shared/types'

export const calls: Record<string, unknown[][]> = {}
const record = (name: string, args: unknown[]): void => void (calls[name] ??= []).push(args)
export const resetCalls = (): void => {
  for (const k of Object.keys(calls)) delete calls[k]
}

const subtitle = (): CaptionStudio => studioPreset('subtitle')!.look

/* ---------- part P1: studioEdit.ts ---------- */

export function legacyTwin(settings: CaptionSettings): CaptionStudio {
  record('legacyTwin', [settings])
  const s = subtitle()
  return { ...s, from: settings.preset, theme: { ...s.theme, text: settings.color, spoken: settings.highlightColor }, layout: { ...s.layout, position: settings.position === 'middle' ? 'middle' : settings.position, legacyAnchor: true } }
}

export function withStudioTile(settings: CaptionSettings, tile: string, frame: { w: number; h: number }, opts?: { saved?: readonly SavedLook[]; brand?: CaptionStudio }): CaptionSettings {
  record('withStudioTile', [settings, tile, frame, opts])
  const source = tile.startsWith('mine:') ? opts?.saved?.find((s) => `mine:${s.id}` === tile)?.look : tile === 'brand' ? opts?.brand : studioPreset(tile)?.look
  if (!source) return settings
  return { ...withPreset(settings, studioPreset(tile)?.fallback ?? 'clean'), studio: { ...source, from: tile }, picked: true }
}

export function withLegacyTile(settings: CaptionSettings, preset: CaptionPreset): CaptionSettings {
  record('withLegacyTile', [settings, preset])
  const { studio: _s, ...rest } = withPreset(settings, preset)
  void _s
  return { ...rest, picked: true }
}

export function editStudio(settings: CaptionSettings, patch: (s: CaptionStudio) => CaptionStudio): CaptionSettings {
  const base = settings.studio ?? legacyTwin(settings)
  const next = patch(base)
  if (JSON.stringify(next) === JSON.stringify(base)) return settings
  return { ...settings, studio: next, picked: true }
}

export function studioEdited(studio: CaptionStudio, saved?: readonly SavedLook[]): boolean {
  const ref = studio.from.startsWith('mine:') ? saved?.find((s) => `mine:${s.id}` === studio.from)?.look : studioPreset(studio.from)?.look
  if (!ref) return studio.from !== 'brand'
  const strip = (s: CaptionStudio): string => JSON.stringify({ ...s, from: '', layout: { ...s.layout, place: undefined } })
  return strip(studio) !== strip(ref)
}

export const studioSize = (s: CaptionStudio, w: number, h: number): number => s.text.size * (h >= 1.25 * w ? s.text.tall : 1)
export const setStudioSize = (s: CaptionStudio, shown: number, w: number, h: number): CaptionStudio => ({ ...s, text: { ...s.text, size: shown / (h >= 1.25 * w ? s.text.tall : 1) } })
export function lineLengthOf(s: CaptionStudio): 'short' | 'medium' | 'long' | null {
  for (const k of ['short', 'medium', 'long'] as const) if (s.layout.chars === LINE_LENGTHS[k].chars && s.layout.tallChars === LINE_LENGTHS[k].tallChars) return k
  return null
}
export const withLineLength = (s: CaptionStudio, l: 'short' | 'medium' | 'long'): CaptionStudio => ({ ...s, layout: { ...s.layout, ...LINE_LENGTHS[l] } })
export function withSpeakerNames(settings: CaptionSettings, on: boolean): CaptionSettings {
  record('withSpeakerNames', [settings, on])
  if (on) return { ...settings, showSpeaker: true }
  const { showSpeaker: _n, ...rest } = settings
  void _n
  if (!rest.studio?.speakerColors) return rest
  const { speakerColors: _c, ...studio } = rest.studio
  void _c
  return { ...rest, studio }
}

/* ---------- part P1: colors.ts, marks.ts ---------- */

export const withTheme = (s: CaptionStudio, theme: StudioTheme): CaptionStudio => ({ ...s, theme: { ...s.theme, ...theme } })
export const brandTheme = (colors: readonly string[], s: CaptionStudio): { theme: StudioTheme; lightened: string[] } | null => (colors.length >= 2 ? { theme: { ...s.theme, spoken: colors[0], emphasis: colors[1] }, lightened: [] } : null)
export const speakerColors = (_s: CaptionStudio, n: number): string[] => ['#ffffff', '#5ce1e6', '#8be28b'].slice(0, n)
export const staticContrast = (s: CaptionStudio): { worst: number; colour: string; against: string } => ({ worst: s.edge.outline >= 0.04 ? 13.6 : 1.2, colour: s.theme.text, against: s.theme.outline })
export const contrastFix = (s: CaptionStudio): CaptionStudio => ({ ...s, edge: { ...s.edge, outline: Math.max(0.06, s.edge.outline), outlineAlpha: 1 } })
export const textOn = (): '#111111' => '#111111'
export const contrastRatio = (): number => 4.5
export const over = (c: string): string => c
export const measuredContrast = (): number => 4.5
