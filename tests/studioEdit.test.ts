import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPTIONS, withPreset } from '../src/shared/captions/settings'
import { readCaptionStudio } from '../src/shared/captions/studioData'
import { editStudio, legacyTwin, lineLengthOf, setStudioSize, studioEdited, studioSize, withLegacyTile, withLineLength, withSpeakerNames, withStudioTile } from '../src/shared/captions/studioEdit'
import { STUDIO_BASE, studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionPreset, CaptionSettings, CaptionStudio } from '../src/shared/types'

/* Test 19 (docs/design/captions-studio.md §16.1): Studio twins and tiles (§5.7, §5.8, §2.6). */

const PRESETS: CaptionPreset[] = ['clean', 'bold', 'boxed', 'karaoke', 'minimal']
const legacy = (preset: CaptionPreset, extra: Partial<CaptionSettings> = {}): CaptionSettings => ({ ...withPreset(DEFAULT_CAPTIONS, preset), ...extra })
const FRAME = { w: 1080, h: 1920 }

describe('Studio twins (§5.8)', () => {
  it('draws each legacy look the same way, with legacyAnchor, and reads back unchanged', () => {
    for (const preset of PRESETS) {
      const t = legacyTwin(legacy(preset))
      expect(t.layout, preset).toMatchObject({ chunk: 'phrase', lines: 2, chars: 0, tallChars: 0, position: 'bottom', legacyAnchor: true })
      expect(t.text, preset).toMatchObject({ font: 'system', tracking: 0, tall: 1 })
      expect(t.motion, preset).toMatchObject({ enter: 'fade', exit: 'fade', word: 'none', emphasis: 'none', upcoming: 1 })
      expect(t.theme, preset).toMatchObject({ text: legacy(preset).color, spoken: legacy(preset).highlightColor, emphasis: legacy(preset).highlightColor })
      expect(t.from).toBe(preset)
      expect(readCaptionStudio(JSON.parse(JSON.stringify(t))), preset).toEqual(t)
    }
    expect(legacyTwin(legacy('clean'))).toMatchObject({ spoken: 'none', text: { weight: 600, lineHeight: 1.28, case: 'asis', size: 0.045 }, edge: { outline: 0.05, outlineAlpha: 0.82, shadow: { x: 0, y: 0.05, blur: 0.3, alpha: 0.7 } }, box: { kind: 'none' } })
    expect(legacyTwin(legacy('bold'))).toMatchObject({ spoken: 'color', text: { weight: 800, lineHeight: 1.18, case: 'upper', size: 0.045 * 1.12 }, edge: { outline: 0.16 } })
    expect(legacyTwin(legacy('boxed'))).toMatchObject({ spoken: 'none', text: { weight: 600, lineHeight: 1.42 }, edge: { outline: 0 }, box: { kind: 'line', alpha: 0.68, padX: 0.42, padY: 0.12, radius: 0.32, gap: 0.08 }, theme: { box: '#0a0a10' } })
    expect(legacyTwin(legacy('karaoke'))).toMatchObject({ spoken: 'pill', text: { weight: 700, lineHeight: 1.42, size: 0.045 * 1.04 } })
    expect(legacyTwin(legacy('minimal'))).toMatchObject({ spoken: 'none', text: { weight: 500, lineHeight: 1.26, size: 0.045 * 0.88 }, edge: { outline: 0.07 } })
  })

  it('keeps the brand font, the position and the lines; dark text gets a light outline and box', () => {
    const t = legacyTwin(legacy('boxed', { font: 'brand1', position: 'top', maxLines: 1, color: '#14141c' }))
    expect(t.text.font).toBe('brand1')
    expect(t.layout).toMatchObject({ position: 'top', lines: 1 })
    expect(t.theme).toMatchObject({ outline: '#ffffff', box: '#ffffff' })
    expect(t.box.alpha).toBe(0.9)
    expect(legacyTwin(legacy('clean', { background: 'none' })).edge.outline).toBe(0.08)
  })
})

