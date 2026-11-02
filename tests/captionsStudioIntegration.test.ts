import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calls, canvas, contextOf, frameOf, sets, spriteTexts } from './studioFakes'
import { studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionSegment, CaptionSettings, CaptionStudio, CounterGraphic, CursorTrack, KeywordGraphic, ListGraphic, Project, StudioPosition, TitleCard } from '../src/shared/types'

/*
 * Captions Studio after the parts merged (docs/design/captions-studio.md §14.5): the drawing (P2)
 * on the real layout, motion, fonts and colours (P1) and caption tracks (P4), with no stand-ins.
 * The parts' own tests replace each other's functions with hand-made values; these check the seams
 * between them: the Digits choice of §0.2 reaching captions, counters, list numbers and chapter
 * titles; the gallery's Bangla sample (P3's language argument, P2's drawing); and key presses
 * keeping clear of a block P1 really placed (test 54).
 */

vi.stubGlobal('document', { createElement: () => canvas(), fonts: { add() {}, delete() {}, check: () => true } })
vi.stubGlobal(
  'FontFace',
  class {
    constructor(public family: string) {}
    async load(): Promise<unknown> {
      return this
    }
  }
)
vi.stubGlobal('Path2D', class {})
vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }))
vi.spyOn(console, 'warn').mockImplementation(() => {})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const R = '../src/renderer/src/render/'
type Draw = (fc: never) => void
const { drawStudioCaptions, drawStudioSample, studioBlockAt, studioWordChunk } = (await import(/* @vite-ignore */ `${R}studioLayer`)) as {
  drawStudioCaptions: Draw
  drawStudioSample: (ctx: unknown, studio: CaptionStudio, frame: { w: number; h: number }, tile: { w: number; h: number }, t: number, language?: string) => { textPx: number }
  studioBlockAt: (ctx: unknown, p: Project, t: number, w: number, h: number) => { box: { y: number; h: number } } | null
  studioWordChunk: (ctx: unknown, p: Project, caption: string, word: number, w: number, h: number, area: null) => { start: number; end: number } | null
}
const { drawGraphicsLayer, graphicRects, graphicShown } = (await import(/* @vite-ignore */ `${R}graphicsLayer`)) as {
  drawGraphicsLayer: Draw
  graphicRects: (ctx: unknown, p: Project, t: number, w: number, h: number) => { id: string; rect: { x: number; y: number; w: number; h: number } }[]
  graphicShown: (p: Project, g: KeywordGraphic, size?: { width: number; height: number }) => { start: number; end: number }
}
const EDITOR = '../src/renderer/src/editor/'
const { showGraphic } = (await import(/* @vite-ignore */ `${EDITOR}graphicItems`)) as { showGraphic: (player: { time: number; seek(t: number): void }, p: Project, g: KeywordGraphic) => void }
const { drawTitleCardsLayer } = (await import(/* @vite-ignore */ `${R}titleCardLayer`)) as { drawTitleCardsLayer: Draw }
const { drawKeystrokes } = (await import(/* @vite-ignore */ `${R}textOverlays`)) as { drawKeystrokes: (ctx: unknown, w: number, h: number, t: number, p: Project, cursor: CursorTrack) => void }
const { captionBlockAt } = (await import(/* @vite-ignore */ `${R}captionsLayer`)) as { captionBlockAt: (ctx: unknown, p: Project, t: number, w: number, h: number) => { position: string } | null }
const { STUDIO_SPRITES } = (await import(/* @vite-ignore */ `${R}wordSprites`)) as { STUDIO_SPRITES: { clear(): void } }

