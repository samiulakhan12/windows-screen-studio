import { describe, expect, it, vi } from 'vitest'
import { quoteName, quotePanel, titleLayout } from '../src/shared/render/titleCards'
import type { Project, TitleCard } from '../src/shared/types'
import { calls, canvas, frameOf } from './studioFakes'

/*
 * Quote cards and catalogue fonts on title cards (docs/design/captions-studio.md §10.1, §6.8): a
 * pull quote on a panel at most 0.8 W wide, centred at 0.72 H (0.45 H in tall frames), in
 * Instrument Serif Italic, its name line "— Name"; a card with a `cat:` font draws in that
 * catalogue face; cards of the older styles and fonts draw as before.
 */

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
vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }))

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const LAYER = '../src/renderer/src/render/titleCardLayer'
const { drawTitleCardsLayer } = (await import(/* @vite-ignore */ LAYER)) as { drawTitleCardsLayer: (fc: never) => void }

const measure = (text: string, px: number): number => text.length * px * 0.5

const quote: TitleCard = { id: 'q1', start: 0, end: 4, title: 'Recording is the easy part. Editing is where the time goes.', subtitle: 'Sam', style: 'quote', background: 'blur' }

const project = (titles: TitleCard[]): Project => ({ id: 'p1', clips: [{ start: 0, end: 10, speed: 1 }], fonts: [], titles, annotations: [], style: { background: { kind: 'color', color: '#000000' } } }) as unknown as Project

describe('the quote panel (§10.1)', () => {
  it('names the speaker with a dash, once', () => {
    expect(quoteName('Sam')).toBe('— Sam')
    expect(quoteName('— Sam')).toBe('— Sam')
    expect(quoteName('  ')).toBe('')
    expect(quoteName(undefined)).toBe('')
  })

  it('is at most 0.8 W wide, centred at 0.72 H in a wide frame and 0.45 H in a tall one', () => {
    for (const [w, h, y] of [
      [1920, 1080, 0.72],
      [1080, 1920, 0.45]
    ]) {
      const l = titleLayout({ ...quote, subtitle: quoteName(quote.subtitle) }, w, h, measure)
      const q = quotePanel(l, w, h)
      expect(q.panel.w).toBeLessThanOrEqual(0.8 * w + 1e-6)
      expect(q.panel.x + q.panel.w / 2).toBeCloseTo(w / 2, 6)
      expect(q.panel.y + q.panel.h / 2).toBeCloseTo(y * h, 6)
      // The quote at 0.06 u, the opening mark 1.6 times it, the radius 0.3 em.
      expect(l.title.px).toBeLessThanOrEqual(0.06 * Math.min(w, h) + 1e-9)
      expect(q.mark.px).toBeCloseTo(l.title.px * 1.6, 6)
      expect(q.radius).toBeCloseTo(Math.min(l.title.px * 0.3, q.panel.h / 2), 6)
      expect(q.textX).toBeGreaterThan(q.mark.x)
    }
  })

  it('draws a panel, the opening mark and the quote in Instrument Serif Italic, without a full-frame background', () => {
    const { fc, id } = frameOf(project([quote]), 1.5)
    calls.length = 0
    drawTitleCardsLayer(fc)
    const texts = calls.filter((c) => c.name === 'fillText')
    expect(texts.some((c) => c.args[0] === '“')).toBe(true)
    expect(texts.some((c) => c.args[0] === '— Sam')).toBe(true)
    expect(texts.every((c) => String(c.font).includes('"FlownCat-instrument-serif-italic"'))).toBe(true)
    // No full-frame fill on the frame: the panel is a rounded rectangle on a sprite.
    expect(calls.some((c) => c.canvas === id && c.name === 'fillRect')).toBe(false)
  })

  it('draws a card in its catalogue font, and an older card in the title font as before', () => {
    const cat: TitleCard = { id: 't1', start: 0, end: 4, title: 'Launch', style: 'centered', background: 'solid', font: 'cat:anton' }
    const { fc } = frameOf(project([cat]), 1.5)
    calls.length = 0
    drawTitleCardsLayer(fc)
    expect(calls.filter((c) => c.name === 'fillText').every((c) => String(c.font).startsWith('700 ') && String(c.font).includes('"FlownCat-anton"'))).toBe(true)
    const plain: TitleCard = { ...cat, id: 't2', font: undefined }
    calls.length = 0
    drawTitleCardsLayer(frameOf(project([plain]), 1.5).fc)
    expect(calls.filter((c) => c.name === 'fillText').some((c) => String(c.font).includes('FlownCat'))).toBe(false)
  })
})
