import { describe, expect, it } from 'vitest'
import { catalogFont, catalogId, type CatalogFont } from '../src/shared/captions/fontCatalog'
import { coverageNeeded, partnerFor, wordFace } from '../src/shared/captions/fontStack'
import { STUDIO_PRESETS } from '../src/shared/captions/studioPresets'
import type { ScriptTag } from '../src/shared/captions/words'

/*
 * The Font menu's note under a font without the caption language's letters (docs/design/
 * captions-studio.md §2.6, §6.6): it names the font the captions are drawn with, the script font
 * for a script, and the font's own partner for Cyrillic and Vietnamese (Anton → Oswald).
 */

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PICKER = '../src/renderer/src/editor/panels/FontPicker'
const { coverageNote } = (await import(/* @vite-ignore */ PICKER)) as { coverageNote(font: CatalogFont, language: string | undefined, bangla?: string): string | null }

const font = (id: string): CatalogFont => catalogFont(id)!
const drawn = (id: string, language: string): string => catalogFont(catalogId(partnerFor(`cat:${id}`, coverageNeeded(language, '')))!)!.family

describe('the coverage note (§6.6)', () => {
  it('names the partner the captions draw Russian, Ukrainian and Vietnamese letters with', () => {
    expect(coverageNote(font('anton'), 'ru')).toBe("Doesn't have Russian letters: Flown uses Oswald for them")
    expect(coverageNote(font('fredoka'), 'ru')).toBe("Doesn't have Russian letters: Flown uses Nunito for them")
    for (const [id, language] of [['anton', 'ru'], ['bebas-neue', 'vi'], ['outfit', 'ru'], ['bangers', 'uk'], ['lilita-one', 'ru'], ['luckiest-guy', 'vi'], ['archivo-black', 'ru'], ['fredoka', 'ru'], ['caveat', 'vi']] as const) {
      const note = coverageNote(font(id), language)
      expect(note, `${id} ${language}`).toBe(`Doesn't have ${language === 'vi' ? 'Vietnamese' : language === 'uk' ? 'Ukrainian' : 'Russian'} letters: Flown uses ${drawn(id, language)} for them`)
    }
  })

  it('names the script font for a script, and nothing when the font has the letters', () => {
    // A look without a Bangla font of its own draws Bangla in Noto Sans Bengali.
    expect(coverageNote(font('anton'), 'bn')).toBe("Doesn't have Bengali letters: Flown uses Noto Sans Bengali for them")
    expect(coverageNote(font('montserrat'), 'ru')).toBeNull()
    expect(coverageNote(font('anton'), 'en')).toBeNull()
  })

  it("names the look's own Bangla font, which draws the Bangla the font lacks (§0.2)", () => {
    expect(coverageNote(font('anton'), 'bn', 'cat:hind-siliguri')).toBe("Doesn't have Bengali letters: Flown uses Hind Siliguri for them")
    // Every look, with Anton as its text font: the note names the font its Bangla words are drawn with.
    for (const preset of STUDIO_PRESETS) {
      const studio = { ...structuredClone(preset.look), text: { ...structuredClone(preset.look.text), font: 'cat:anton' } }
      const face = wordFace(studio, 'text', 'bengali', { language: 'bn', scripts: new Set<ScriptTag>(['bengali']), downloaded: () => false })
      const first = /^'FlownCat-([^']+)'/.exec(face.stack)?.[1]
      expect(coverageNote(font('anton'), 'bn', studio.text.scripts?.bengali?.font), preset.id).toBe(`Doesn't have Bengali letters: Flown uses ${font(first!).family} for them`)
    }
  })
})