const look = (id: string): CaptionStudio => ({ ...structuredClone(studioPreset(id)!.look), from: id })
const LEGACY: CaptionSettings = { show: true, preset: 'clean', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#ffe14d', background: 'shadow', maxLines: 2 }

function project(segments: CaptionSegment[], language: string, captions: Partial<CaptionSettings>, over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    clips: [{ id: 'c0', start: 0, end: 10, speed: 1 }],
    fonts: [],
    annotations: [],
    titles: [],
    webcam: { show: false },
    style: { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' },
    transcript: { language, segments },
    captions: { ...LEGACY, ...captions },
    ...over
  } as unknown as Project
}

/** Every text painted (on the frame or into a sprite), in order. */
const painted = (): string[] => [...spriteTexts().values()].flat()
/** The characters drawn on the frame canvas one by one (a counter's digits are). */
const frameChars = (id: number): string => calls.filter((c) => c.canvas === id && c.name === 'fillText').map((c) => String(c.args[0])).join('')

beforeEach(() => {
  calls.length = 0
  STUDIO_SPRITES.clear()
})

describe('the Digits choice reaches every place §0.2 names (captions, counters, list numbers, chapter titles)', () => {
  const C: CaptionSegment = { id: 'c1', start: 0.5, end: 3, text: 'মোট 300 জন এসেছেন' }

  it('a Studio caption writes its digits in Bangla when the captions ask for them', () => {
    const p = project([C], 'bn', { preset: 'bold', studio: look('bold-pop'), digits: 'native' })
    drawStudioCaptions(frameOf(p, 1.5).fc)
    const texts = painted().join(' ')
    expect(texts).toContain('৩০০')
    expect(texts).not.toContain('300')
  })

  it('and for Bangla captions whose transcript names no language, as the Digits control offers it', () => {
    const p = project([C], undefined as unknown as string, { preset: 'bold', studio: look('bold-pop'), digits: 'native' })
    drawStudioCaptions(frameOf(p, 1.5).fc)
    const texts = painted().join(' ')
    expect(texts).toContain('৩০০')
    expect(texts).not.toContain('300')
  })

  it('and as written without the choice (the identity for every project before it)', () => {
    const p = project([C], 'bn', { preset: 'bold', studio: look('bold-pop') })
    drawStudioCaptions(frameOf(p, 1.5).fc)
    expect(painted().join(' ')).toContain('300')
  })

  const counter = (over: Partial<CounterGraphic> = {}): CounterGraphic =>
    ({
      id: 'n1',
      kind: 'counter',
      start: 1,
      end: 6,
      place: 'auto',
      size: 0.11,
      from: 0,
      to: 300,
      decimals: 0,
      prefix: '',
      suffix: '%',
      locale: 'bn',
      countFor: 1,
      enter: { kind: 'none', duration: 0.3, strength: 1 },
      exit: { kind: 'none', duration: 0.3, strength: 1 },
      ...over
    }) as CounterGraphic

  it('a counter in a Bangla project counts in Western digits when the captions ask for them', () => {
    const p = project([C], 'bn', { preset: 'bold', studio: look('bold-pop'), digits: 'western' }, { graphics: [counter()] } as Partial<Project>)
    const { fc, id } = frameOf(p, 4)
    drawGraphicsLayer(fc)
    const drawn = frameChars(id)
    expect(drawn).toContain('300')
    expect(drawn).not.toMatch(/[০-৯]/u)
  })

  it('a list card numbers its items in Devanagari for Hindi captions with native digits', () => {
    const list = {
      id: 'l1',
      kind: 'list',
      start: 1,
      end: 8,
      place: 'auto',
      size: 0.05,
      items: [
        { text: 'पहला', at: 1.2 },
        { text: 'दूसरा', at: 1.4 }
      ],
      enter: { kind: 'none', duration: 0.3, strength: 1 },
      exit: { kind: 'none', duration: 0.3, strength: 1 }
    } as unknown as ListGraphic
    const p = project([{ id: 'c1', start: 0.5, end: 3, text: 'तीन कदम' }], 'hi', { preset: 'clean', studio: look('subtitle'), digits: 'native' }, { graphics: [list] } as Partial<Project>)
    drawGraphicsLayer(frameOf(p, 4).fc)
    const texts = [...painted(), ...calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))].join(' ')
    expect(texts).toMatch(/१/u)
    expect(texts).not.toMatch(/(^|\s)1\.?(\s|$)/u)
  })

  const chapterCard = (title: string, auto = true): TitleCard => ({
    id: 't1',
    start: 1,
    end: 4,
    title,
    style: 'lower-third',
    background: 'blur',
    ...(auto ? { auto: { by: 'chapter', via: 'rules', chapter: 'ch2' } } : {})
  })

  it('a chapter title made from the chapters writes its digits in the captions’ choice', () => {
    const p = project([C], 'bn', { preset: 'bold', studio: look('bold-pop'), digits: 'native' }, { titles: [chapterCard('অধ্যায় 2')] })
    drawTitleCardsLayer(frameOf(p, 2.5).fc)
    const texts = [...painted(), ...calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))].join(' ')
    expect(texts).toContain('অধ্যায় ২')
  })

  it('a title the user typed keeps its digits', () => {
    const p = project([C], 'bn', { preset: 'bold', studio: look('bold-pop'), digits: 'native' }, { titles: [chapterCard('Step 2', false)] })
    drawTitleCardsLayer(frameOf(p, 2.5).fc)
    const texts = [...painted(), ...calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))].join(' ')
    expect(texts).toContain('Step 2')
  })
})

