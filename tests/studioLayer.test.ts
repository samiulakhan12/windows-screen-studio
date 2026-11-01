import { beforeEach, describe, expect, it, vi } from 'vitest'
import { studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionSegment, CaptionSettings, CaptionStudio, Graphic, Project } from '../src/shared/types'
import { calls, canvas, contextOf, frameOf, gradientStops, hooks, idleWord, IDLE_CHUNK, sets, spriteTexts } from './studioFakes'

/*
 * The Captions Studio caption layer (docs/design/captions-studio.md §9.7, tests 23, 50 and 51) on
 * recording canvases, against hand-made layouts and poses for the parts it calls (§14.2): words
 * are sprites drawn with transforms, at whole pixels at rest; the frame's filter is never set;
 * News Bar's outgoing chunk only during its push; the legacy branch's three guarded calls, and
 * what they change when they do not return their input.
 */

vi.mock('../src/shared/captions/studioLayout', async () => (await import('./studioFakes')).fakeStudioLayout)
vi.mock('../src/shared/captions/motion', async () => (await import('./studioFakes')).fakeMotion)
vi.mock('../src/shared/captions/replaced', async () => (await import('./studioFakes')).fakeReplaced)
vi.mock('../src/shared/captions/captionTracks', async (original) => (await import('./studioFakes')).fakeCaptionTracks(await original()))
vi.mock('../src/shared/captions/fontStack', async () => (await import('./studioFakes')).fakeFontStack)
vi.mock('../src/shared/captions/colors', async () => (await import('./studioFakes')).fakeColors)
vi.mock('../src/shared/captions/marks', async () => (await import('./studioFakes')).fakeMarks)
vi.mock('../src/shared/captions/words', async (original) => ({ ...(await original()), ...(await import('./studioFakes')).fakeWords }))
vi.mock('../src/shared/render/actionRects', async () => (await import('./studioFakes')).fakeActionRects)
vi.mock('../src/shared/render/graphics', async (original) => (await import('./studioFakes')).fakeGraphics(await original()))

vi.stubGlobal('document', { createElement: () => canvas(), fonts: { add() {}, delete() {} } })
vi.stubGlobal(
  'FontFace',
  class {
    constructor(public family: string) {}
    async load(): Promise<unknown> {
      return this
    }
  }
)
/** URLs fetched (downloads read through studio-media://assets/; none is on this PC). */
const fetched: string[] = []
vi.stubGlobal('fetch', async (url: string) => {
  fetched.push(url)
  return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
})
vi.spyOn(console, 'warn').mockImplementation(() => {})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const LAYER = '../src/renderer/src/render/captionsLayer'
const STUDIO = '../src/renderer/src/render/studioLayer'
const GRAPHICS = '../src/renderer/src/render/graphicsLayer'
const SPRITES = '../src/renderer/src/render/wordSprites'
type Draw = (fc: never) => void
const { drawCaptionsLayer, captionBlockAt } = (await import(/* @vite-ignore */ LAYER)) as { drawCaptionsLayer: Draw; captionBlockAt: (ctx: unknown, p: Project, t: number, w: number, h: number) => { position: string; top: number; bottom: number } | null }
const { drawStudioCaptions, drawStudioSample, SAMPLE_STILL_T } = (await import(/* @vite-ignore */ STUDIO)) as {
  drawStudioCaptions: Draw
  drawStudioSample: (ctx: unknown, studio: CaptionStudio, frame: { w: number; h: number }, tile: { w: number; h: number }, t: number) => { textPx: number }
  SAMPLE_STILL_T: number
}
const { fontGeneration, loadCatalogFont } = (await import(/* @vite-ignore */ `${'../src/renderer/src/render/'}fontLoader`)) as { fontGeneration(): number; loadCatalogFont(id: string): Promise<void> }
const { drawGraphicsLayer } = (await import(/* @vite-ignore */ GRAPHICS)) as { drawGraphicsLayer: Draw }
const { STUDIO_SPRITES } = (await import(/* @vite-ignore */ SPRITES)) as { STUDIO_SPRITES: { clear(): void } }

const actual = await vi.importActual<typeof import('../src/shared/captions/captionTracks')>('../src/shared/captions/captionTracks')
const actualReplaced = await vi.importActual<typeof import('../src/shared/captions/replaced')>('../src/shared/captions/replaced')

