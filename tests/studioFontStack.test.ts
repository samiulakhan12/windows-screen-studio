import { describe, expect, it } from 'vitest'
import { clampWeight, coverageNeeded, partnerFor, scriptLineHeight, scriptOutline, scriptScale, studioFontStack, trackingFor, wordFace } from '../src/shared/captions/fontStack'
import { studioPreset, STUDIO_PRESETS } from '../src/shared/captions/studioPresets'
import { mainScript, scriptsIn, type ScriptTag } from '../src/shared/captions/words'
import type { CaptionStudio } from '../src/shared/types'

/* Test 18 (docs/design/captions-studio.md §16.1): font stacks and faces per word (§6.5, §6.6, §0.2). */

const look = (id: string): CaptionStudio => structuredClone(studioPreset(id)!.look)
const none = (): boolean => false
const ctxOf = (text: string, language?: string, downloaded: (id: string) => boolean = none) => ({ language, scripts: scriptsIn([text]), main: mainScript(text), downloaded })
const first = (stack: string): string => stack.split(',')[0].trim()

describe('font stacks (§6.6)', () => {
  it('a Bangla caption in Bold Pop starts with Baloo Da 2', () => {
    const text = 'আমরা আজ শিখব'
    expect(first(studioFontStack(look('bold-pop'), 'text', ctxOf(text, 'bn')))).toBe("'FlownCat-baloo-da-2'")
  })

  it('a Russian caption in Anton swaps to Oswald, the whole font', () => {
    const stack = studioFontStack({ ...look('one-word'), text: { ...look('one-word').text, font: 'cat:anton' } }, 'text', ctxOf('Привет мир', 'ru'))
    expect(first(stack)).toBe("'FlownCat-oswald'")
    expect(stack).not.toContain('FlownCat-anton')
    // The same for a Latin word of a Russian caption, and for any caption with Cyrillic letters.
    expect(first(wordFace(look('one-word'), 'text', 'latin', { ...ctxOf('Привет Flown', 'ru') }).stack)).toBe("'FlownCat-oswald'")
    expect(partnerFor('cat:anton', ['cyrillic'])).toBe('cat:oswald')
    expect(partnerFor('cat:montserrat', ['greek'])).toBe('cat:inter-tight')
    expect(partnerFor('cat:bangers', ['cyrillic'])).toBe('cat:montserrat')
    expect(partnerFor('cat:anton', [])).toBe('cat:anton')
    expect(partnerFor('brand1', ['cyrillic'])).toBe('brand1')
  })

  it('has the emoji font in every stack, after the text fonts', () => {
    for (const p of STUDIO_PRESETS)
      for (const [text, lang] of [
        ['Hello', 'en'],
        ['আমরা', 'bn'],
        ['مرحبا', 'ar']
      ] as const) {
        const stack = studioFontStack(p.look, 'text', ctxOf(text, lang))
        expect(stack, p.id).toContain("'FlownCat-noto-color-emoji'")
        expect(stack.indexOf('FlownCat-noto-color-emoji'), p.id).toBeGreaterThan(stack.indexOf('FlownCat-'))
        expect(stack.endsWith("Arial, sans-serif"), p.id).toBe(true)
      }
  })

  it('Chinese and Japanese pick their own font: the download when it is there, else the Windows font', () => {
    const s = look('subtitle')
    expect(first(studioFontStack(s, 'text', ctxOf('我们今天学习', 'zh')))).toBe("'Microsoft YaHei UI'")
    expect(first(studioFontStack(s, 'text', ctxOf('今日は学ぶ', 'ja')))).toBe("'Yu Gothic UI'")
    expect(first(studioFontStack(s, 'text', ctxOf('我們今天', 'zh-TW')))).toBe("'Microsoft JhengHei UI'")
    const all = (): boolean => true
    expect(first(studioFontStack(s, 'text', ctxOf('我们今天学习', 'zh', all)))).toBe("'FlownCat-noto-sans-sc'")
    // Han characters in a Japanese caption draw in the Japanese font.
    expect(first(wordFace(s, 'text', 'han', { language: 'ja', scripts: new Set<ScriptTag>(['han', 'kana']), downloaded: all }).stack)).toBe("'FlownCat-noto-sans-jp'")
    expect(first(wordFace(s, 'text', 'hangul', { language: 'ko', scripts: new Set<ScriptTag>(['hangul']), downloaded: all }).stack)).toBe("'FlownCat-noto-sans-kr'")
  })

  it('puts the script fonts of the other scripts of a mixed caption after the look font', () => {
    const stack = studioFontStack(look('subtitle'), 'text', ctxOf('Open the Settings সেটিংস', 'en'))
    expect(first(stack)).toBe("'FlownCat-inter-tight'")
    expect(stack.indexOf('FlownCat-noto-sans-bengali')).toBeGreaterThan(stack.indexOf('FlownCat-inter-tight'))
  })

  it('Devanagari takes Poppins for Hindi at 600–800, else Noto Sans Devanagari', () => {
    const hi = { language: 'hi', scripts: new Set<ScriptTag>(['devanagari']), downloaded: none }
    expect(first(wordFace(look('text-box'), 'text', 'devanagari', hi).stack)).toBe("'FlownCat-poppins'")
    expect(first(wordFace(look('subtitle'), 'text', 'devanagari', { ...hi, language: 'ne' }).stack)).toBe("'FlownCat-noto-sans-devanagari'")
    expect(first(wordFace(look('weight-shift'), 'text', 'devanagari', hi).stack)).toBe("'FlownCat-noto-sans-devanagari'")
  })
})