describe('the spoken word on P1’s poses (WordPose.fill is the spoken colour’s share; mark is the emphasis mark’s)', () => {
  const C1: CaptionSegment = {
    id: 'c1',
    start: 0.5,
    end: 3,
    text: 'Make every word count today',
    words: [
      { text: 'Make', start: 0.5, end: 0.9 },
      { text: 'every', start: 1.0, end: 1.4 },
      { text: 'word', start: 1.5, end: 1.9 },
      { text: 'count', start: 2.0, end: 2.4 },
      { text: 'today', start: 2.5, end: 2.9 }
    ]
  }
  /** The texts painted in `colour` (the lit sprites of the spoken word). */
  const paintedIn = (colour: string): string[] => calls.filter((c) => c.name === 'fillText' && String(c.fill).toLowerCase() === colour).map((c) => String(c.args[0]))

  for (const [id, colour] of [
    ['bold-pop', '#39e508'],
    ['neon', null]
  ] as const)
    it(`${id}: the word being spoken is drawn lit, and the words around it are not`, () => {
      const studio = look(id)
      const spoken = (colour ?? studio.theme.spoken).toLowerCase()
      const p = project([C1], 'en', { preset: 'bold', studio })
      drawStudioCaptions(frameOf(p, 1.2, 1080, 1920).fc)
      const lit = paintedIn(spoken).map((t) => t.toLowerCase())
      expect(lit).toContain('every')
      expect(lit).not.toContain('make')
    })

  it('spotlight-word: the word being spoken is lit and bigger, the words said stay full white, the words to come are dimmed (§0.1)', () => {
    drawStudioCaptions(frameOf(project([C1], 'en', { preset: 'bold', studio: look('spotlight-word') }), 1.2, 1080, 1920).fc)
    const size = (word: string): number => Math.max(...calls.filter((c) => c.name === 'fillText' && c.args[0] === word).map((c) => parseFloat(/([\d.]+)px/.exec(String(c.font))![1])))
    expect(size('every')).toBeGreaterThan(size('Make') * 1.2)
    expect(paintedIn('#ffffff')).toContain('Make')
    expect(paintedIn('#9a9a9a')).not.toContain('Make')
    expect(paintedIn('#9a9a9a')).toContain('word')
    expect(paintedIn('#ffffff')).not.toContain('word')
  })
})

