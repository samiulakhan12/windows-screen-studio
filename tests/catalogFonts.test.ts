import { describe, expect, it, vi } from 'vitest'
import { CATALOG_FONTS, catalogFont, catalogId } from '../src/shared/captions/fontCatalog'
import { coverageNeeded, partnerFor } from '../src/shared/captions/fontStack'
import { STUDIO_BASE, STUDIO_PRESETS, studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionStudio, Graphic, Project, ProjectFont, TitleCard } from '../src/shared/types'

/*
 * Captions Studio's fonts in the renderer (docs/design/captions-studio.md §6.5–6.8, test 25): which
 * catalogue fonts a project draws with, how they are registered, and that the export waits for
 * them (and for the FlownFontW- brand faces of Studio looks) without ever failing.
 */

interface FakeFace {
  family: string
  source: unknown
  descriptors: Record<string, string>
}
const added: FakeFace[] = []
const deleted: FakeFace[] = []
/** Families whose faces fail to load (OTS refusing a file). */
const broken = new Set<string>()
/** studio-media URLs fetch finds (without their ?v=). */
const files = new Set<string>()
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.stubGlobal('document', {
  fonts: {
    add: (f: FakeFace) => void added.push(f),
    delete: (f: FakeFace) => void deleted.push(f)
  }
})
vi.stubGlobal(
  'FontFace',
  class {
    constructor(
      public family: string,
      public source: unknown,
      public descriptors: Record<string, string> = {}
    ) {}
    async load(): Promise<unknown> {
      if (broken.has(this.family)) throw new Error('OTS parsing error')
      return this
    }
  }
)
/** URLs whose fetch waits for their gate. */
const gates = new Map<string, Promise<void>>()
vi.stubGlobal('fetch', async (url: string) => {
  await gates.get(url.split('?')[0])
  const ok = files.has(url.split('?')[0])
  return { ok, status: ok ? 200 : 404, arrayBuffer: async () => new ArrayBuffer(8) }
})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const LOADER = '../src/renderer/src/render/fontLoader'
const URLS = '../src/renderer/src/render/catalogFonts'
const fonts = (await import(/* @vite-ignore */ LOADER)) as {
  catalogFontsFor(p: Project): string[]
  sampleCatalogFonts(p: Project): string[]
  loadCatalogFont(id: string): Promise<void>
  catalogFontReady(id: string): boolean
  prepareCaptionFonts(p: Project): Promise<void>
  missingCatalogFonts(p: Project): { id: string }[]
  missingCatalogNotes(p: Project): Promise<string[]>
  catalogDescriptors(font: unknown, file: unknown): Record<string, string>
  ensureProjectFonts(p: Project): void
  prepareProjectFonts(p: Project): Promise<void>
  usedFontIds(p: Project): string[]
  fontGeneration(): number
}
const { BUNDLED_FONT_URLS } = (await import(/* @vite-ignore */ URLS)) as { BUNDLED_FONT_URLS: Record<string, string> }

const look = (id: string): CaptionStudio => structuredClone(studioPreset(id)!.look)

/** A project with the fields the font loader reads. */
function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    annotations: [],
    titles: [],
    fonts: [],
    clips: [{ start: 0, end: 10, speed: 1 }],
    transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count' }] },
    captions: { show: true, preset: 'clean', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#ffe14d', background: 'shadow', maxLines: 2 },
    ...over
  } as unknown as Project
}

const withStudio = (studio: CaptionStudio, over: Partial<Project> = {}): Project => {
  const p = project(over)
  return { ...p, captions: { ...p.captions!, studio } }
}

