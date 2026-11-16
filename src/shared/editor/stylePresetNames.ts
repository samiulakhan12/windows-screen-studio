/**
 * The names the UI shows for style presets (docs/design/output-and-languages.md §9.1): a built-in
 * preset's name is a message by its id, the user's own presets keep the names they gave. Kept apart
 * from stylePresets.ts, which main loads through the brand kit and which must hold no renderer
 * message (§9.1, test 86).
 */
import { t, type MessageKey } from '../i18n/t'
import type { StylePreset } from './stylePresets'

/** The message of each built-in preset's name, by its id (BUILT_IN_PRESETS). */
export const BUILT_IN_PRESET_NAMES: Readonly<Record<string, MessageKey>> = {
  studio: 'style.preset.studio',
  minimal: 'style.preset.minimal',
  'midnight-browser': 'style.preset.midnightBrowser',
  neon: 'style.preset.neon',
  pop: 'style.preset.pop',
  showcase: 'style.preset.showcase',
  frosted: 'style.preset.frosted',
  flow: 'style.preset.flow'
}

/** The name to show for `preset`: a built-in preset's in the UI language, the user's own as given. */
export function presetLabel(preset: Pick<StylePreset, 'id' | 'name'>, builtIn: boolean): string {
  const key = builtIn ? BUILT_IN_PRESET_NAMES[preset.id] : undefined
  return key ? t(key) : preset.name
}