const look = (id: string): CaptionStudio => structuredClone(studioPreset(id)!.look)

const LEGACY: CaptionSettings = { show: true, preset: 'clean', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#ffe14d', background: 'shadow', maxLines: 2 }

const C1: CaptionSegment = {
  id: 'c1',
  start: 0.5,
  end: 3,
  text: 'Make every word count today',
  words: [
    { text: 'Make', start: 0.5, end: 0.9 },
    { text: 'every', start: 1, end: 1.4 },
    { text: 'word', start: 1.5, end: 1.9 },
    { text: 'count', start: 2, end: 2.4 },
    { text: 'today', start: 2.5, end: 2.9 }
  ]
}

function project(captions: CaptionSettings, over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    clips: [{ start: 0, end: 10, speed: 1 }],
    fonts: [],
    annotations: [],
    titles: [],
    webcam: { show: false },
    transcript: { language: 'en', segments: [C1] },
    captions,
    ...over
  } as unknown as Project
}

const studioProject = (studio: CaptionStudio, over: Partial<Project> = {}): Project => project({ ...LEGACY, studio }, over)

/** The calls made on the frame canvas. */
const onFrame = (id: number): typeof calls => calls.filter((c) => c.canvas === id)

/** The words of each sprite the frame drew (sprites are canvases painted once with their word). */
function drawnWords(id: number): string[] {
  const texts = spriteTexts()
  return onFrame(id)
    .filter((c) => c.name === 'drawImage')
    .map((c) => texts.get((c.args[0] as { id: number }).id)?.[0] ?? '')
    .filter(Boolean)
}

beforeEach(() => {
  calls.length = 0
  sets.length = 0
  hooks.log.length = 0
  hooks.poses = undefined
  hooks.replaced = undefined
  hooks.burned = undefined
  hooks.place = undefined
  STUDIO_SPRITES.clear()
})