const keyword = (over: Partial<Graphic> = {}): Graphic =>
  ({ id: 'g1', kind: 'keyword', start: 0, end: 1, place: 'auto', size: 0.09, text: 'Export', look: 'card', enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 }, ...over }) as Graphic

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('catalogFontsFor (§6.8)', () => {
  it('lists the look font, the emphasis font and the emoji face of a Studio look', () => {
    const studio = look('editorial')
    expect(fonts.catalogFontsFor(withStudio(studio))).toEqual(['instrument-serif-italic', 'inter-tight', 'noto-color-emoji'])
  })

  it('adds nothing for an old project on a legacy look', () => {
    expect(fonts.catalogFontsFor(project())).toEqual([])
  })

  it('adds the emoji face with any graphic, even with no emoji detected and no Studio look', () => {
    const p = project({ graphics: [keyword()] })
    expect(fonts.catalogFontsFor(p)).toContain('noto-color-emoji')
    expect(fonts.catalogFontsFor(withStudio(look('subtitle')))).toContain('noto-color-emoji')
  })

  it('adds every graphic and list font, a graphic without one taking the look font', () => {
    const list = { id: 'g2', kind: 'list', start: 0, end: 4, place: 'auto', size: 0.045, font: 'cat:caveat', marker: 'number', items: [{ text: 'Open settings', at: 0.5 }], enter: { kind: 'rise', duration: 0.22, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 } } as Graphic
    const p = withStudio(look('bold-pop'), { graphics: [keyword({ font: 'cat:bangers' }), list, keyword({ id: 'g3' })] })
    const ids = fonts.catalogFontsFor(p)
    expect(ids).toEqual(expect.arrayContaining(['bangers', 'caveat', 'montserrat', 'noto-color-emoji']))
  })

  it("adds title cards' cat: fonts and the quote style's Instrument Serif Italic", () => {
    const titles = [
      { id: 't1', start: 0, end: 2, title: 'Hello', style: 'centered', background: 'blur', font: 'cat:anton' },
      { id: 't2', start: 3, end: 5, title: 'It just works', subtitle: 'Sam', style: 'quote', background: 'blur' },
      { id: 't3', start: 6, end: 8, title: 'Brand', style: 'centered', background: 'blur', font: 'f1' }
    ] as TitleCard[]
    expect(fonts.catalogFontsFor(project({ titles }))).toEqual(['anton', 'instrument-serif-italic'])
  })

  it('adds the script fonts of the burned-in captions with a Studio look, and the look’s Bangla font', () => {
    const transcript = {
      language: 'bn',
      segments: [
        { id: 'c1', start: 0, end: 2, text: 'আমরা আজ Flown শিখব' },
        { id: 'c2', start: 2, end: 4, text: 'مرحبا بالعالم' }
      ]
    }
    const ids = fonts.catalogFontsFor(withStudio(look('bold-pop'), { transcript } as Partial<Project>))
    expect(ids).toEqual(expect.arrayContaining(['baloo-da-2', 'noto-sans-bengali', 'noto-sans-arabic', 'montserrat']))
    // A heavy look without its own Bangla font gets Baloo Da 2 (§6.6).
    const plain = look('bold-pop')
    delete plain.text.scripts
    expect(fonts.catalogFontsFor(withStudio(plain, { transcript } as Partial<Project>))).toContain('baloo-da-2')
    // A legacy look draws with its own stack: no script font is loaded for it.
    expect(fonts.catalogFontsFor(project({ transcript } as Partial<Project>))).toEqual([])
  })

  it('adds the look’s Bangla font for Bangla graphics, Subtitle’s on a legacy look, and the Bangla fonts of cards without a font', () => {
    const bn = keyword({ text: 'স্বয়ংক্রিয়' })
    expect(fonts.catalogFontsFor(project({ graphics: [bn] }))).toContain('hind-siliguri')
    expect(fonts.catalogFontsFor(withStudio(look('bold-pop'), { graphics: [bn] }))).toContain('baloo-da-2')
    const name = { id: 't1', start: 0, end: 2, title: 'রহিম', style: 'lower-third', background: 'blur', auto: { by: 'speaker', via: 'rules' } } as TitleCard
    expect(fonts.catalogFontsFor(withStudio(look('bold-pop'), { titles: [name] }))).toContain('baloo-da-2')
    const quote = { id: 't2', start: 3, end: 5, title: 'প্রতিটি শব্দ গুরুত্বপূর্ণ', subtitle: 'রহিম', style: 'quote', background: 'blur' } as TitleCard
    expect(fonts.catalogFontsFor(project({ titles: [quote] }))).toEqual(expect.arrayContaining(['instrument-serif-italic', 'noto-serif-bengali']))
    // A lower third placed by hand draws in the title font as before: nothing to load for it.
    expect(fonts.catalogFontsFor(withStudio(look('bold-pop'), { titles: [{ ...name, auto: undefined }] }))).not.toContain('baloo-da-2')
  })

  it('adds the Bangla fonts for the Bangla digits a counter draws, on a legacy look too (§0.2)', () => {
    const counter = (over: Partial<Graphic> = {}): Graphic =>
      ({ id: 'n1', kind: 'counter', start: 0, end: 2, place: 'auto', size: 0.11, from: 0, to: 300, decimals: 0, prefix: '', suffix: '%', locale: 'bn', countFor: 2, enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 }, ...over }) as Graphic
    const bn = { segments: [{ id: 'c1', start: 0, end: 2, text: 'আমাদের আয় ৩০০% বেড়েছে এই বছরে' }] }
    // A Bangla counter (৩০০%) with no words of its own, on a Classic look, the transcript naming no language or Bangla.
    for (const transcript of [bn, { ...bn, language: 'bn' }]) expect(fonts.catalogFontsFor(project({ transcript, graphics: [counter()] } as Partial<Project>))).toEqual(expect.arrayContaining(['hind-siliguri', 'noto-sans-bengali']))
    // An English-locale counter drawn with Bangla digits by the Digits choice.
    const native = project({ transcript: { ...bn, language: 'bn' }, graphics: [counter({ locale: 'en' } as Partial<Graphic>)] } as Partial<Project>)
    expect(fonts.catalogFontsFor({ ...native, captions: { ...native.captions!, digits: 'native' } })).toEqual(expect.arrayContaining(['hind-siliguri', 'noto-sans-bengali']))
    // Western digits add none.
    expect(fonts.catalogFontsFor(project({ graphics: [counter({ locale: 'en' } as Partial<Graphic>)] }))).not.toContain('noto-sans-bengali')
  })

  it('adds the Bangla fonts for the Bangla numbers a list card draws, its items in English (§0.2)', () => {
    const list = (marker: 'number' | 'bullet'): Graphic =>
      ({ id: 'l1', kind: 'list', start: 0, end: 4, place: 'auto', size: 0.05, marker, items: [{ text: 'Chrome', at: 0 }, { text: 'Firefox', at: 1 }], enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 } }) as Graphic
    const bn = { segments: [{ id: 'c1', start: 0, end: 2, text: 'আমরা আজ দুটি ব্রাউজার দেখব' }] }
    const native = (transcript: object, marker: 'number' | 'bullet'): Project => {
      const p = project({ transcript, graphics: [list(marker)] } as Partial<Project>)
      return { ...p, captions: { ...p.captions!, digits: 'native' } }
    }
    // Bangla captions with Bangla digits chosen: the card numbers its items ১, ২ on a Classic look, the transcript naming no language or Bangla.
    for (const transcript of [bn, { ...bn, language: 'bn' }]) expect(fonts.catalogFontsFor(native(transcript, 'number'))).toEqual(expect.arrayContaining(['hind-siliguri', 'noto-sans-bengali']))
    // Bullets have no number, and Western digits are drawn in the look's font.
    expect(fonts.catalogFontsFor(native({ ...bn, language: 'bn' }, 'bullet'))).not.toContain('noto-sans-bengali')
    expect(fonts.catalogFontsFor(project({ transcript: { ...bn, language: 'bn' }, graphics: [list('number')] } as Partial<Project>))).not.toContain('noto-sans-bengali')
  })

  it('loads the fonts of the look the captions draw with: Chat with no speaker draws as Subtitle (§0.1)', () => {
    const text = 'আমরা আজ শিখব কীভাবে ভিডিও বানাতে হয়'
    const chat = look('chat')
    chat.text.font = 'cat:poppins'
    // No speaker (local transcription): Subtitle's Inter Tight and Hind Siliguri draw, not Chat's fonts.
    const alone = fonts.catalogFontsFor(withStudio(chat, { transcript: { language: 'bn', segments: [{ id: 'c1', start: 0, end: 2, text }] } } as Partial<Project>))
    expect(alone).toEqual(expect.arrayContaining(['hind-siliguri', 'inter-tight']))
    expect(alone).not.toContain('poppins')
    // With a speaker the bubbles draw in Chat's own fonts.
    const spoken = fonts.catalogFontsFor(withStudio(chat, { transcript: { language: 'bn', segments: [{ id: 'c1', start: 0, end: 2, text, speaker: 'You' }] } } as Partial<Project>))
    expect(spoken).toContain('poppins')
    expect(spoken).not.toContain('hind-siliguri')
    // A Bangla graphic takes the look as it is (graphicsLayer): Chat's Bangla font, beside Subtitle's for the captions.
    expect(fonts.catalogFontsFor(withStudio(chat, { transcript: { language: 'bn', segments: [{ id: 'c1', start: 0, end: 2, text }] }, graphics: [keyword({ text: 'স্বয়ংক্রিয়' })] } as Partial<Project>))).toEqual(
      expect.arrayContaining(['hind-siliguri', 'noto-sans-bengali', 'poppins'])
    )
    // A gallery tile draws the look itself, a Chat bubble with no speaker.
    expect(fonts.sampleCatalogFonts(withStudio(chat, { transcript: { language: 'en', segments: [{ id: 'sample', start: 0, end: 2.4, text: 'Make every word count today' }] } } as Partial<Project>))).toContain('poppins')
  })

  it('adds the partner when the language needs letters the look font lacks, and the CJK download of the language', () => {
    const ru = { language: 'ru', segments: [{ id: 'c1', start: 0, end: 2, text: 'Привет мир' }] }
    expect(fonts.catalogFontsFor(withStudio(look('one-word'), { transcript: ru } as Partial<Project>))).toEqual(expect.arrayContaining(['anton', 'oswald']))
    const ja = { language: 'ja', segments: [{ id: 'c1', start: 0, end: 2, text: '動画を書き出す' }] }
    expect(fonts.catalogFontsFor(withStudio(look('subtitle'), { transcript: ja } as Partial<Project>))).toContain('noto-sans-jp')
  })

  it("adds the partner a graphic draws with when the language needs letters its font lacks, as the captions' (§6.6)", () => {
    const ru = { language: 'ru', segments: [{ id: 'c1', start: 0, end: 2, text: 'Привет мир' }] }
    expect(fonts.catalogFontsFor(withStudio(look('subtitle'), { transcript: ru, graphics: [keyword({ font: 'cat:anton' })] } as Partial<Project>))).toEqual(expect.arrayContaining(['anton', 'oswald']))
    // On a legacy look too: Bebas Neue → Oswald in Vietnamese.
    const vi = { language: 'vi', segments: [{ id: 'c1', start: 0, end: 2, text: 'Xin chào mọi người' }] }
    expect(fonts.catalogFontsFor(project({ transcript: vi, graphics: [keyword({ font: 'cat:bebas-neue' })] } as Partial<Project>))).toContain('oswald')
  })

  it('adds the partner for the language of the graphic’s own words, never a shown translation’s, and for its own Cyrillic or Greek', () => {
    const track = (language: string, text: string): Partial<Project> =>
      ({ captionTracks: [{ language, by: 'openai', model: 'm', createdAt: '2026-11-01T00:00:00Z', segments: [{ id: 'c1', text, src: 'x' }] }] }) as Partial<Project>
    const shown = (p: Project, language: string): Project => ({ ...p, captions: { ...p.captions!, track: language } })
    // Russian speech with its English translation shown: the Russian pop-up still draws in Oswald.
    const ru = { language: 'ru', segments: [{ id: 'c1', start: 0, end: 2, text: 'Продажи выросли' }] }
    const ruShown = shown(withStudio(look('subtitle'), { transcript: ru, graphics: [keyword({ text: 'Продажи', font: 'cat:anton' })], ...track('en', 'Sales grew') } as Partial<Project>), 'en')
    expect(fonts.catalogFontsFor(ruShown)).toEqual(expect.arrayContaining(['anton', 'oswald']))
    // English speech with its Russian translation shown: the English pop-up draws in Anton alone.
    const en = { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Sales grew' }] }
    const enShown = shown(project({ transcript: en, graphics: [keyword({ text: 'Sales', font: 'cat:anton' })], ...track('ru', 'Продажи выросли') } as Partial<Project>), 'ru')
    expect(fonts.catalogFontsFor(enShown)).toContain('anton')
    expect(fonts.catalogFontsFor(enShown)).not.toContain('oswald')
    // A graphic of the Russian track (its own language) draws in Oswald.
    const own = shown(project({ transcript: en, graphics: [keyword({ text: 'Продажи', lang: 'ru', font: 'cat:anton' })], ...track('ru', 'Продажи выросли') } as Partial<Project>), 'ru')
    expect(fonts.catalogFontsFor(own)).toContain('oswald')
    // Cyrillic or Greek typed into a graphic of English speech: Oswald, and Inter Tight for Greek.
    expect(fonts.catalogFontsFor(project({ transcript: en, graphics: [keyword({ text: 'Экспорт', font: 'cat:anton' })] } as Partial<Project>))).toContain('oswald')
    expect(fonts.catalogFontsFor(project({ transcript: en, graphics: [keyword({ text: 'Ωmega', font: 'cat:anton' })] } as Partial<Project>))).toContain('inter-tight')
  })

  it('adds the partners of partners the drawing walks to: Anton → Oswald → Inter Tight for Greek', () => {
    const el = { language: 'el', segments: [{ id: 'c1', start: 0, end: 2, text: 'Καλημέρα σε όλους σήμερα' }] }
    expect(fonts.catalogFontsFor(withStudio(look('one-word'), { transcript: el } as Partial<Project>))).toEqual(expect.arrayContaining(['anton', 'oswald', 'inter-tight']))
    // Every look, in languages that need letters beyond Latin-1: the font the words draw with is loaded,
    // also when the caption happens to use only Latin-1 letters (Estonian, Hungarian): the drawing goes by the language.
    const captions: Record<string, string> = {
      el: 'Καλημέρα σε όλους σήμερα',
      ru: 'Привет всем сегодня',
      vi: 'Xin chào mọi người hôm nay',
      pl: 'Dzień dobry wszystkim',
      et: 'Tere tulemast, täna õpime koos',
      hu: 'Jó napot mindenkinek'
    }
    for (const preset of STUDIO_PRESETS) {
      for (const [language, text] of Object.entries(captions)) {
        const studio = structuredClone(preset.look)
        const ids = fonts.catalogFontsFor(withStudio(studio, { transcript: { language, segments: [{ id: 'c1', start: 0, end: 2, text }] } } as Partial<Project>))
        for (const f of [studio.text.font, studio.emphasis.font ?? studio.text.font]) {
          const drawn = catalogId(partnerFor(f, coverageNeeded(language, text)))
          if (drawn) expect(ids, `${preset.id} in ${language} draws ${drawn}`).toContain(drawn)
        }
      }
    }
  })
})