describe('the gallery’s Bangla sample (§0.2: tiles show Bangla text when the captions are Bangla)', () => {
  it('draws the approved Bangla sentence in the look’s Bangla font, and English otherwise', () => {
    const ctx = contextOf(canvas(136, 96))
    drawStudioSample(ctx, look('bold-pop'), { w: 1920, h: 1080 }, { w: 136, h: 96 }, 1.0, 'bn')
    const bangla = painted().join(' ')
    expect(bangla).toMatch(/[ঀ-৿]/u)
    expect(bangla).not.toMatch(/MAKE|Make/)
    // Bold Pop's Bangla font is Baloo Da 2 (§0.2).
    expect(calls.some((c) => c.name === 'fillText' && /[ঀ-৿]/u.test(String(c.args[0])) && String(c.font).includes('baloo-da-2'))).toBe(true)
    calls.length = 0
    STUDIO_SPRITES.clear()
    drawStudioSample(contextOf(canvas(136, 96)), look('bold-pop'), { w: 1920, h: 1080 }, { w: 136, h: 96 }, 1.0, 'en')
    expect(painted().join(' ')).toMatch(/MAKE|EVERY|WORD/)
  })
})

describe('Bangla edges (§0.2: outlines about 0.08 em, thinner than Latin, with a soft shadow)', () => {
  const caption = (text: string): CaptionSegment => ({ id: 'b1', start: 0.5, end: 3, text })
  /** Each sprite painted with `word`: its outline's width per em of its font (0 without one), and whether it casts a blurred shadow. */
  const edges = (word: string): { outline: number; shadow: boolean }[] => {
    const texts = spriteTexts()
    return [...texts.keys()]
      .filter((id) => texts.get(id)![0] === word)
      .map((id) => {
        const em = parseFloat(/([\d.]+)px/.exec(String(calls.find((c) => c.canvas === id && c.name === 'fillText')!.font))![1])
        const widths = sets.filter((s) => s.canvas === id && s.name === 'lineWidth').map((s) => Number(s.value))
        return { outline: widths.length ? Math.max(...widths) / em : 0, shadow: sets.some((s) => s.canvas === id && s.name === 'shadowBlur' && Number(s.value) > 0) }
      })
  }

  it('a mixed word (Windows-এ) takes the thin Bangla outline, as the Bangla word beside it does', () => {
    sets.length = 0
    const p = project([caption('Windows-এ Chrome খুলুন')], 'bn', { preset: 'bold', studio: look('bold-pop') })
    // Bold Pop shows a few words at a time: the first chunk, then the one with খুলুন.
    for (const t of [1, 2.8]) drawStudioCaptions(frameOf(p, t).fc)
    for (const word of ['WINDOWS-এ', 'খুলুন']) {
      expect(edges(word).length, word).toBeGreaterThan(0)
      for (const e of edges(word)) expect(e.outline, word).toBeCloseTo(0.08, 3)
    }
    // An English word keeps Bold Pop's 0.085 em outline.
    expect(edges('CHROME').length).toBeGreaterThan(0)
    for (const e of edges('CHROME')) expect(e.outline).toBeCloseTo(0.17, 3)
  })

  it('Bangla in a look without a shadow (Circle) gets a soft shadow with its thinner outline; English keeps none', () => {
    sets.length = 0
    const p = project([caption('আমরা আজ শিখব')], 'bn', { studio: look('circle') })
    for (const t of [1, 2.8]) drawStudioCaptions(frameOf(p, t).fc)
    for (const word of ['আমরা', 'শিখব']) {
      expect(edges(word).length, word).toBeGreaterThan(0)
      for (const e of edges(word)) expect(e, word).toEqual({ outline: expect.closeTo(0.08, 3), shadow: true })
    }
    calls.length = 0
    sets.length = 0
    STUDIO_SPRITES.clear()
    drawStudioCaptions(frameOf(project([caption('We learn today')], 'en', { studio: look('circle') }), 1.5).fc)
    expect(edges('learn').length).toBeGreaterThan(0)
    for (const e of edges('learn')) expect(e).toEqual({ outline: expect.closeTo(0.14, 3), shadow: false })
  })
})

