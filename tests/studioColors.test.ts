import { describe, expect, it } from 'vitest'
import { brandTheme, contrastFix, contrastRatio, dependableSurround, measuredContrast, over, speakerColors, staticContrast, textOn, tooClose, withTheme } from '../src/shared/captions/colors'
import { STUDIO_BASE, STUDIO_PRESETS, studioPreset, THEMES } from '../src/shared/captions/studioPresets'
import type { CaptionStudio } from '../src/shared/types'

/* Tests 8 and 53 (docs/design/captions-studio.md §16.1): the static contrast rule, Fix, themes and speaker colours (§7). */

const look = (id: string): CaptionStudio => structuredClone(studioPreset(id)!.look)

describe('WCAG contrast', () => {
  it('reproduces the published failures the research found', () => {
    expect(contrastRatio('#a6a6a6', '#e7e5e7')).toBeCloseTo(1.94, 2)
    expect(contrastRatio('#ffffff', '#ff1745')).toBeCloseTo(3.85, 2)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 6)
  })

  it('composites a colour over another', () => {
    expect(over('#000000', 0.85, '#ffffff')).toBe('#262626')
    expect(over('#ffffff', 1, '#000000')).toBe('#ffffff')
    expect(over('#ffffff', 0, '#123456')).toBe('#123456')
  })

  it('textOn picks the darker or white text, whichever reads better', () => {
    expect(textOn('#ffe14d')).toBe('#111111')
    expect(textOn('#e0102f')).toBe('#ffffff')
  })
})