describe('the Studio layer draws word sprites (test 23)', () => {
  it('draws the words of the chunk as sprites, never text on the frame', () => {
    const { fc, id } = frameOf(studioProject(look('bold-pop')), 1.2)
    drawCaptionsLayer(fc)
    expect(onFrame(id).some((c) => c.name === 'fillText' || c.name === 'strokeText')).toBe(false)
    expect(drawnWords(id)).toEqual(['MAKE', 'EVERY', 'WORD'])
  })

  it('draws a moving word with its pose as a transform', () => {
    hooks.poses = (layout, chunk) => {
      const c = layout.chunks[chunk]
      return { chunk: IDLE_CHUNK, words: [{ ...idleWord(c.first), scale: 1.2, rotate: 5, dy: -8 }, idleWord(c.first + 1), idleWord(c.first + 2)], mark: null }
    }
    const { fc, id } = frameOf(studioProject(look('bold-pop')), 1.2)
    drawStudioCaptions(fc)
    const texts = spriteTexts()
    const make = onFrame(id).find((c) => c.name === 'drawImage' && texts.get((c.args[0] as { id: number }).id)?.[0] === 'MAKE')!
    const [a, b] = make.matrix
    expect(Math.hypot(a, b)).toBeCloseTo(1.2, 5)
    expect(Math.atan2(b, a)).toBeCloseTo((5 * Math.PI) / 180, 5)
    // Scaled from its sprite, so its position is not rounded to whole pixels.
    expect(make.args.length).toBe(5)
  })

  it('draws words at rest at whole pixels, untransformed', () => {
    const { fc, id } = frameOf(studioProject(look('subtitle')), 1.2)
    drawStudioCaptions(fc)
    const images = onFrame(id).filter((c) => c.name === 'drawImage')
    expect(images.length).toBe(5)
    for (const c of images) {
      expect(c.args.length).toBe(3)
      expect(Number.isInteger(c.args[1]) && Number.isInteger(c.args[2])).toBe(true)
      expect(c.matrix).toEqual([1, 0, 0, 1, 0, 0])
    }
  })

  it('keys sprites by content: the same word in the same state is painted once, a changed state again', () => {
    const p = studioProject(look('bold-pop'))
    drawStudioCaptions(frameOf(p, 1.2).fc)
    const painted = (): number => calls.filter((c) => c.name === 'fillText' && c.args[0] === 'EVERY').length
    const first = painted()
    drawStudioCaptions(frameOf(p, 1.25).fc)
    expect(painted()).toBe(first)
    // At 1.6 "EVERY" is no longer spoken: its base sprite is cached, nothing is painted for it.
    drawStudioCaptions(frameOf(p, 1.6).fc)
    expect(painted()).toBe(first)
  })

  it('never sets a filter on the frame: blur draws pre-blurred sprites made on their own canvases', () => {
    hooks.poses = (layout, chunk) => {
      const c = layout.chunks[chunk]
      return { chunk: { ...IDLE_CHUNK, blur: 3 }, words: [{ ...idleWord(c.first), blur: 6 }, idleWord(c.first + 1), idleWord(c.first + 2)], mark: null }
    }
    const { fc, id } = frameOf(studioProject(look('bold-pop')), 1.2)
    drawStudioCaptions(fc)
    expect(sets.filter((s) => s.canvas === id && s.name === 'filter')).toEqual([])
    expect(sets.some((s) => s.canvas !== id && s.name === 'filter' && String(s.value).startsWith('blur('))).toBe(true)
  })

  it('draws News Bar’s outgoing chunk during its push, under one band, and never after', () => {
    const news = look('news')
    news.layout = { ...news.layout, chunk: 'words', words: 3 }
    const p = studioProject(news)
    // The second chunk starts at 2.0 (count today); the push lasts 0.2 s.
    hooks.poses = (layout, chunk, t) => {
      const c = layout.chunks[chunk]
      const words = Array.from({ length: c.last - c.first + 1 }, (_, k) => idleWord(c.first + k))
      if (chunk === 1 && t < 2.2) return { chunk: { ...IDLE_CHUNK, dy: 10 * (2.2 - t) }, words, mark: null, out: { chunk: 0, pose: { ...IDLE_CHUNK, dy: -40 * (t - 2) } } }
      return { chunk: IDLE_CHUNK, words, mark: null }
    }
    const during = frameOf(p, 2.1)
    drawStudioCaptions(during.fc)
    expect(drawnWords(during.id)).toEqual(['MAKE', 'EVERY', 'WORD', 'COUNT', 'TODAY'])
    const bands = onFrame(during.id).filter((c) => c.name === 'roundRect')
    expect(bands.length).toBe(1)
    const after = frameOf(p, 2.3)
    drawStudioCaptions(after.fc)
    expect(drawnWords(after.id)).toEqual(['COUNT', 'TODAY'])
  })

  it('keeps Glass Pill’s pill while the next chunk’s words enter, its width gliding from the old line’s (§5.3)', () => {
    const glass = look('glass')
    glass.layout = { ...glass.layout, chunk: 'words', words: 3 }
    const p = studioProject(glass)
    // The pill of a frame: its first rounded rectangle on the frame, and the alpha it is drawn at.
    const pill = (t: number): { w: number; alpha: unknown } | null => {
      calls.length = 0
      const { fc, id } = frameOf(p, t)
      drawStudioCaptions(fc)
      const r = onFrame(id).find((c) => c.name === 'roundRect')
      return r ? { w: r.args[2] as number, alpha: r.alpha } : null
    }
    const old = pill(1.2)!.w
    const next = pill(2.3)!.w
    expect(next).not.toBeCloseTo(old, 3)
    // The second chunk starts at 2.0 (count today): its words enter from alpha 0, the pills do not.
    let reveal = 1
    hooks.poses = (layout, chunk) => {
      const c = layout.chunks[chunk]
      const words = Array.from({ length: c.last - c.first + 1 }, (_, k) => idleWord(c.first + k))
      if (chunk === 0) return { chunk: IDLE_CHUNK, words, mark: null }
      return { chunk: { ...IDLE_CHUNK, alpha: 0 }, words, mark: null, out: { chunk: 0, pose: { ...IDLE_CHUNK, alpha: 0, reveal } }, box: IDLE_CHUNK }
    }
    expect(pill(2)).toEqual({ w: old, alpha: 1 })
    reveal = 0.5
    expect(pill(2.08)!.w).toBeCloseTo((old + next) / 2, 6)
    expect(pill(2.08)!.alpha).toBe(1)
  })

  it('draws a sticker per word, the spoken one in the spoken colour and grown (§0.1 Stickers)', () => {
    const { fc } = frameOf(studioProject(look('stickers')), 1.2)
    drawStudioCaptions(fc)
    const fills = calls.filter((c) => c.name === 'fill').map((c) => c.fill)
    expect(fills).toContain('rgba(255, 210, 63, 1)')
    expect(fills).toContain('rgba(255, 255, 255, 1)')
    // The spoken word's sprite is painted at 1.12x its size.
    const every = calls.find((c) => c.name === 'fillText' && c.args[0] === 'every' && String(c.font).includes(`${0.065 * 1080 * 1.12}px`))
    expect(every).toBeDefined()
  })

  it('draws the spoken sticker’s word in the colour that reads on it when the theme sets none (§7.1)', () => {
    // A theme swapped in: white words, a yellow spoken sticker and no spokenText (withTheme drops it).
    const themed = look('stickers')
    const { spokenText: _t, ...theme } = themed.theme
    void _t
    themed.theme = { ...theme, text: '#ffffff', spoken: '#ffe14d' }
    drawStudioCaptions(frameOf(studioProject(themed), 1.2).fc)
    expect(calls.filter((c) => c.name === 'fill').map((c) => c.fill)).toContain('rgba(255, 225, 77, 1)')
    const every = calls.find((c) => c.name === 'fillText' && c.args[0] === 'every' && String(c.font).includes(`${0.065 * 1080 * 1.12}px`))
    // textOn('#ffe14d'), as the meter judges it; not the white of the words around it.
    expect(every?.fill).toBe('#111111')
    expect(calls.find((c) => c.name === 'fillText' && c.args[0] === 'Make')?.fill).toBe('#ffffff')
  })

  it('gives a Bangla sticker room above for its vowel signs, clear of the border (BANGLA-NOTES)', () => {
    const seg: CaptionSegment = { id: 'b1', start: 0.5, end: 3, text: 'Make কিন্তু', words: [{ text: 'Make', start: 0.5, end: 0.9 }, { text: 'কিন্তু', start: 1, end: 1.4 }] }
    drawStudioCaptions(frameOf(studioProject(look('stickers'), { transcript: { language: 'bn', segments: [seg] } } as Partial<Project>), 2).fc)
    const texts = spriteTexts()
    // The sticker's top edge above the word's middle, in the sprite's em, on each sprite that painted `word` (its shadow sits lower).
    const tops = (word: string): number[] =>
      [...texts.keys()]
        .filter((id) => texts.get(id)![0] === word)
        .map((id) => {
          const on = calls.filter((c) => c.canvas === id)
          const em = parseFloat(/([\d.]+)px/.exec(String(on.find((c) => c.name === 'fillText')!.font))![1])
          return -Math.min(...on.filter((c) => c.name === 'roundRect').map((c) => c.args[1] as number)) / em
        })
    expect(tops('Make').length).toBeGreaterThan(0)
    for (const top of tops('Make')) expect(top).toBeCloseTo(0.62 + 0.07, 6)
    // ি reaches 0.72 em above the middle in Noto Sans Bengali; the 0.1 em border now starts above 0.8.
    expect(tops('কিন্তু').length).toBeGreaterThan(0)
    for (const top of tops('কিন্তু')) expect(top).toBeCloseTo(0.8 + 0.07, 6)
  })

  it('points Speech Bubble’s tail at the camera bubble, and down without one (§0.1)', () => {
    const bubble = look('bubble-speech')
    const camera = { rect: { x: 1600, y: 80, w: 220, h: 220 }, radius: 110, opacity: 1 }
    const tail = (withCam: boolean): { x: number; y: number } => {
      calls.length = 0
      const p = studioProject(bubble, { webcam: { show: withCam } } as Partial<Project>)
      const { fc, id } = frameOf(p, 1.2, 1920, 1080, withCam ? { layout: { screen: { x: 0, y: 0, w: 1920, h: 1080 }, camera, moving: false } } : {})
      drawStudioCaptions(fc)
      const lines = onFrame(id).filter((c) => c.name === 'lineTo')
      return { x: lines[0].args[0] as number, y: lines[0].args[1] as number }
    }
    const down = tail(false)
    const toCam = tail(true)
    // Lower in 1920x1080: the block's centre is at 0.8 H; without a camera the tip is below it.
    expect(down.y).toBeGreaterThan(0.8 * 1080)
    // With the camera at the top right, the tip leaves the bubble toward it (right or up).
    expect(toCam.x > 960 || toCam.y < 0.8 * 1080).toBe(true)
  })

  it('draws Chat’s "You" on the right in its own colour and others on the left (§0.1)', () => {
    const chat = look('chat')
    const segs = [
      { ...C1, speaker: 'You' },
      { ...C1, id: 'c2', start: 3, end: 5, speaker: 'Priya', words: undefined }
    ] as CaptionSegment[]
    const draw = (t: number): { x: number; fill: unknown } => {
      calls.length = 0
      const { fc, id } = frameOf(studioProject(chat, { transcript: { language: 'en', segments: segs } } as Partial<Project>), t)
      drawStudioCaptions(fc)
      const box = onFrame(id).find((c) => c.name === 'roundRect')!
      const fill = onFrame(id).find((c) => c.name === 'fill')!.fill
      return { x: (box.args[0] as number) + (box.args[2] as number) / 2, fill }
    }
    const you = draw(1.2)
    const other = draw(3.5)
    expect(you.x).toBeGreaterThan(960)
    expect(other.x).toBeLessThan(960)
    expect(you.fill).toBe('rgba(41, 108, 224, 1)')
    expect(other.fill).toBe('rgba(233, 234, 240, 1)')
    // Speaker names above the text, in the bubble.
    expect(calls.some((c) => c.name === 'fillText' && c.args[0] === 'Priya')).toBe(true)
  })

  it('draws Chat without speakers as Subtitle (§0.1)', () => {
    const { fc, id } = frameOf(studioProject(look('chat')), 1.2)
    drawStudioCaptions(fc)
    expect(onFrame(id).some((c) => c.name === 'roundRect')).toBe(false)
    expect(drawnWords(id)).toEqual(['Make', 'every', 'word', 'count', 'today'])
  })

  it('draws the circle around an emphasised word, on over 0.3 s (§0.1 Circle)', () => {
    const p = studioProject(look('circle'), { captionMarks: [{ id: 'm1', caption: 'c1', from: 2, to: 2, text: 'word' }] })
    const at = (t: number): number[] => {
      calls.length = 0
      const { fc, id } = frameOf(p, t)
      drawStudioCaptions(fc)
      const dash = onFrame(id).find((c) => c.name === 'setLineDash')
      const stroke = onFrame(id).some((c) => c.name === 'bezierCurveTo')
      return stroke ? ((dash?.args[0] as number[]) ?? [Infinity]) : []
    }
    expect(at(1.4)).toEqual([])
    const half = at(1.6)
    expect(half[0]).toBeGreaterThan(0)
    expect(half[0]).toBeLessThan(Infinity)
    expect(at(2.0)).toEqual([Infinity])
  })

  it('draws Retro Pixel’s colour split as two still copies and 3D Block’s extrusion in steps', () => {
    drawStudioCaptions(frameOf(studioProject(look('retro-pixel')), 1.2).fc)
    const make = calls.filter((c) => c.name === 'fillText' && c.args[0] === 'MAKE')
    expect(make.map((c) => c.fill)).toEqual(expect.arrayContaining(['#ff004c', '#00e5ff']))
    calls.length = 0
    STUDIO_SPRITES.clear()
    drawStudioCaptions(frameOf(studioProject(look('block-3d')), 1.2).fc)
    const extruded = calls.filter((c) => c.name === 'fillText' && c.args[0] === 'MAKE' && c.fill === '#551329')
    expect(extruded.length).toBeGreaterThanOrEqual(6)
  })

  it('fills Gold’s letters with its metal band at the middle, the stops at 0, 45, 55 and 100% (more.html); Gradient’s evenly', () => {
    gradientStops.length = 0
    drawStudioCaptions(frameOf(studioProject(look('gold')), 1.2).fc)
    expect(gradientStops.slice(0, 4)).toEqual([
      { offset: 0, colour: '#fff3c4' },
      { offset: 0.45, colour: '#f5c84c' },
      { offset: 0.55, colour: '#b7862b' },
      { offset: 1, colour: '#f9e08a' }
    ])
    gradientStops.length = 0
    STUDIO_SPRITES.clear()
    drawStudioCaptions(frameOf(studioProject(look('gradient')), 1.2).fc)
    expect(gradientStops.slice(0, 2)).toEqual([
      { offset: 0, colour: '#ff3dcb' },
      { offset: 1, colour: '#ff8a00' }
    ])
  })

  it('draws and measures Stacked’s Bangla font at its width 75, condensed (§0.2)', () => {
    const bn: CaptionSegment = { id: 'b1', start: 0.5, end: 3, text: 'আপনার ভিডিও সুন্দর' }
    const bangla = (studio: CaptionStudio): Project => studioProject(studio, { transcript: { language: 'bn', segments: [bn] } } as Partial<Project>)
    /** How far right of the first word the frame drew the second: the first word and its space, as measured. */
    const second = (studio: CaptionStudio): number => {
      calls.length = 0
      STUDIO_SPRITES.clear()
      const { fc, id } = frameOf(bangla(studio), 1.2)
      drawStudioCaptions(fc)
      const texts = spriteTexts()
      const x = (word: string): number => onFrame(id).find((c) => c.name === 'drawImage' && texts.get((c.args[0] as { id: number }).id)?.[0] === word)!.args[1] as number
      return x('ভিডিও') - x('আপনার')
    }
    const stacked = look('stacked')
    const condensed = second(stacked)
    expect(calls.find((c) => c.name === 'fillText' && c.args[0] === 'আপনার')?.font).toMatch(/^800 condensed [\d.]+px "FlownCat-anek-bangla"/)
    // The same font at its normal width is measured again, not taken from the condensed one's widths.
    const normal = second({ ...stacked, text: { ...stacked.text, scripts: { bengali: { ...stacked.text.scripts!.bengali!, width: undefined } } } })
    expect(calls.find((c) => c.name === 'fillText' && c.args[0] === 'আপনার')?.font).toMatch(/^800 [\d.]+px "FlownCat-anek-bangla"/)
    expect(normal).toBeGreaterThan(condensed + 1)
  })
})

