import { describe, expect, it } from 'vitest'
import { applyBrandKit, brandCardTimes, brandFontsLeftOut, brandKitIsEmpty, sanitizeBrandKit, type BrandKit } from '../src/shared/editor/brandKit'
import { EditStore } from '../src/shared/editor/editStore'
import { BUILT_IN_PRESETS } from '../src/shared/editor/stylePresets'
import { readFonts } from '../src/shared/engine/overlayData'
import { createProject } from '../src/shared/engine/project'
import { MAX_PROJECT_FONTS } from '../src/shared/render/fonts'
import type { Clip, Project } from '../src/shared/types'

function project(extra: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 30,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  return { ...p, ...extra }
}

const pop = BUILT_IN_PRESETS.find((p) => p.name === 'Pop')!
const KIT: BrandKit = {
  logo: { file: 'logo-1.png', position: 'top-right', size: 0.1, opacity: 0.8, margin: 0.03 },
  colors: ['#123456', '#abcdef'],
  fonts: [
    { id: 'kh', name: 'Heading', file: 'font-1.ttf' },
    { id: 'kb', name: 'Body', file: 'font-2.woff2' }
  ],
  headingFont: 'kh',
  bodyFont: 'kb',
  intro: { title: 'Acme', subtitle: 'Product tour', style: 'centered', background: 'solid', length: 3 },
  outro: { title: 'Thanks', style: 'big', background: 'solid', length: 2 },
  preset: { name: 'Pop', look: pop.look },
  autoApply: true
}
const FILES = { logo: 'watermark-1.png', fonts: { kh: 'font-1.ttf', kb: 'font-2.woff2' } }

describe('reading a stored brand kit', () => {
  it('keeps a good kit and drops what cannot be used', () => {
    const kit = sanitizeBrandKit({
      ...KIT,
      logo: { ...KIT.logo, file: 'logo-1.png', size: 9 },
      colors: ['#123456', 'red', '#123456'],
      fonts: [...KIT.fonts, { id: 'x', name: 'Bad', file: '../font-3.ttf' }, { id: 'kh', name: 'Dup', file: 'font-4.ttf' }],
      intro: { ...KIT.intro, length: 99 }
    })
    expect(kit.logo).toMatchObject({ file: 'logo-1.png', size: 0.4 })
    expect(kit.colors).toEqual(['#123456'])
    expect(kit.fonts.map((f) => f.id)).toEqual(['kh', 'kb'])
    expect(kit.intro?.length).toBe(10)
    expect(kit.preset?.name).toBe('Pop')
    expect(kit.autoApply).toBe(true)
  })

  it('drops a logo path that leaves the folder, fonts named by nothing, empty cards', () => {
    const kit = sanitizeBrandKit({ logo: { file: '../../logo-1.png' }, headingFont: 'nope', intro: { title: '  ' }, preset: { name: 'x', look: 5 } })
    expect(kit).toEqual({ colors: [], fonts: [], autoApply: false })
    expect(brandKitIsEmpty(kit)).toBe(true)
    expect(sanitizeBrandKit('junk')).toEqual({ colors: [], fonts: [], autoApply: false })
  })
})