describe('key presses keep clear of a block P1 placed (test 54 on the real layout)', () => {
  const keys = { valid: true, samples: [], clicks: [], keys: [{ t: 1.0, label: 'Ctrl+S' }] } as unknown as CursorTrack
  for (const id of ['editorial', 'bold-pop', 'subtitle'])
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920]
    ])
      for (const position of ['lower', 'bottom'] as StudioPosition[])
        it(`${id} at ${position} in ${w}x${h}`, () => {
          const studio = look(id)
          studio.layout.position = position
          const p = project([{ id: 'c1', start: 0.5, end: 3, text: 'Open the export dialog and save' }], 'en', { preset: 'boxed', studio }, { effects: { keystrokes: { show: true, position: 'bottom', size: 0.035 } } } as Partial<Project>)
          const c = canvas(w, h)
          const ctx = contextOf(c)
          expect(captionBlockAt(ctx, p, 1.3, w, h)!.position).toBe('bottom')
          drawKeystrokes(ctx, w, h, 1.3, p, keys)
          const pill = calls.find((k) => k.canvas === c.id && k.name === 'roundRect')!
          const [, y, , ph] = pill.args as number[]
          const { box } = studioBlockAt(ctx, p, 1.3, w, h)!
          expect(box.y).toBeGreaterThanOrEqual(0)
          expect(box.y + box.h).toBeLessThanOrEqual(h)
          expect(y + ph <= box.y || y >= box.y + box.h).toBe(true)
        })
})

describe('the flash rule keeps a merged block inside the frame (§9.6 rule 2 on the real layout)', () => {
  // Fast speech on a sped-up clip: big chunks under 0.34 s of viewing time merge until they show long enough.
  const text = 'open the settings panel and choose export then pick the format you need and save it to your videos folder today'
  const step = 1 / 3
  const words = text.split(' ').map((t, i) => ({ text: t, start: 0.5 + i * step, end: 0.5 + i * step + step * 0.8 }))
  const seg: CaptionSegment = { id: 'c1', start: 0.5, end: 0.5 + words.length * step, text, words }
  for (const [id, position] of [
    ['one-word', 'middle'],
    ['one-word', 'lower'],
    ['stacked', 'middle']
  ] as const)
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
      [1080, 1080]
    ])
      it(`${id} at ${position} on a 4x clip in ${w}x${h}`, () => {
        const studio = look(id)
        studio.layout.position = position
        const p = project([seg], 'en', { preset: 'bold', studio }, { clips: [{ id: 'c0', start: 0, end: 20, speed: 4 }] } as Partial<Project>)
        const ctx = contextOf(canvas(w, h))
        let blocks = 0
        for (let t = seg.start; t < seg.end; t += 0.05) {
          const b = studioBlockAt(ctx, p, t, w, h)
          if (!b) continue
          blocks++
          expect(b.box.y, `top at ${t.toFixed(2)} s`).toBeGreaterThanOrEqual(0)
          expect(b.box.y + b.box.h, `bottom at ${t.toFixed(2)} s`).toBeLessThanOrEqual(h)
        }
        expect(blocks).toBeGreaterThan(0)
      })
})