describe('the legacy branch and its three guarded calls (tests 23, 50, 51)', () => {
  it('returns its input without the new fields: the same array and position, nothing replaced', () => {
    const p = project(LEGACY)
    expect(actual.burnedSegments(p)).toBe(p.transcript!.segments)
    expect(actual.placeOf(p, 'c1', 'bottom')).toBe('bottom')
    const r = actualReplaced.replacedAt(p, 1.2)
    expect(r.captions.size).toBe(0)
    expect(r.chunks.length).toBe(0)
  })

  it('draws a legacy look from burnedSegments, through placeOf', () => {
    const p = project(LEGACY)
    const { fc } = frameOf(p, 1.2)
    drawCaptionsLayer(fc)
    const burned = hooks.log.find((l) => l.name === 'burnedSegments')!
    expect(burned.args[1]).toBe(p.transcript!.segments)
    expect(hooks.log.find((l) => l.name === 'placeOf')!.args).toEqual(['c1', 'bottom', 'bottom'])
    expect(hooks.log.some((l) => l.name === 'studioLayout')).toBe(false)
  })

  it('draws the masked word of a bleep on Clean (test 50)', () => {
    hooks.burned = (p) => p.transcript!.segments.map((s) => ({ ...s, text: s.text.replace('word', 'w***') }))
    drawCaptionsLayer(frameOf(project(LEGACY), 1.2).fc)
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])
    expect(texts).toContain('w***')
    expect(texts).not.toContain('word')
  })

  it('hides a caption an automatic quote card replaces, on Boxed and on Subtitle (test 51)', () => {
    hooks.replaced = (_p, t) => ({ captions: new Set(t >= 0.5 && t < 3 ? ['c1'] : []), chunks: [] })
    const boxed = frameOf(project({ ...LEGACY, preset: 'boxed', background: 'box' }), 1.2)
    drawCaptionsLayer(boxed.fc)
    expect(onFrame(boxed.id)).toEqual([])
    const subtitle = frameOf(studioProject(look('subtitle')), 1.2)
    drawCaptionsLayer(subtitle.fc)
    expect(onFrame(subtitle.id)).toEqual([])
  })

  it('puts one caption at the top on a legacy look when placeOf says so', () => {
    hooks.place = () => 'top'
    const block = captionBlockAt(contextOf(canvas()), project(LEGACY), 1.2, 1920, 1080)!
    expect(block.position).toBe('top')
    expect(block.top).toBeLessThan(200)
  })

  it('lights no karaoke word while a translated track shows (§9.1 rule 7)', () => {
    const karaoke = { ...LEGACY, preset: 'karaoke' as const, highlightColor: '#ff00ff' }
    drawCaptionsLayer(frameOf(project(karaoke), 1.2).fc)
    expect(calls.some((c) => c.name === 'fill' && c.fill === '#ff00ff')).toBe(true)
    calls.length = 0
    hooks.burned = (p) => p.transcript!.segments.map((s) => ({ ...s, text: 'আমরা আজ শিখব', words: undefined }))
    drawCaptionsLayer(frameOf(project({ ...karaoke, track: 'bn' }), 1.2).fc)
    expect(calls.some((c) => c.name === 'fill' && c.fill === '#ff00ff')).toBe(false)
  })

  it('dims no word to come while a translated track shows: it has no word times (§9.1 rule 7)', () => {
    const spotlight = { ...LEGACY, studio: look('spotlight-word') }
    const dimmed = (): string[] => calls.filter((c) => c.name === 'fillText' && c.fill === '#9a9a9a').map((c) => String(c.args[0]))
    drawStudioCaptions(frameOf(project(spotlight), 1.2).fc)
    expect(dimmed()).toContain('word')
    calls.length = 0
    STUDIO_SPRITES.clear()
    hooks.burned = (p) => p.transcript!.segments.map((s) => ({ ...s, text: 'আমরা আজ শিখব', words: undefined }))
    drawStudioCaptions(frameOf(project({ ...spotlight, track: 'bn' }), 1.2).fc)
    expect(calls.some((c) => c.name === 'fillText' && c.args[0] === 'শিখব')).toBe(true)
    expect(dimmed()).toEqual([])
  })
})