describe('faces per word (§6.5, §0.2)', () => {
  const mixed = { language: 'bn', scripts: new Set<ScriptTag>(['bengali', 'latin']), downloaded: none }

  it('in a Bold Pop caption mixing Bangla and English, the Bangla word is Baloo Da 2 at 800 and the English word Montserrat at 900', () => {
    const bn = wordFace(look('bold-pop'), 'text', 'bengali', mixed)
    expect(first(bn.stack)).toBe("'FlownCat-baloo-da-2'")
    expect(bn.weight).toBe(800)
    const en = wordFace(look('bold-pop'), 'text', 'latin', mixed)
    expect(first(en.stack)).toBe("'FlownCat-montserrat'")
    expect(en.weight).toBe(900)
  })

  it('gives each of the twelve looks its Bangla font, and English words in them keep the Latin font', () => {
    const expected: Record<string, [string, number]> = {
      'bold-pop': ['baloo-da-2', 800],
      'karaoke-fill': ['hind-siliguri', 700],
      'highlight-box': ['noto-sans-bengali', 700],
      glass: ['hind-siliguri', 600],
      stacked: ['anek-bangla', 800],
      neon: ['mina', 700],
      handwritten: ['galada', 400],
      comic: ['atma', 700],
      editorial: ['noto-serif-bengali', 700],
      gold: ['noto-serif-bengali', 700],
      subtitle: ['hind-siliguri', 600],
      news: ['hind-siliguri', 600]
    }
    for (const [id, [font, weight]] of Object.entries(expected)) {
      const f = wordFace(look(id), 'text', 'bengali', mixed)
      expect(first(f.stack), id).toBe(`'FlownCat-${font}'`)
      expect(f.weight, id).toBe(weight)
      expect(first(wordFace(look(id), 'text', 'latin', mixed).stack), id).toBe(`'FlownCat-${look(id).text.font.slice(4)}'`)
    }
    expect(wordFace(look('stacked'), 'text', 'bengali', mixed).stretch).toBe(75)
    expect(wordFace(look('stacked'), 'text', 'latin', mixed).stretch).toBeUndefined()
  })

  it('a look without its own Bangla font draws Bangla in Noto Sans Bengali (§0.2: any other look)', () => {
    const s = look('subtitle')
    delete s.text.scripts
    expect(first(wordFace(s, 'text', 'bengali', mixed).stack)).toBe("'FlownCat-noto-sans-bengali'")
  })

  it('emphasised Bangla words draw at the heavier of their font weight and the emphasis weight, in their Bangla font', () => {
    const ed = wordFace(look('editorial'), 'emphasis', 'bengali', mixed)
    expect(first(ed.stack)).toBe("'FlownCat-noto-serif-bengali'")
    expect(ed.weight).toBe(700)
    // Emphasis in English keeps the serif italic.
    expect(first(wordFace(look('editorial'), 'emphasis', 'latin', mixed).stack)).toBe("'FlownCat-instrument-serif-italic'")
    const glass = wordFace(look('glass'), 'emphasis', 'bengali', mixed)
    expect(glass.weight).toBe(700)
  })

  it('a look whose own font draws Bangla needs no script font first', () => {
    const s = look('subtitle')
    s.text.font = 'cat:hind-siliguri'
    expect(first(wordFace(s, 'text', 'bengali', mixed).stack)).toBe("'FlownCat-hind-siliguri'")
  })

  it('brand fonts draw from their Studio family with real weights; unknown ones fall back to the caption font', () => {
    const s = look('subtitle')
    s.text.font = 'brand1'
    const f = wordFace(s, 'text', 'latin', { ...mixed, fonts: [{ id: 'brand1', name: 'Brand', file: 'font-1.ttf' } as never] })
    expect(first(f.stack)).toBe("'FlownFontW-brand1'")
    expect(f.weight).toBe(600)
    expect(first(wordFace(s, 'text', 'latin', mixed).stack)).not.toContain('brand1')
  })

  it('letter spacing is 0 for Arabic and Bangla words and kept for Latin', () => {
    const s = look('news')
    expect(wordFace(s, 'text', 'arabic', { scripts: new Set<ScriptTag>(['arabic']), downloaded: none }).tracking).toBe(0)
    expect(wordFace(s, 'text', 'bengali', mixed).tracking).toBe(0)
    expect(wordFace(s, 'text', 'latin', mixed).tracking).toBe(0.01)
    expect(trackingFor('hebrew', 0.05)).toBe(0)
    expect(trackingFor('cyrillic', 0.05)).toBe(0.05)
  })
})