describe('registering catalogue fonts (§6.5)', () => {
  it('gives every bundled WOFF2 file a same-origin URL', () => {
    const woff2 = CATALOG_FONTS.flatMap((f) => f.files.flatMap((x) => (x.woff2 ? [x.woff2.file] : [])))
    expect(Object.keys(BUNDLED_FONT_URLS).sort()).toEqual([...woff2].sort())
    for (const f of woff2) expect(BUNDLED_FONT_URLS[f]).toMatch(new RegExp(`${f.replace('.', '\\.')}$`))
  })

  it('uses the descriptors of the catalogue: ranges for variable fonts, a weight per static file', () => {
    const d = (id: string, i = 0): Record<string, string> => fonts.catalogDescriptors(catalogFont(id)!, catalogFont(id)!.files[i])
    expect(d('montserrat')).toEqual({ weight: '100 900' })
    expect(d('noto-sans-bengali')).toEqual({ weight: '100 900', stretch: '62.5% 100%' })
    expect(d('anek-bangla').stretch).toBe('75% 125%')
    expect([0, 1, 2].map((i) => d('poppins', i).weight)).toEqual(['600', '700', '800'])
    expect(d('anton')).toEqual({ weight: '400' })
  })

  it('registers a font as FlownCat-<id>, one face per file, from its bundled URL', async () => {
    const before = fonts.fontGeneration()
    await fonts.loadCatalogFont('poppins')
    const faces = added.filter((f) => f.family === 'FlownCat-poppins')
    expect(faces.map((f) => f.descriptors.weight)).toEqual(['600', '700', '800'])
    expect(faces[0].source).toBe(`url("${BUNDLED_FONT_URLS['poppins-600.woff2']}")`)
    expect(fonts.catalogFontReady('poppins')).toBe(true)
    expect(fonts.fontGeneration()).toBeGreaterThan(before)
  })

  it('reads a downloaded font as bytes from studio-media://assets/, and tries again once it is there', async () => {
    await fonts.loadCatalogFont('noto-sans-jp')
    expect(fonts.catalogFontReady('noto-sans-jp')).toBe(false)
    files.add('studio-media://assets/noto-sans-jp.ttf')
    await fonts.loadCatalogFont('noto-sans-jp')
    expect(fonts.catalogFontReady('noto-sans-jp')).toBe(true)
    expect(added.find((f) => f.family === 'FlownCat-noto-sans-jp')?.source).toBeInstanceOf(ArrayBuffer)
  })
})