describe('applying the brand kit', () => {
  it('applies the preset, logo, fonts, intro and outro and keeps the colours', () => {
    const p = applyBrandKit(project(), KIT, FILES)
    expect(p.style.shadowStyle).toBe('hard')
    expect(p.watermark).toEqual({ show: true, kind: 'image', path: 'watermark-1.png', position: 'top-right', size: 0.1, opacity: 0.8, margin: 0.03 })
    expect(p.fonts).toEqual([
      { id: 'kh', name: 'Heading', file: 'font-1.ttf' },
      { id: 'kb', name: 'Body', file: 'font-2.woff2' }
    ])
    expect(p.captions?.font).toBe('kb')
    const intro = p.titles!.find((c) => c.brand === 'intro')!
    const outro = p.titles!.find((c) => c.brand === 'outro')!
    expect(intro).toMatchObject({ start: 0, end: 3, title: 'Acme', subtitle: 'Product tour', color: '#123456', font: 'kh', background: 'solid' })
    expect(outro).toMatchObject({ start: 28, end: 30, title: 'Thanks', style: 'big', font: 'kh' })
    expect(p.brand).toEqual({ colors: ['#123456', '#abcdef'], headingFont: 'kh', bodyFont: 'kb' })
  })

  it('applying again replaces its intro and outro instead of adding more', () => {
    const once = applyBrandKit(project(), KIT, FILES)
    const twice = applyBrandKit(once, KIT, FILES)
    expect(twice.titles!.filter((c) => c.brand)).toHaveLength(2)
    expect(twice.fonts).toHaveLength(2)
  })

  it('keeps a font chosen by hand and switches text that uses the default font', () => {
    const before = project({
      fonts: [{ id: 'mine', name: 'Mine', file: 'font-9.ttf' }],
      annotations: [
        { id: 'a', start: 0, end: 1, text: 'x', x: 0.5, y: 0.5, size: 0.05, style: 'pill' },
        { id: 'b', start: 0, end: 1, text: 'y', x: 0.5, y: 0.5, size: 0.05, style: 'pill', font: 'mine' }
      ],
      titles: [{ id: 't', start: 5, end: 7, title: 'Mine', style: 'centered', background: 'blur' }]
    })
    const p = applyBrandKit(before, KIT, FILES)
    expect(p.annotations.map((a) => a.font)).toEqual(['kb', 'mine'])
    expect(p.titles!.find((c) => c.id === 't')?.font).toBe('kh')
    expect(p.fonts!.map((f) => f.id)).toEqual(['mine', 'kh', 'kb'])
  })

  it('reuses a project font with the same file, and gives a clashing id a new one', () => {
    const p = applyBrandKit(
      project({
        fonts: [
          { id: 'kh', name: 'Other', file: 'font-7.ttf' },
          { id: 'zz', name: 'Same', file: 'font-2.woff2' }
        ]
      }),
      KIT,
      FILES
    )
    const heading = p.fonts!.find((f) => f.file === 'font-1.ttf')!
    expect(heading.id).not.toBe('kh')
    expect(p.brand?.headingFont).toBe(heading.id)
    expect(p.brand?.bodyFont).toBe('zz')
    expect(p.fonts).toHaveLength(3)
  })

  it('adds no font past the project limit: the fonts that do not fit are not used, so reopening loses none', () => {
    const mine = Array.from({ length: MAX_PROJECT_FONTS - 1 }, (_, i) => ({ id: `m${i}`, name: `Mine ${i}`, file: `font-${i + 10}.ttf` }))
    const before = project({ fonts: mine })
    expect(brandFontsLeftOut(before, KIT, FILES)).toEqual(['Body'])
    const p = applyBrandKit(before, KIT, FILES)
    expect(p.fonts).toHaveLength(MAX_PROJECT_FONTS)
    expect(readFonts(p.fonts)).toEqual(p.fonts)
    expect(p.fonts!.at(-1)?.id).toBe('kh')
    expect(p.captions?.font).toBeUndefined()
    expect(p.brand).toEqual({ colors: ['#123456', '#abcdef'], headingFont: 'kh' })
    // A kit font whose file the project already has still fits.
    const same = project({ fonts: [...mine, { id: 'zz', name: 'Same', file: 'font-2.woff2' }] })
    expect(brandFontsLeftOut(same, KIT, FILES)).toEqual(['Heading'])
    expect(applyBrandKit(same, KIT, FILES).captions?.font).toBe('zz')
    expect(brandFontsLeftOut(project(), KIT, FILES)).toEqual([])
  })

  it('leaves out the parts whose files were not copied', () => {
    const p = applyBrandKit(project(), KIT, { fonts: { kb: 'font-2.woff2' } })
    expect(p.watermark).toBeUndefined()
    expect(p.fonts?.map((f) => f.id)).toEqual(['kb'])
    // Without a heading font, titles take the body font.
    expect(p.titles!.find((c) => c.brand === 'intro')?.font).toBe('kb')
  })

  it('an empty kit changes nothing', () => {
    const p = project()
    expect(applyBrandKit(p, { colors: [], fonts: [], autoApply: true }, { fonts: {} })).toBe(p)
  })

  it('is one undo step in the editor', () => {
    const store = new EditStore(project())
    const before = store.state
    store.update((p) => applyBrandKit(p, KIT, FILES))
    expect(store.state.watermark?.path).toBe('watermark-1.png')
    expect(store.undo()).toBe(true)
    expect(store.state).toBe(before)
    expect(store.canUndo).toBe(false)
  })
})

describe('intro and outro times', () => {
  it('fit inside the kept video, at most a third of it each', () => {
    const clips: Clip[] = [
      { id: 'a', start: 2, end: 5, speed: 1 },
      { id: 'b', start: 10, end: 16, speed: 2 }
    ]
    // 3 s + 3 s of output = 6 s.
    expect(brandCardTimes(clips, 3, false)).toEqual({ start: 2, end: 4 })
    expect(brandCardTimes(clips, 3, true)).toEqual({ start: 12, end: 16 })
    expect(brandCardTimes([{ id: 'a', start: 0, end: 1.2, speed: 1 }], 3, false)).toBeNull()
  })
})
