import { beforeEach, describe, expect, it, vi } from 'vitest'
import { planOf, videoFrames } from '../src/shared/engine/freeze'
import { popJob } from '../src/shared/render/popSound'
import type { CounterGraphic, EmojiGraphic, Graphic, KeywordGraphic, ListGraphic, Project } from '../src/shared/types'
import { calls, canvas, contextOf, frameOf, hooks, sets } from './studioFakes'
import { sceneFixtures } from './verticalFixtures'

/*
 * Motion graphics on the video (docs/design/captions-studio.md §10, tests 51 and 52): nothing is
 * drawn without graphics; a graphic shows only with its language and an emoji only from the list;
 * a counter's digits stay in fixed cells; a graphic is placed once and never moves while it shows,
 * a dragged one stays inside the frame; list items appear at their times. In a continue freeze the
 * layer runs on the sound's clock, and a pop sounds when its graphic appears.
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
vi.stubGlobal('Path2D', class {})
vi.stubGlobal(
  'FontFace',
  class {
    constructor(public family: string) {}
    async load(): Promise<unknown> {
      return this
    }
  }
)
vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }))
vi.spyOn(console, 'warn').mockImplementation(() => {})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const GRAPHICS = '../src/renderer/src/render/graphicsLayer'
const COMPOSITOR = '../src/renderer/src/render/compositor'
const SPRITES = '../src/renderer/src/render/wordSprites'
const { drawGraphicsLayer, graphicRects } = (await import(/* @vite-ignore */ GRAPHICS)) as {
  drawGraphicsLayer: (fc: never) => void
  graphicRects: (ctx: unknown, p: Project, t: number, w: number, h: number) => { id: string; rect: { x: number; y: number; w: number; h: number } }[]
}
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: unknown, soundTime?: number) => void }
const { STUDIO_SPRITES } = (await import(/* @vite-ignore */ SPRITES)) as { STUDIO_SPRITES: { clear(): void } }

const motion = { enter: { kind: 'pop' as const, duration: 0.24, strength: 1 }, exit: { kind: 'fade' as const, duration: 0.18, strength: 1 } }
const counter = (over: Partial<CounterGraphic> = {}): CounterGraphic => ({ id: 'n1', kind: 'counter', start: 2, end: 6, place: 'auto', size: 0.11, from: 0, to: 300, decimals: 0, prefix: '', suffix: '%', locale: 'en', countFor: 2, ...motion, ...over })
const keyword = (over: Partial<KeywordGraphic> = {}): KeywordGraphic => ({ id: 'k1', kind: 'keyword', start: 1, end: 3, place: 'auto', size: 0.09, text: 'Export', look: 'card', ...motion, ...over })
const emoji = (over: Partial<EmojiGraphic> = {}): EmojiGraphic => ({ id: 'e1', kind: 'emoji', start: 1, end: 3, place: 'auto', size: 0.12, emoji: '1f525', ...motion, ...over })

function project(graphics: Graphic[], over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    clips: [{ start: 0, end: 10, speed: 1 }],
    fonts: [],
    annotations: [],
    titles: [],
    webcam: { show: false },
    transcript: { language: 'en', segments: [] },
    graphics,
    ...over
  } as unknown as Project
}

const onFrame = (id: number): typeof calls => calls.filter((c) => c.canvas === id)

beforeEach(() => {
  calls.length = 0
  sets.length = 0
  hooks.log.length = 0
  hooks.burned = undefined
  STUDIO_SPRITES.clear()
})

