import { beforeEach, describe, expect, it, vi } from 'vitest'
import { planGraphics, type GraphicOptions } from '../src/shared/captions/graphicRules'
import { compileNames } from '../src/shared/privacy/detect/names'
import { detectSaid, saidBleeps } from '../src/shared/privacy/detect/said'
import { SAID_KINDS } from '../src/shared/privacy/kinds'
import { privateView } from '../src/shared/privacy/spoken'
import type { CaptionSegment, CounterGraphic, Graphic, KeywordGraphic, ListGraphic, Project, TitleCard } from '../src/shared/types'
import { calls, canvas, frameOf, hooks, sets } from './studioFakes'
import { studioProject } from './p4Fixtures'

/*
 * Auto-blur §7.5: graphics made from captions before Find (a list card, a keyword pop-up without an
 * anchor, a counter's label) and quote cards are drawn with the spoken forms masked, in the preview
 * and every export (which draw the scene's privateView of the project). Review finding [0] of the
 * second review: the graphics layer masked bleeped words only, so a list card made by Polish's
 * caption look before its privacy step kept the email and the code said aloud.
 */

vi.mock('../src/shared/captions/studioLayout', async () => (await import('./studioFakes')).fakeStudioLayout)
vi.mock('../src/shared/captions/motion', async () => (await import('./studioFakes')).fakeMotion)
vi.mock('../src/shared/captions/replaced', async () => (await import('./studioFakes')).fakeReplaced)
vi.mock('../src/shared/captions/captionTracks', async (original) => (await import('./studioFakes')).fakeCaptionTracks(await original()))
vi.mock('../src/shared/captions/fontStack', async () => (await import('./studioFakes')).fakeFontStack)
vi.mock('../src/shared/captions/colors', async () => (await import('./studioFakes')).fakeColors)
vi.mock('../src/shared/captions/marks', async () => (await import('./studioFakes')).fakeMarks)
// The caption words as the rules read them (the list finder), the fakes' scripts for drawing.
vi.mock('../src/shared/captions/words', async (original) => {
  const real = await original<typeof import('../src/shared/captions/words')>()
  return { ...real, ...(await import('./studioFakes')).fakeWords, studioTokens: real.studioTokens }
})
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
const TITLES = '../src/renderer/src/render/titleCardLayer'
const SPRITES = '../src/renderer/src/render/wordSprites'
const { drawGraphicsLayer } = (await import(/* @vite-ignore */ GRAPHICS)) as { drawGraphicsLayer: (fc: never) => void }
const { drawTitleCardsLayer } = (await import(/* @vite-ignore */ TITLES)) as { drawTitleCardsLayer: (fc: never) => void }
const { STUDIO_SPRITES } = (await import(/* @vite-ignore */ SPRITES)) as { STUDIO_SPRITES: { clear(): void } }

beforeEach(() => {
  calls.length = 0
  sets.length = 0
  hooks.log.length = 0
  hooks.burned = undefined
  STUDIO_SPRITES.clear()
})

const NONE: GraphicOptions = { keywords: false, emoji: false, counters: false, lists: false, speakers: false, chapters: false, quotes: false, sound: 'none' }
const motion = { enter: { kind: 'pop' as const, duration: 0.24, strength: 1 }, exit: { kind: 'fade' as const, duration: 0.18, strength: 1 } }

/** A caption with word times, one word every 0.3 s. */
function seg(id: string, start: number, text: string): CaptionSegment {
  const ws = text.split(/\s+/)
  const words = ws.map((w, i) => ({ text: w, start: start + i * 0.3, end: start + i * 0.3 + 0.28 }))
  return { id, start, end: words[words.length - 1].end, text, words }
}

/**
 * Every text the frame at `t` writes, the graphics' cached pictures (a pop-up's card, a counter's
 * label) drawn again. A title card's picture is kept per text and size: each draw of one here
 * differs in either.
 */
function written(draw: (fc: never) => void, project: Project, t: number, w = 1080, h = 1920): string {
  calls.length = 0
  STUDIO_SPRITES.clear()
  draw(frameOf(project, t, w, h).fc)
  return calls
    .filter((c) => c.name === 'fillText' || c.name === 'strokeText')
    .map((c) => String(c.args[0]))
    .join(' | ')
}