describe('tiles (§5.8)', () => {
  it('withStudioTile keeps show, showSpeaker, track and place, writes the fallback preset, sets picked and never calm', () => {
    const before: CaptionSettings = { ...legacy('clean'), show: false, showSpeaker: true, track: 'bn', size: 0.06, font: 'brand1', studio: { ...STUDIO_BASE, layout: { ...STUDIO_BASE.layout, place: { x: 0.3, y: 0.7 } }, motion: { ...STUDIO_BASE.motion, calm: true } } }
    const after = withStudioTile(before, 'bold-pop', FRAME)
    expect(after).toMatchObject({ show: false, showSpeaker: true, track: 'bn', picked: true, preset: 'bold', size: 0.06, font: 'brand1' })
    expect(after.studio!.from).toBe('bold-pop')
    expect(after.studio!.layout.place).toEqual({ x: 0.3, y: 0.7 })
    expect(after.studio!.motion.calm).toBeUndefined()
    // The fallback's colours and background, for older builds.
    const { color, highlightColor, background } = withPreset(before, 'bold')
    expect(after).toMatchObject({ color, highlightColor, background })
    expect(withStudioTile(legacy('clean'), 'karaoke-fill', FRAME)).toMatchObject({ preset: 'karaoke', highlightColor: '#22d3ee', background: 'box' })
    // The look is a copy: changing it never changes the gallery's.
    after.studio!.text.size = 0.2
    expect(studioPreset('bold-pop')!.look.text.size).toBe(0.085)
  })

  it('picks saved looks and the brand look, and ignores unknown tiles', () => {
    const mine: CaptionStudio = { ...studioPreset('neon')!.look, from: 'mine:abc', theme: { ...studioPreset('neon')!.look.theme, spoken: '#ff00ff' } }
    const s = withStudioTile(legacy('clean'), 'mine:abc', FRAME, { saved: [{ id: 'abc', look: mine }] })
    expect(s.studio).toMatchObject({ from: 'mine:abc', theme: { spoken: '#ff00ff' } })
    expect(s.preset).toBe('bold')
    const brand = withStudioTile(legacy('clean'), 'brand', FRAME, { brand: studioPreset('glass')!.look })
    expect(brand.studio!.from).toBe('brand')
    expect(brand.preset).toBe('boxed')
    const same = legacy('clean')
    expect(withStudioTile(same, 'nope', FRAME)).toBe(same)
    expect(withStudioTile(same, 'mine:zzz', FRAME, { saved: [] })).toBe(same)
  })

  it('withLegacyTile writes the preset, sets picked and removes the Studio look', () => {
    const s = withLegacyTile({ ...legacy('clean'), studio: STUDIO_BASE, showSpeaker: true, track: 'bn' }, 'karaoke')
    expect(s.studio).toBeUndefined()
    expect(s).toMatchObject({ preset: 'karaoke', picked: true, showSpeaker: true, track: 'bn', highlightColor: '#22d3ee' })
  })

  it('editStudio makes the twin on a legacy look in the same step, sets picked, and changes nothing for a no-op', () => {
    const before = legacy('boxed')
    const after = editStudio(before, (s) => ({ ...s, motion: { ...s.motion, enter: 'pop' } }))
    expect(after.studio).toEqual({ ...legacyTwin(before), motion: { ...legacyTwin(before).motion, enter: 'pop' } })
    expect(after.picked).toBe(true)
    expect(after.preset).toBe('boxed')
    expect(editStudio(before, (s) => s)).toBe(before)
    expect(editStudio(before, (s) => structuredClone(s))).toBe(before)
    const studio = withStudioTile(before, 'subtitle', FRAME)
    expect(editStudio(studio, (s) => ({ ...s, text: { ...s.text, weight: 700 } })).studio!.text.weight).toBe(700)
  })

  it('studioEdited compares with the tile, ignoring where it came from and a drag', () => {
    const tile = withStudioTile(legacy('clean'), 'subtitle', FRAME).studio!
    expect(studioEdited(tile)).toBe(false)
    expect(studioEdited({ ...tile, layout: { ...tile.layout, place: { x: 0.2, y: 0.2 } } })).toBe(false)
    expect(studioEdited({ ...tile, text: { ...tile.text, weight: 800 } })).toBe(true)
    // What the reader gives back is not an edit.
    expect(studioEdited(readCaptionStudio(JSON.parse(JSON.stringify(tile)))!)).toBe(false)
    const mine = { ...STUDIO_BASE, from: 'mine:a' }
    expect(studioEdited(mine, [{ id: 'a', look: mine }])).toBe(false)
    expect(studioEdited({ ...mine, spoken: 'fill' }, [{ id: 'a', look: mine }])).toBe(true)
    // A twin is always "your own version".
    expect(studioEdited(legacyTwin(legacy('clean')))).toBe(true)
    expect(studioEdited({ ...STUDIO_BASE, from: 'brand' })).toBe(false)
  })
})

describe('sizes, line lengths and speaker names (§2.6)', () => {
  it('shows and sets the size drawn in tall frames', () => {
    const bp = studioPreset('bold-pop')!.look
    expect(studioSize(bp, 1920, 1080)).toBe(0.085)
    expect(studioSize(bp, 1080, 1920)).toBeCloseTo(0.085 * 1.26, 9)
    expect(setStudioSize(bp, 0.126, 1080, 1920).text.size).toBeCloseTo(0.1, 9)
    expect(setStudioSize(bp, 0.1, 1920, 1080).text.size).toBe(0.1)
    expect(setStudioSize(bp, 0.5, 1920, 1080).text.size).toBe(0.22)
    expect(setStudioSize(bp, 0.085, 1920, 1080)).toBe(bp)
  })

  it('withLineLength and lineLengthOf', () => {
    expect(lineLengthOf(STUDIO_BASE)).toBe('long')
    expect(lineLengthOf(withLineLength(STUDIO_BASE, 'short'))).toBe('short')
    expect(withLineLength(STUDIO_BASE, 'medium').layout).toMatchObject({ chars: 32, tallChars: 20 })
    expect(lineLengthOf(studioPreset('karaoke-fill')!.look)).toBeNull()
  })

  it('withSpeakerNames(false) also clears speaker colours', () => {
    const on = withSpeakerNames({ ...DEFAULT_CAPTIONS, studio: { ...STUDIO_BASE, speakerColors: true } }, true)
    expect(on.showSpeaker).toBe(true)
    const off = withSpeakerNames({ ...on }, false)
    expect(off.showSpeaker).toBeUndefined()
    expect(off.studio!.speakerColors).toBeUndefined()
    const plain = { ...DEFAULT_CAPTIONS }
    expect(withSpeakerNames(plain, false)).toBe(plain)
  })
})