describe('the graphics layer (§10.4)', () => {
  it('makes no call on the frame without graphics, or with none showing', () => {
    const none = frameOf(project([]), 2)
    drawGraphicsLayer(none.fc)
    expect(onFrame(none.id)).toEqual([])
    const later = frameOf(project([keyword()]), 8)
    drawGraphicsLayer(later.fc)
    expect(onFrame(later.id)).toEqual([])
  })

  it('draws a graphic with a language only while the burned-in captions have it', () => {
    const g = keyword({ lang: 'bn' })
    // The burned-in Bangla track (the captions' text is not what this test is about).
    hooks.burned = () => []
    const english = frameOf(project([g]), 2)
    drawGraphicsLayer(english.fc)
    expect(onFrame(english.id)).toEqual([])
    const bangla = frameOf(project([g], { captions: { show: true, preset: 'clean', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#ffe14d', background: 'shadow', maxLines: 2, track: 'bn' } } as Partial<Project>), 2)
    drawGraphicsLayer(bangla.fc)
    expect(onFrame(bangla.id).some((c) => c.name === 'drawImage')).toBe(true)
  })

  it('draws an emoji of the list in the bundled colour emoji font, and none from outside it', () => {
    const listed = frameOf(project([emoji()]), 2)
    drawGraphicsLayer(listed.fc)
    const glyph = calls.find((c) => c.name === 'fillText' && c.args[0] === '\u{1f525}')
    expect(String(glyph?.font)).toContain('"FlownCat-noto-color-emoji"')
    calls.length = 0
    const unknown = frameOf(project([emoji({ emoji: '1faff' })]), 2)
    drawGraphicsLayer(unknown.fc)
    expect(calls).toEqual([])
  })

  it('places an automatic graphic once, so it never moves while it shows', () => {
    const p = project([keyword(), counter()])
    // The scene's cursor track is one object for the whole session.
    const cursor = { valid: false, samples: [], clicks: [] }
    for (const t of [1.1, 1.5, 2.2, 2.9]) drawGraphicsLayer(frameOf(p, t, 1920, 1080, { cursor }).fc)
    expect(hooks.log.filter((l) => l.name === 'placeGraphic').length).toBe(2)
  })

  it('places a graphic again when an edit changes the camera’s view or the title cards (§10.3)', () => {
    const cursor = { valid: true, samples: [], clicks: [] }
    const p1 = project([keyword()])
    const placed = (): number => hooks.log.filter((l) => l.name === 'placeGraphic').length
    const seen = (): unknown[] => hooks.log.filter((l) => l.name === 'actionRects').map((l) => (l.args[0] as { project: Project }).project)
    drawGraphicsLayer(frameOf(p1, 1.2, 1920, 1080, { cursor }).fc)
    drawGraphicsLayer(frameOf(p1, 1.5, 1920, 1080, { cursor }).fc)
    expect(placed()).toBe(1)
    // A zoom added (the graphics, captions, camera and titles are the same objects): the cursor's place in the new view counts.
    const p2 = { ...p1, zooms: [{ id: 'z1', start: 0, end: 5, scale: 2, x: 0.5, y: 0.3 }] } as unknown as Project
    drawGraphicsLayer(frameOf(p2, 1.5, 1920, 1080, { cursor }).fc)
    expect(placed()).toBe(2)
    expect(seen().at(-1)).toBe(p2)
    // So do the style, the crop, the follow settings and the title cards (a lower third moves the captions).
    const p3 = { ...p2, style: { padding: 0.2 } } as unknown as Project
    drawGraphicsLayer(frameOf(p3, 1.5, 1920, 1080, { cursor }).fc)
    const p4 = { ...p3, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } } as unknown as Project
    drawGraphicsLayer(frameOf(p4, 1.5, 1920, 1080, { cursor, vw: 960, vh: 540 }).fc)
    const p5 = { ...p4, reframe: { follow: true } } as unknown as Project
    drawGraphicsLayer(frameOf(p5, 1.5, 1920, 1080, { cursor, vw: 960, vh: 540 }).fc)
    const p6 = { ...p5, titles: [{ id: 't1', kind: 'lower-third', start: 0, end: 4, text: 'Ada' }] } as unknown as Project
    drawGraphicsLayer(frameOf(p6, 1.5, 1920, 1080, { cursor, vw: 960, vh: 540 }).fc)
    expect(placed()).toBe(6)
    // Playback over the same project places it no more.
    drawGraphicsLayer(frameOf(p6, 2.5, 1920, 1080, { cursor, vw: 960, vh: 540 }).fc)
    expect(placed()).toBe(6)
  })

  it('keeps a dragged graphic where the user put it, inside the frame', () => {
    const p = project([keyword({ place: { x: 0.25, y: 0.4 } }), keyword({ id: 'k2', place: { x: 1.2, y: -0.3 } })])
    const rects = graphicRects(contextOf(canvas()), p, 2, 1920, 1080)
    const a = rects.find((r) => r.id === 'k1')!.rect
    expect(a.x + a.w / 2).toBeCloseTo(0.25 * 1920, 6)
    expect(a.y + a.h / 2).toBeCloseTo(0.4 * 1080, 6)
    const b = rects.find((r) => r.id === 'k2')!.rect
    expect(b.x + b.w).toBeLessThanOrEqual(1920 + 1e-6)
    expect(b.y).toBeGreaterThanOrEqual(-1e-6)
    expect(hooks.log.some((l) => l.name === 'placeGraphic')).toBe(false)
  })

  it('draws a counter’s digits in fixed cells: the last digit never moves as the number grows', () => {
    const p = project([counter()])
    const lastDigitX = (t: number): number => {
      calls.length = 0
      drawGraphicsLayer(frameOf(p, t).fc)
      const digits = calls.filter((c) => c.name === 'fillText' && /^\d$/.test(String(c.args[0])))
      return digits[digits.length - 1].args[1] as number
    }
    // 0% at its start, 150% half way, 300% once counted: 1, 3 and 3 digits.
    const a = lastDigitX(2.0)
    const b = lastDigitX(3.0)
    const c = lastDigitX(4.5)
    expect(b).toBeCloseTo(a, 6)
    expect(c).toBeCloseTo(a, 6)
  })

  it('shows a list card’s items from their times', () => {
    const list: ListGraphic = { id: 'l1', kind: 'list', start: 1, end: 8, place: 'auto', size: 0.045, title: 'Three steps', marker: 'number', items: [{ text: 'Open settings', at: 1.2 }, { text: 'Click export', at: 3 }, { text: 'Save', at: 5 }], ...motion }
    const items = (t: number): string[] => {
      calls.length = 0
      drawGraphicsLayer(frameOf(project([list]), t).fc)
      return calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))
    }
    expect(items(2)).toEqual(['Three steps', '1', 'Open settings'])
    expect(items(5.5)).toEqual(['Three steps', '1', 'Open settings', '2', 'Click export', '3', 'Save'])
  })
})

describe('graphics in a continue freeze (test 52)', () => {
  it('count with the sound’s clock, and their pop sounds when they appear', () => {
    const f = sceneFixtures().find((x) => x.name === 'wide-auto')!
    // A counter from 2.0 s; a continue freeze holds the picture at 1.8 s for 2 s while the sound plays on.
    const g = counter({ start: 2, end: 6, sound: 'pop' })
    const p = { ...f.project, graphics: [g], freezes: [{ id: 'f1', at: 1.8, length: 2, sound: 'continue' as const }] } as Project
    const scene = { project: p, cursor: f.track, cursorPath: { at: () => ({ x: 0.5, y: 0.5 }) }, focusPath: { at: () => ({ x: 0.5, y: 0.5 }) } }
    const src = { screen: { readyState: 4, videoWidth: f.project.width, videoHeight: f.project.height }, webcam: null, background: null, screenFrame: { image: { tag: 'screen' }, width: f.project.width, height: f.project.height } }
    const fps = 30
    const { times, pictures } = videoFrames(p.clips, planOf(p), fps)
    let appeared = -1
    for (let i = 0; i < times.length && times[i] < 3; i++) {
      hooks.log.length = 0
      const ctx = contextOf(canvas(f.w, f.h))
      drawFrame(ctx, f.w, f.h, pictures[i], scene, src, { blurSamples: 1 }, times[i])
      const value = hooks.log.find((l) => l.name === 'counterValue')
      if (value) {
        // The counter's value and pose follow the sound, not the held picture.
        expect(value.args[1]).toBe(times[i])
        expect(hooks.log.find((l) => l.name === 'itemPose')!.args[2]).toBe(times[i])
        if (appeared < 0) appeared = i / fps
      }
    }
    expect(appeared).toBeGreaterThan(0)
    // The picture is still held when the counter appears: it counts with the speech.
    expect(pictures[Math.round(appeared * fps)]).toBeCloseTo(1.8, 6)
    const pop = popJob(p)[0].times[0]
    expect(Math.abs(pop - appeared)).toBeLessThanOrEqual(1 / fps + 1e-9)
  })
})