describe('keeping clear (§8.6)', () => {
  it('places a caption again when an edit changes what the camera shows, and not on every frame', () => {
    const cursor = { valid: true, samples: [], clicks: [] }
    const p1 = studioProject(look('subtitle'))
    const seen = (): unknown[] => hooks.log.filter((l) => l.name === 'actionRects').map((l) => (l.args[0] as { project: Project }).project)
    drawStudioCaptions(frameOf(p1, 1.2, 1920, 1080, { cursor }).fc)
    drawStudioCaptions(frameOf(p1, 1.3, 1920, 1080, { cursor }).fc)
    expect(seen()).toEqual([p1])
    // A zoom added (the captions are the same objects): the cursor's place in the new view counts.
    const p2 = { ...p1, zooms: [{ id: 'z1', start: 0, end: 5, scale: 2, x: 0.5, y: 0.3 }] } as unknown as Project
    drawStudioCaptions(frameOf(p2, 1.3, 1920, 1080, { cursor }).fc)
    expect(seen()).toEqual([p1, p2])
    // So do the style and the crop.
    const p3 = { ...p2, style: { ...p2.style, padding: 0.2 } } as unknown as Project
    drawStudioCaptions(frameOf(p3, 1.3, 1920, 1080, { cursor }).fc)
    const p4 = { ...p3, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } } as unknown as Project
    drawStudioCaptions(frameOf(p4, 1.3, 1920, 1080, { cursor, vw: 960, vh: 540 }).fc)
    expect(seen()).toEqual([p1, p2, p3, p4])
  })
})

