import { describe, expect, it } from 'vitest'
import { catalogFont, catalogId, type CatalogFont } from '../src/shared/captions/fontCatalog'
import { coverageNeeded, partnerFor } from '../src/shared/captions/fontStack'

/*
 * The Font menu's note under a font without the caption language's letters (docs/design/
 * captions-studio.md §2.6, §6.6): it names the font the captions are drawn with, the script font
 * for a script, and the font's own partner for Cyrillic and Vietnamese (Anton → Oswald).
 */

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PICKER = '../src/renderer/src/editor/panels/FontPicker'
const { coverageNote } = (await import(/* @vite-ignore */ PICKER)) as { coverageNote(font: CatalogFont, language: string | undefined): string | null }

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
    expect(coverageNote(font('anton'), 'bn')).toBe("Doesn't have Bengali letters: Flown uses Noto Sans Bengali for them")
    expect(coverageNote(font('montserrat'), 'ru')).toBeNull()
    expect(coverageNote(font('anton'), 'en')).toBeNull()
  })
})