describe('a keyword card that replaces its chunk shows only while the drawn chunk does (§10.1)', () => {
  // The planner times a card by its own estimate of the chunks; the look draws them with the real font.
  const text = 'open the settings panel and choose the export tab'
  const words = text.split(' ').map((t, i) => ({ text: t, start: 0.5 + i * 0.4, end: 0.5 + i * 0.4 + 0.3 }))
  const seg: CaptionSegment = { id: 'c1', start: 0.5, end: 0.5 + words.length * 0.4, text, words }
  const card: KeywordGraphic = {
    id: 'k1',
    kind: 'keyword',
    start: seg.start,
    end: seg.end,
    place: 'auto',
    size: 0.09,
    text: 'export',
    look: 'card',
    enter: { kind: 'pop', duration: 0.24, strength: 1 },
    exit: { kind: 'fade', duration: 0.18, strength: 1 },
    anchor: { caption: 'c1', from: 7, to: 7, text: 'export' }
  }
  const drawsOn = (draw: Draw, p: Project, t: number, w: number, h: number): boolean => {
    const { fc, id } = frameOf(p, t, w, h)
    draw(fc)
    return calls.some((c) => c.canvas === id && c.name === 'drawImage')
  }
  for (const [w, h] of [
    [1080, 1920],
    [1920, 1080]
  ])
    it(`Bold Pop in ${w}x${h}: never over the chunk before, and that chunk hidden only while it shows`, () => {
      const p = project([seg], 'en', { preset: 'bold', studio: look('bold-pop') }, { graphics: [card] } as Partial<Project>)
      const chunk = studioWordChunk(contextOf(canvas(w, h)), p, 'c1', 7, w, h, null)!
      expect(chunk.start).toBeGreaterThan(seg.start + 0.5)
      // Before the chunk holding EXPORT: its own chunk shows and no card covers it.
      const before = chunk.start - 0.1
      expect(drawsOn(drawGraphicsLayer, p, before, w, h)).toBe(false)
      expect(drawsOn(drawStudioCaptions, p, before, w, h)).toBe(true)
      // While it shows: the card, and not the chunk it replaces.
      const during = Math.min(chunk.start + 0.3, (chunk.start + chunk.end) / 2)
      expect(drawsOn(drawGraphicsLayer, p, during, w, h)).toBe(true)
      expect(drawsOn(drawStudioCaptions, p, during, w, h)).toBe(false)
    })

  for (const [w, h] of [
    [1080, 1920],
    [1920, 1080]
  ])
    it(`Bold Pop in ${w}x${h}: a click on the card's block shows it, and a card moved off its chunk shows at its own time, free`, () => {
      const at = (start: number, end: number): Project => project([seg], 'en', { preset: 'bold', studio: look('bold-pop') }, { graphics: [{ ...card, start, end }], width: w, height: h } as Partial<Project>)
      const p = at(card.start, card.end)
      const chunk = studioWordChunk(contextOf(canvas(w, h)), p, 'c1', 7, w, h, null)!
      expect(graphicShown(p, card, { width: w, height: h })).toEqual({ start: chunk.start, end: chunk.end })
      // A click on its block (or its row in the Graphics tab) moves the playhead to where it shows.
      const player = { time: 0, seek(t: number): void { this.time = t } }
      showGraphic(player, p, card)
      expect(player.time).toBeGreaterThanOrEqual(chunk.start)
      expect(player.time).toBeLessThan(chunk.end)
      expect(drawsOn(drawGraphicsLayer, p, player.time, w, h)).toBe(true)
      // Dragged on the Graphics row before its word's chunk, or after the caption: drawn at its own time.
      for (const [start, end] of [
        [0.6, 2],
        [chunk.end + 2, chunk.end + 4]
      ]) {
        const moved = at(start, end)
        const shown: number[] = []
        for (let t = 0; t < 9; t += 0.05) if (drawsOn(drawGraphicsLayer, moved, t, w, h)) shown.push(t)
        expect(shown.length, `moved to ${start}-${end} s`).toBeGreaterThan(0)
        expect(Math.min(...shown)).toBeGreaterThanOrEqual(start)
        expect(Math.max(...shown)).toBeLessThan(end)
        expect(graphicShown(moved, moved.graphics![0] as KeywordGraphic, { width: w, height: h })).toEqual({ start, end })
      }
      // It replaces nothing there: the caption shows with it, and the card keeps clear of its block.
      const moved = at(0.6, 2)
      expect(drawsOn(drawStudioCaptions, moved, 1.5, w, h)).toBe(true)
      const rect = graphicRects(contextOf(canvas(w, h)), moved, 1.5, w, h)[0].rect
      const block = studioBlockAt(contextOf(canvas(w, h)), moved, 1.5, w, h)!.box
      expect(rect.y + rect.h <= block.y || rect.y >= block.y + block.h).toBe(true)
    })
})