describe('nothing is read twice (test 51)', () => {
  const keyword: Graphic = {
    id: 'g1',
    kind: 'keyword',
    start: 0.5,
    end: 2,
    place: 'auto',
    size: 0.09,
    text: 'every',
    look: 'card',
    anchor: { caption: 'c1', from: 1, to: 1, text: 'every' },
    enter: { kind: 'pop', duration: 0.24, strength: 1 },
    exit: { kind: 'fade', duration: 0.18, strength: 1 }
  }

  it('draws an anchored keyword’s words once in its frame: in the card, not in the caption', () => {
    const studio = look('bold-pop')
    studio.text.case = 'asis'
    hooks.replaced = (_p, t) => ({ captions: new Set(), chunks: t >= 0.5 && t < 2 ? [{ caption: 'c1', word: 1 }] : [] })
    const p = studioProject(studio, { graphics: [keyword] })
    const { fc } = frameOf(p, 1.2)
    drawGraphicsLayer(fc)
    drawCaptionsLayer(fc)
    const painted = calls.filter((c) => c.name === 'fillText' && String(c.args[0]).toLowerCase() === 'every')
    expect(painted.length).toBe(1)
    // After the card, the chunk shows again.
    calls.length = 0
    drawCaptionsLayer(frameOf(p, 2.1).fc)
    expect(calls.some((c) => c.name === 'fillText' && c.args[0] === 'count')).toBe(true)
  })
})