const SECRET = /jsmith|gmail|4821|priya|raman/i

describe('auto-blur §7.5: graphics made from captions before Find', () => {
  it('a list card, a keyword pop-up without an anchor, a counter label and a quote card made before Find are drawn with the secrets said aloud masked', () => {
    const segments = [
      seg('c0', 0, 'There are three steps.'),
      seg('c1', 2, 'First, sign in with jsmith@gmail.com.'),
      seg('c2', 5, 'Second, enter the verification code 4821.'),
      seg('c3', 8, 'Finally, ask Priya Raman to click save.')
    ]
    // A vertical video's caption look makes a list card from the steps (Polish runs it before its privacy step).
    const listed = planGraphics(studioProject({ segments, aspect: '9:16' }), { ...NONE, lists: true })
    const list = (listed.graphics ?? []).find((g): g is ListGraphic => g.kind === 'list')
    expect(list).toBeTruthy()
    expect(list!.items.map((i) => i.text).join(' ')).toMatch(/jsmith@gmail\.com/)
    expect(list!.items.map((i) => i.text).join(' ')).toMatch(/4821/)
    // A keyword pop-up without an anchor (an AI pick) and a counter whose label names someone, made before Find too.
    const keyword: KeywordGraphic = { id: 'k1', kind: 'keyword', start: 2, end: 12, place: 'auto', size: 0.09, text: 'jsmith@gmail.com', look: 'card', ...motion }
    const counter: CounterGraphic = { id: 'n1', kind: 'counter', start: 2, end: 12, place: 'auto', size: 0.11, from: 0, to: 300, decimals: 0, prefix: '', suffix: '%', label: 'Priya Raman', locale: 'en', countFor: 1, ...motion }
    const quote: TitleCard = { id: 't1', start: 5, end: 12, title: 'Enter the verification code 4821', style: 'quote', background: 'solid' }
    const graphics: Graphic[] = [...(listed.graphics ?? []), keyword, counter]
    const before: Project = { ...listed, graphics, titles: [quote] }
    // Before Find nothing is private: the cards say what was said.
    expect(written(drawGraphicsLayer, privateView(before), 3)).toBe('Three steps | 1 | Sign in with jsmith@gmail.com | jsmith@gmail.com | PRIYA RAMAN | 3 | 0 | 0 | %')
    // Find listens: the email, the code and the listed name said aloud become private bleeps.
    const hits = detectSaid(before.transcript, { kinds: SAID_KINDS, regions: ['US'], names: compileNames(['Priya Raman'], []) })
    expect(hits.map((h) => h.kind).sort()).toEqual(['code', 'email', 'name'])
    let x = 7
    const random = (): number => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32
    const after: Project = { ...before, bleeps: [...(before.bleeps ?? []), ...saidBleeps(hits, before.bleeps, random).bleeps] }
    // The preview and every export draw the scene's project, the private view (Editor.tsx, exporter.ts).
    const view = privateView(after)
    for (const t of [3, 6, 8.5, 9.5]) {
      const text = written(drawGraphicsLayer, view, t)
      expect(text, `graphics at ${t} s`).not.toMatch(SECRET)
    }
    // The list card, the pop-up and the counter's label are still drawn, masked.
    expect(written(drawGraphicsLayer, view, 3)).toBe('Three steps | 1 | Sign in with ••••••@•••••.••• | ••••••@•••••.••• | ••••• ••••• | 3 | 0 | 0 | %')
    expect(written(drawGraphicsLayer, view, 9.5)).toContain('Enter the verification code •••• | 3 | Ask ••••• ••••• to click')
    // A quote card made from the code's caption before Find: masked by the layer itself, as it masks a bleeped word, and in the view.
    const stored = written(drawTitleCardsLayer, after, 8)
    expect(stored).toContain('Enter the verification code ••••')
    expect(stored).not.toMatch(SECRET)
    expect(written(drawTitleCardsLayer, privateView(before), 8)).toContain('Enter the verification code 4821')
    const shown = written(drawTitleCardsLayer, view, 8, 1920, 1080)
    expect(shown).toContain('Enter the verification code ••••')
    expect(shown).not.toMatch(SECRET)
  })
})
