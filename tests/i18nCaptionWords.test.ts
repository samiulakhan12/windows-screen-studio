/**
 * The captions' words that main-graph modules keep as English data (docs/design/output-and-languages.md
 * §9.1, test 86) and the renderer shows through messages: every built-in and Classic caption style has
 * a name and description message equal to studioPresets.ts's English, so the gallery's English is the
 * table's, and a style added without its messages fails here.
 */
import { describe, expect, it } from 'vitest'
import { LEGACY_TILES, STUDIO_PRESETS } from '../src/shared/captions/studioPresets'
import { t, type MessageKey } from '../src/shared/i18n/t'

describe('caption style names and descriptions', () => {
  it('every built-in style has messages equal to its table English', () => {
    for (const p of STUDIO_PRESETS) {
      expect(t(`captions.look.preset.${p.id}.name` as MessageKey), p.id).toBe(p.name)
      expect(t(`captions.look.preset.${p.id}.description` as MessageKey), p.id).toBe(p.description)
    }
  })
  it('every Classic style has messages equal to its table English', () => {
    for (const c of LEGACY_TILES) {
      expect(t(`captions.look.classic.${c.preset}.name` as MessageKey), c.preset).toBe(c.name)
      expect(t(`captions.look.classic.${c.preset}.description` as MessageKey), c.preset).toBe(c.description)
    }
  })
})