describe('gallery thumbnails (§2.5)', () => {
  it('draw the first chunk at 18 px (One Word 28 px) on the dark grey picture, with the spoken mark on "word"', () => {
    const c = canvas(136, 96)
    const subtitle = drawStudioSample(contextOf(c), look('subtitle'), { w: 1920, h: 1080 }, { w: 136, h: 96 }, SAMPLE_STILL_T)
    expect(subtitle.textPx).toBeCloseTo(18, 6)
    expect(calls.some((k) => k.canvas === c.id && k.name === 'fillRect' && k.args[2] === 136 && k.args[3] === 96)).toBe(true)
    expect(drawStudioSample(contextOf(canvas(136, 96)), look('one-word'), { w: 1080, h: 1920 }, { w: 136, h: 96 }, SAMPLE_STILL_T).textPx).toBeCloseTo(28, 6)
    // Bold Pop's spoken word at the still time is "WORD", painted in the spoken colour.
    drawStudioSample(contextOf(canvas(136, 96)), look('bold-pop'), { w: 1080, h: 1920 }, { w: 136, h: 96 }, SAMPLE_STILL_T)
    expect(calls.some((k) => k.name === 'fillText' && k.args[0] === 'WORD' && k.fill === '#39e508')).toBe(true)
  })

  it('are painted again after a font loads (sprites are keyed by the font generation)', async () => {
    const studio = look('subtitle')
    const paints = (): number => calls.filter((k) => k.name === 'fillText' && k.args[0] === 'count').length
    drawStudioSample(contextOf(canvas(136, 96)), studio, { w: 1920, h: 1080 }, { w: 136, h: 96 }, SAMPLE_STILL_T)
    const first = paints()
    drawStudioSample(contextOf(canvas(136, 96)), studio, { w: 1920, h: 1080 }, { w: 136, h: 96 }, SAMPLE_STILL_T)
    expect(paints()).toBe(first)
    const generation = fontGeneration()
    // A font not loaded before in this file.
    await loadCatalogFont('luckiest-guy')
    expect(fontGeneration()).toBeGreaterThan(generation)
    drawStudioSample(contextOf(canvas(136, 96)), studio, { w: 1920, h: 1080 }, { w: 136, h: 96 }, SAMPLE_STILL_T)
    expect(paints()).toBeGreaterThan(first)
  })

  it('do not fetch a missing download again on each draw (the gallery would draw again for ever)', async () => {
    // A saved look whose font is a download not on this PC.
    const studio = { ...look('subtitle'), text: { ...look('subtitle').text, font: 'cat:noto-sans-kr' } }
    const draw = async (): Promise<void> => {
      drawStudioSample(contextOf(canvas(136, 96)), studio, { w: 1920, h: 1080 }, { w: 136, h: 96 }, SAMPLE_STILL_T)
      await new Promise((r) => setTimeout(r, 0))
    }
    const tries = (): number => fetched.filter((u) => u.includes('noto-sans-kr')).length
    await draw()
    const first = tries()
    const generation = fontGeneration()
    expect(first).toBeGreaterThan(0)
    // The gallery draws again when the generation changes: it must settle.
    for (let i = 0; i < 3; i++) await draw()
    expect(tries()).toBe(first)
    expect(fontGeneration()).toBe(generation)
  })
})
