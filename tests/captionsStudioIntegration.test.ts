import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calls, canvas, contextOf, frameOf, spriteTexts } from './studioFakes'
import { studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionSegment, CaptionSettings, CaptionStudio, CounterGraphic, CursorTrack, ListGraphic, Project, StudioPosition, TitleCard } from '../src/shared/types'

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
const { drawStudioCaptions, drawStudioSample, studioBlockAt } = (await import(/* @vite-ignore */ `${R}studioLayer`)) as {
  drawStudioCaptions: Draw
  drawStudioSample: (ctx: unknown, studio: CaptionStudio, frame: { w: number; h: number }, tile: { w: number; h: number }, t: number, language?: string) => { textPx: number }
  studioBlockAt: (ctx: unknown, p: Project, t: number, w: number, h: number) => { box: { y: number; h: number } } | null
}
const { drawGraphicsLayer } = (await import(/* @vite-ignore */ `${R}graphicsLayer`)) as { drawGraphicsLayer: Draw }
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
