import { describe, expect, it, vi } from 'vitest'
import type { CaptionSettings, CaptionStudio, Project } from '../src/shared/types'

/*
 * The brand kit's caption style and quote cards (docs/design/captions-studio.md §2.12, §4.6,
 * test 35). Picking the Brand tile is part P1's withStudioTile: a stand-in here that does what
 * §5.8 says and records how it was called.
 */

const picks = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('../src/shared/captions/studioEdit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withStudioTile: (settings: CaptionSettings, tile: string, frame: { w: number; h: number }, opts?: { brand?: CaptionStudio }) => {
    picks.calls.push([settings, tile, frame, opts])
    const place = settings.studio?.layout.place
    const look = { ...opts!.brand!, from: tile, layout: { ...opts!.brand!.layout, ...(place ? { place } : {}) } }
    return { ...settings, preset: 'boxed', studio: look, picked: true }
  }
}))

const { applyBrandKit, brandKitIsEmpty, sanitizeBrandKit, EMPTY_BRAND_KIT } = await import('../src/shared/editor/brandKit')
const { TITLE_STYLES } = await import('../src/shared/editor/titles')
const { createProject } = await import('../src/shared/engine/project')
const { studioPreset } = await import('../src/shared/captions/studioPresets')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')

function project(extra: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 30,
    width: 1080,
    height: 1920,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  return { ...p, ...extra }
}

const glass = studioPreset('glass')!.look
const boldPop = studioPreset('bold-pop')!.look

describe('reading the kit’s caption style', () => {
  it('keeps a name and a look read like a project’s, from the Brand tile', () => {
    const kit = sanitizeBrandKit({ colors: [], fonts: [], autoApply: false, captionStyle: { name: '  Acme   captions ', look: { ...glass, text: { ...glass.text, size: 5 } } } })
    expect(kit.captionStyle?.name).toBe('Acme captions')
    expect(kit.captionStyle?.look.from).toBe('brand')
    expect(kit.captionStyle?.look.text.size).toBe(0.22)
    expect(kit.captionStyle?.look.box).toEqual(glass.box)
  })

  it('drops one without a name or a usable look, and kits from before have none', () => {
    expect(sanitizeBrandKit({ captionStyle: { name: '', look: glass } }).captionStyle).toBeUndefined()
    expect(sanitizeBrandKit({ captionStyle: { name: 'X', look: 'glass' } }).captionStyle).toBeUndefined()
    expect(sanitizeBrandKit({ colors: ['#123456'], fonts: [], autoApply: true })).not.toHaveProperty('captionStyle')
  })

  it('is enough for a kit not to be empty', () => {
    expect(brandKitIsEmpty({ ...EMPTY_BRAND_KIT, captionStyle: { name: 'A', look: glass } })).toBe(false)
  })

  it('reads its own output back the same', () => {
    const once = sanitizeBrandKit({ colors: [], fonts: [], autoApply: false, captionStyle: { name: 'Acme', look: boldPop } })
    expect(sanitizeBrandKit(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })
})

describe('quote cards in the kit', () => {
  it("accepts the 'quote' style for the intro and outro", () => {
    const kit = sanitizeBrandKit({ colors: [], fonts: [], autoApply: false, intro: { title: 'Ship it', style: 'quote', background: 'blur', length: 3 } })
    expect(kit.intro?.style).toBe('quote')
  })

  it('offers Quote among the title styles, with its copy', () => {
    expect(TITLE_STYLES.find((s) => s.value === 'quote')).toEqual({ value: 'quote', label: 'Quote', title: 'A short quote on a panel' })
  })
})

describe('applying the kit’s caption style', () => {
  const kit = { ...EMPTY_BRAND_KIT, colors: [], fonts: [], captionStyle: { name: 'Acme', look: { ...glass, from: 'brand' } } }

  it('picks the Brand tile for the project’s frame, keeping what a pick keeps', () => {
    picks.calls = []
    const before: CaptionSettings = { ...DEFAULT_CAPTIONS, show: false, showSpeaker: true, track: 'bn', studio: { ...boldPop, layout: { ...boldPop.layout, place: { x: 0.4, y: 0.3 } } } }
    const out = applyBrandKit(project({ captions: before }), kit, { fonts: {} })
    expect(picks.calls).toHaveLength(1)
    const [settings, tile, frame, opts] = picks.calls[0] as [CaptionSettings, string, { w: number; h: number }, { brand: CaptionStudio }]
    expect(settings).toBe(before)
    expect(tile).toBe('brand')
    expect(frame.h).toBeGreaterThan(frame.w)
    expect(opts.brand).toBe(kit.captionStyle.look)
    expect(out.captions).toMatchObject({ show: false, showSpeaker: true, track: 'bn', picked: true, studio: { from: 'brand', box: glass.box, layout: { place: { x: 0.4, y: 0.3 } } } })
  })

  it('changes nothing about captions without a caption style', () => {
    picks.calls = []
    const p = project()
    const out = applyBrandKit(p, { ...EMPTY_BRAND_KIT, colors: ['#123456'], fonts: [] }, { fonts: {} })
    expect(picks.calls).toHaveLength(0)
    expect(out.captions).toBeUndefined()
  })
})

describe('a font rewrite keeps automatic items automatic (§4.6, §11.8 rule 3)', () => {
  const fontKit = { ...EMPTY_BRAND_KIT, colors: [], fonts: [{ id: 'kb', name: 'Body', file: 'font-2.woff2' }], bodyFont: 'kb' }
  const files = { fonts: { kb: 'font-2.woff2' } }

  it('copies the auto object of an automatic title card it gives a font', () => {
    const auto = { by: 'chapter' as const, via: 'rules' as const, chapter: 'c1' }
    const p = project({ titles: [{ id: 't', start: 3, end: 5.5, title: 'Export settings', style: 'lower-third', background: 'blur', auto }] })
    const card = applyBrandKit(p, fontKit, files).titles![0]
    expect(card.font).toBeTruthy()
    expect(card.auto).toEqual(auto)
    expect(card.auto).not.toBe(auto)
  })

  it('copies the automatic style record when only the caption font changes', () => {
    const record = { was: null, by: 'great' as const, name: 'Bold Pop' }
    const p = project({ captions: { ...DEFAULT_CAPTIONS, studio: boldPop }, captionAuto: { style: record } })
    const out = applyBrandKit(p, fontKit, files)
    expect(out.captions?.font).toBeTruthy()
    expect(out.captionAuto?.style).toEqual(record)
    expect(out.captionAuto?.style).not.toBe(record)
  })

  it('leaves the record to the settle rule when the kit picks its own look', () => {
    const record = { was: null, by: 'great' as const, name: 'Bold Pop' }
    const p = project({ captions: { ...DEFAULT_CAPTIONS, studio: boldPop }, captionAuto: { style: record } })
    const out = applyBrandKit(p, { ...fontKit, captionStyle: { name: 'Acme', look: { ...glass, from: 'brand' } } }, files)
    expect(out.captionAuto?.style).toBe(record)
  })

  it('keeps a hand-made card’s missing auto missing', () => {
    const p = project({ titles: [{ id: 't', start: 3, end: 5.5, title: 'Mine', style: 'centered', background: 'blur' }] })
    expect(applyBrandKit(p, fontKit, files).titles![0]).not.toHaveProperty('auto')
  })
})