describe('weights, coverage and script rules', () => {
  it('clamps weights to the files or the range the font has; single-weight fonts draw at 400', () => {
    expect(clampWeight('cat:anton', 900)).toBe(400)
    expect(clampWeight('cat:poppins', 900)).toBe(800)
    expect(clampWeight('cat:poppins', 650)).toBe(700)
    expect(clampWeight('cat:poppins', 400)).toBe(600)
    expect(clampWeight('cat:oswald', 900)).toBe(700)
    expect(clampWeight('cat:baloo-da-2', 900)).toBe(800)
    expect(clampWeight('cat:hind-siliguri', 800)).toBe(700)
    expect(clampWeight('system', 900)).toBe(900)
  })

  it('names the coverage a caption needs beyond Latin', () => {
    expect(coverageNeeded('vi', 'Xin chào')).toEqual(['vietnamese'])
    expect(coverageNeeded('ru', 'Hello')).toEqual(['cyrillic'])
    expect(coverageNeeded('en', 'Łódź')).toEqual(['latin-ext'])
    expect(coverageNeeded('en', 'Ελλάδα')).toEqual(['greek'])
    expect(coverageNeeded('en', 'Café')).toEqual([])
  })

  it('raises line heights for scripts with tall letters', () => {
    expect(scriptLineHeight('arabic', 1.05)).toBe(1.5)
    expect(scriptLineHeight('bengali', 1.05)).toBe(1.4)
    expect(scriptLineHeight('thai', 1.05)).toBe(1.45)
    expect(scriptLineHeight('latin', 1.05)).toBe(1.05)
    expect(scriptLineHeight('bengali', 1.6)).toBe(1.6)
  })

  it('keeps Bangla growth at ×1.14 and its outline thin (§0.2)', () => {
    expect(scriptScale('bengali', 1.6)).toBe(1.14)
    expect(scriptScale('latin', 1.6)).toBe(1.6)
    expect(scriptOutline('bengali', 0.085)).toBe(0.042)
    expect(scriptOutline('latin', 0.085)).toBe(0.085)
  })
})
