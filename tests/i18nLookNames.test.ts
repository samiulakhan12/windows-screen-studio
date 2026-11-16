/**
 * The engine's built-in looks have messages (docs/design/output-and-languages.md §9.1, part X1):
 * every gradient, animated gradient, wallpaper, zoom easing and tilt preset of the engine's tables
 * has its name in the editor namespace, and in English each one is the table's own text, so a panel
 * that shows lookNames.ts instead of the table shows the same words.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ANIMATED_GRADIENTS, GRADIENTS } from '../src/shared/engine/backgrounds'
import { ZOOM_EASINGS } from '../src/shared/engine/easing'
import { animatedName, easingLabel, easingTitle, gradientName, tiltLabel, tiltPresetsShown, tiltTitle, wallpaperName, zoomEasingOptions } from '../src/shared/engine/lookNames'
import { TILT_PRESETS } from '../src/shared/engine/tilt'
import { WALLPAPERS } from '../src/shared/engine/wallpapers'
import { setCatalogue } from '../src/shared/i18n/t'

afterEach(() => setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' }))

describe('the engine looks’ names', () => {
  it('give each table’s English name and tooltip', () => {
    for (const g of GRADIENTS) expect(gradientName(g.id), g.id).toBe(g.name)
    for (const a of ANIMATED_GRADIENTS) expect(animatedName(a.id), a.id).toBe(a.name)
    for (const w of WALLPAPERS) expect(wallpaperName(w.id), w.id).toBe(w.name)
    for (const e of ZOOM_EASINGS) {
      expect(easingLabel(e.value)).toBe(e.label)
      expect(easingTitle(e.value)).toBe(e.title)
    }
    expect(zoomEasingOptions()).toEqual(ZOOM_EASINGS)
    for (const p of TILT_PRESETS) {
      expect(tiltLabel(p.id)).toBe(p.label)
      expect(tiltTitle(p.id)).toBe(p.title)
    }
    expect(tiltPresetsShown()).toEqual(TILT_PRESETS)
  })

  it('show another language’s names where it has them', () => {
    setCatalogue({ language: 'bn', messages: { 'editor.look.easing.smooth.label': 'মসৃণ', 'editor.look.wallpaper.violet-mesh': 'বেগুনি জাল' }, formatLocale: 'bn-BD', dir: 'ltr' })
    expect(zoomEasingOptions()[0]).toEqual({ value: 'smooth', label: 'মসৃণ', title: 'Eases in and out evenly' })
    expect(wallpaperName('violet-mesh')).toBe('বেগুনি জাল')
    expect(gradientName('aurora')).toBe('Aurora')
  })
})