describe('the static rule (test 8)', () => {
  it('every built-in look reaches 4.5:1 with its own theme, second emphasis colours included', () => {
    for (const p of STUDIO_PRESETS) {
      const r = staticContrast(p.look)
      expect(r.worst, `${p.id}: ${r.colour} on ${r.against}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('gives the design figures for the looks it names', () => {
    expect(staticContrast(look('subtitle')).worst).toBeCloseTo(contrastRatio('#ffffff', over('#000000', 0.82, '#ffffff')), 6)
    // Clean Short: white 15.1:1 and #ffd166 10.5:1 on its 0.04 em edge at α 0.85 (#262626 over white).
    expect(contrastRatio('#ffffff', '#262626')).toBeCloseTo(15.1, 1)
    expect(staticContrast(look('clean-short')).worst).toBeCloseTo(contrastRatio('#ffd166', '#262626'), 6)
    // Text Box: #c8102e on white is the worst, 5.9:1.
    const tb = staticContrast(look('text-box'))
    expect(tb.worst).toBeCloseTo(5.9, 1)
    expect(tb.colour).toBe('#c8102e')
    // Bold Pop's #ff6ad5 and Comic's #4dd2ff against black.
    expect(contrastRatio('#ff6ad5', '#000000')).toBeCloseTo(8.3, 1)
    expect(contrastRatio('#4dd2ff', '#000000')).toBeCloseTo(12.0, 0)
  })

  it('finds the failing colour of a look: a dim word, the spoken box, a hollow word, a second emphasis', () => {
    const grey: CaptionStudio = { ...look('glass'), theme: { ...look('glass').theme, text: '#a6a6a6', box: '#e7e5e7' } }
    expect(staticContrast(grey).worst).toBeLessThan(2.5)
    const red: CaptionStudio = { ...look('highlight-box'), theme: { ...look('highlight-box').theme, spoken: '#ff1745', spokenText: '#ffffff' } }
    expect(staticContrast(red)).toMatchObject({ colour: '#ffffff', against: '#ff1745' })
    expect(staticContrast(red).worst).toBeCloseTo(3.85, 2)
    const dim: CaptionStudio = { ...look('neon'), edge: { ...look('neon').edge, outline: 0 }, motion: { ...look('neon').motion, upcoming: 0.14 } }
    expect(staticContrast(dim).worst).toBeLessThan(1.5)
    const hollow: CaptionStudio = { ...look('outline'), theme: { ...look('outline').theme, text: '#777777' } }
    expect(staticContrast(hollow).against).toBe(over('#000000', 0.6, '#ffffff'))
    const second: CaptionStudio = { ...look('bold-pop'), theme: { ...look('bold-pop').theme, emphasis2: '#3a0000' } }
    expect(staticContrast(second).colour).toBe('#3a0000')
  })

  it('a look without a box or a 0.04 em outline is judged against white and black video', () => {
    const bare: CaptionStudio = { ...STUDIO_BASE, edge: { ...STUDIO_BASE.edge, outline: 0.02 } }
    expect(staticContrast(bare).worst).toBeCloseTo(1, 6)
    expect(dependableSurround(bare)).toBe(false)
    expect(dependableSurround(STUDIO_BASE)).toBe(true)
    expect(dependableSurround(look('glass'))).toBe(true)
  })

  it('Fix brings a failing look to 4.5:1 or more', () => {
    const failing: CaptionStudio[] = [
      { ...STUDIO_BASE, edge: { ...STUDIO_BASE.edge, outline: 0 } },
      { ...STUDIO_BASE, edge: { ...STUDIO_BASE.edge, outline: 0.03, outlineAlpha: 0.4 } },
      { ...look('glass'), box: { ...look('glass').box, alpha: 0.3 } },
      { ...look('glass'), theme: { ...look('glass').theme, text: '#a6a6a6', box: '#e7e5e7' } },
      { ...look('highlight-box'), theme: { ...look('highlight-box').theme, spoken: '#ff1745', spokenText: '#ffffff' } },
      { ...look('neon'), edge: { ...look('neon').edge, outline: 0 }, motion: { ...look('neon').motion, upcoming: 0.14 } },
      withTheme(look('subtitle'), { ...THEMES[0].theme, spoken: '#ffffff', text: '#808080' })
    ]
    for (const [i, f] of failing.entries()) {
      expect(staticContrast(f).worst, `case ${i} fails first`).toBeLessThan(4.5)
      expect(staticContrast(contrastFix(f)).worst, `case ${i}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('Fix first does what §7.3 says: an outline of 0.06 em at α 0.85, a weak one to α 1, a box 0.15 more opaque', () => {
    expect(contrastFix({ ...STUDIO_BASE, edge: { ...STUDIO_BASE.edge, outline: 0 } }).edge).toMatchObject({ outline: 0.06, outlineAlpha: 0.85 })
    expect(contrastFix({ ...STUDIO_BASE, edge: { ...STUDIO_BASE.edge, outline: 0.04, outlineAlpha: 0.3 } }).edge).toMatchObject({ outline: 0.05, outlineAlpha: 1 })
    expect(contrastFix({ ...look('glass'), box: { ...look('glass').box, alpha: 0.5 } }).box.alpha).toBeCloseTo(0.65, 9)
  })

  it('measures the 10th percentile of the text against the video under it', () => {
    const px = new Uint8ClampedArray(100 * 4)
    for (let i = 0; i < 100; i++) {
      const v = i < 15 ? 255 : 0
      px.set([v, v, v, 255], i * 4)
    }
    // White text over 15% white pixels: the 10th percentile is 1:1.
    expect(measuredContrast(STUDIO_BASE, px)).toBeCloseTo(1, 6)
    for (let i = 0; i < 100; i++) px.set([0, 0, 0, 255], i * 4)
    expect(measuredContrast(STUDIO_BASE, px)).toBeCloseTo(21, 6)
  })
})

describe('themes and the brand theme (§7.1)', () => {
  it('a theme swaps the colours and keeps the geometry and the second emphasis colour', () => {
    const t = withTheme(look('bold-pop'), THEMES.find((x) => x.id === 'cyan')!.theme)
    expect(t.theme).toMatchObject({ text: '#ffffff', spoken: '#22d3ee', emphasis: '#ffe14d', emphasis2: '#ff6ad5', glow: '#22d3ee' })
    expect(t.edge).toEqual(look('bold-pop').edge)
    expect(t.box).toEqual(look('bold-pop').box)
    // A gradient fill gives way to the theme's word colour.
    expect(withTheme(look('gold'), THEMES[0].theme).theme.fill).toBeUndefined()
  })

  it('lightens brand colours until they pass, and skips one that cannot', () => {
    const r = brandTheme(['#1e3a8a', '#ff1745', '#22d3ee'], look('subtitle'))!
    expect(r.lightened).toEqual(['#1e3a8a', '#ff1745'])
    for (const c of [r.theme.spoken, r.theme.emphasis, r.theme.emphasis2!]) expect(contrastRatio(c, over('#000000', 0.82, '#ffffff')), c).toBeGreaterThanOrEqual(4.5)
    expect(r.theme).toMatchObject({ text: '#ffffff', emphasis2: '#22d3ee', glow: r.theme.spoken })
    expect(r.theme.emphasis).not.toBe('#ff1745')
    // On Glass Pill's tint (α 0.65 over white video), black does not pass even mixed 60% with white: it is skipped.
    const glass = brandTheme(['#000000', '#ffd166'], look('glass'))!
    expect(glass.lightened).toEqual(['#ffd166'])
    expect(glass.theme.spoken).toBe(glass.theme.emphasis)
    expect(brandTheme(['#000000', 'nope'], look('glass'))).toBeNull()
  })
})

describe('speaker colours (test 53)', () => {
  it("Karaoke Fill's second speaker gets #5ce1e6", () => {
    expect(speakerColors(look('karaoke-fill'), 3)).toEqual(['#ffffff', '#5ce1e6', '#8be28b'])
  })

  it('Bold Pop skips #ffe14d and #8be28b', () => {
    const c = speakerColors(look('bold-pop'), 4)
    expect(c).toEqual(['#ffffff', '#5ce1e6', '#ff9fb2', '#c4a7ff'])
  })

  it('Mono skips white for the first speaker, and the palette repeats from its first colour', () => {
    const mono = withTheme(STUDIO_BASE, THEMES.find((t) => t.id === 'mono')!.theme)
    const c = speakerColors(mono, 7)
    expect(c[0]).toBe('#ffe14d')
    expect(c).not.toContain('#ffffff')
    expect(c[5]).toBe(c[0])
  })

  it('judges closeness by hue for saturated colours and by contrast for the others', () => {
    expect(tooClose('#ffe14d', '#5ce1e6')).toBe(false)
    expect(tooClose('#8be28b', '#39e508')).toBe(true)
    expect(tooClose('#ffffff', '#f0f0f0')).toBe(true)
    expect(tooClose('#ffffff', '#ffe14d')).toBe(false)
  })
})