describe('prepareCaptionFonts (§6.8)', () => {
  const brand: ProjectFont = { id: 'f1', name: 'Brand', file: 'font-1.ttf' }

  it('waits for the catalogue faces and the FlownFontW- face of a brand font in a Studio look', async () => {
    files.add('studio-media://project/pw/font-1.ttf')
    let open = (): void => {}
    gates.set('studio-media://project/pw/font-1.ttf', new Promise<void>((r) => (open = r)))
    const studio = { ...look('subtitle'), text: { ...look('subtitle').text, font: 'f1' } }
    const p = withStudio(studio, { id: 'pw', fonts: [brand] })
    let done = false
    const prepared = fonts.prepareCaptionFonts(p).then(() => (done = true))
    for (let i = 0; i < 5; i++) await settle()
    expect(done).toBe(false)
    open()
    await prepared
    expect(added.some((f) => f.family === 'FlownFontW-f1')).toBe(true)
    for (const id of fonts.catalogFontsFor(p)) expect(fonts.catalogFontReady(id), id).toBe(true)
    // The brand face of a Studio look counts as a used font for the export's waits and notes.
    expect(fonts.usedFontIds(p)).toEqual(['f1'])
  })

  it('removes the FlownFontW- faces when another project opens, and keeps the catalogue faces', async () => {
    deleted.length = 0
    files.add('studio-media://project/px/font-1.ttf')
    const studio = { ...look('subtitle'), text: { ...look('subtitle').text, font: 'f1' } }
    await fonts.prepareCaptionFonts(withStudio(studio, { id: 'px', fonts: [brand] }))
    expect(deleted.map((f) => f.family)).toContain('FlownFontW-f1')
    expect(deleted.some((f) => f.family.startsWith('FlownCat-'))).toBe(false)
  })

  it('registers no FlownFontW- face for a legacy look with a brand font', async () => {
    files.add('studio-media://project/pl/font-1.ttf')
    const p = project({ id: 'pl', fonts: [brand] })
    p.captions = { ...p.captions!, font: 'f1' }
    const count = added.filter((f) => f.family === 'FlownFontW-f1').length
    await fonts.prepareCaptionFonts(p)
    await fonts.prepareProjectFonts(p)
    expect(added.filter((f) => f.family === 'FlownFontW-f1').length).toBe(count)
    expect(added.some((f) => f.family === 'FlownFont-f1')).toBe(true)
  })

  it('never rejects: a face that fails is reported missing and the next font draws', async () => {
    broken.add('FlownCat-bangers')
    broken.add('FlownFontW-f2')
    const studio = { ...look('comic'), emphasis: { ...look('comic').emphasis, font: 'f2' } }
    const p = withStudio(studio, { id: 'pb', fonts: [{ id: 'f2', name: 'Gone', file: 'font-2.ttf' }], transcript: { language: 'ja', segments: [{ id: 'c1', start: 0, end: 1, text: '書き出す' }] } } as Partial<Project>)
    await expect(fonts.prepareCaptionFonts(p)).resolves.toBeUndefined()
    await settle()
    const missing = fonts.missingCatalogFonts(p).map((f) => f.id)
    expect(missing).toContain('bangers')
    // The Japanese font is downloaded above; Korean is not, so a Korean project names it.
    const ko = withStudio(STUDIO_BASE as CaptionStudio, { id: 'pk', transcript: { language: 'ko', segments: [{ id: 'c1', start: 0, end: 1, text: '안녕하세요' }] } } as Partial<Project>)
    await fonts.prepareCaptionFonts(ko)
    expect(fonts.missingCatalogFonts(ko).map((f) => f.id)).toEqual(['noto-sans-kr'])
  })

  it("names them in the export dialog's notes: a download not made with the Windows font drawn instead (§2.13)", async () => {
    broken.add('FlownCat-bangers')
    const ko = withStudio(STUDIO_BASE as CaptionStudio, { id: 'pn', transcript: { language: 'ko', segments: [{ id: 'c1', start: 0, end: 1, text: '안녕하세요' }] } } as Partial<Project>)
    expect(await fonts.missingCatalogNotes(ko)).toEqual(['Captions use Noto Sans KR, which is not downloaded: they will use Malgun Gothic.'])
    // A bundled file that fails to load is named too.
    expect(await fonts.missingCatalogNotes(withStudio(look('comic'), { id: 'pc' }))).toContain('Font missing: Bangers. Text that uses it is drawn with another font.')
    // An old project on a legacy look needs no catalogue font.
    expect(await fonts.missingCatalogNotes(project({ id: 'po' }))).toEqual([])
  })

  it('names no font that only the captions use while Show captions is off (§2.13)', async () => {
    const ko = withStudio(STUDIO_BASE as CaptionStudio, { id: 'ph', transcript: { language: 'ko', segments: [{ id: 'c1', start: 0, end: 1, text: '안녕하세요' }] } } as Partial<Project>)
    const hidden = { ...ko, captions: { ...ko.captions!, show: false } }
    expect(await fonts.missingCatalogNotes(hidden)).toEqual([])
    // Still loaded: graphics made from the captions are placed by their words.
    expect(fonts.catalogFontsFor(hidden)).toContain('noto-sans-kr')
    // A graphic that draws Korean still names it.
    expect(await fonts.missingCatalogNotes({ ...hidden, graphics: [keyword({ text: '안녕' })] })).toEqual(['Captions use Noto Sans KR, which is not downloaded: they will use Malgun Gothic.'])
  })
})
