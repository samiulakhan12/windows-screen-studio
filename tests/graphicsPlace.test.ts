import { describe, expect, it } from 'vitest'
import type { Rect } from '../src/shared/engine/layout'
import { counterText, GRAPHIC_DEFAULTS, graphicCandidates, placeGraphic } from '../src/shared/render/graphics'
import type { CounterGraphic } from '../src/shared/types'

/* Test 21 (docs/design/captions-studio.md §16.1): graphics placement (§10.3), and counter text (§10.1). */

const W = 1920
const H = 1080
const AREA: Rect = { x: 65, y: 65, w: W - 130, h: H - 130 }
const none = { captions: [] as Rect[], camera: [] as Rect[], action: [] as Rect[], safe: [] as Rect[], graphics: [] as Rect[] }
const boxAt = (p: { x: number; y: number; scale: number }, b: { w: number; h: number }): Rect => ({ x: p.x - (b.w * p.scale) / 2, y: p.y - (b.h * p.scale) / 2, w: b.w * p.scale, h: b.h * p.scale })
const hits = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('candidates (§10.3)', () => {
  it('come in the order of the table, wide and tall', () => {
    expect(graphicCandidates('keyword', W, H, { camera: null, action: null })).toEqual([
      { x: 960, y: 0.28 * H },
      { x: 960, y: 540 },
      { x: 960, y: 0.62 * H }
    ])
    expect(graphicCandidates('keyword', 1080, 1920, { camera: null, action: null })[0]).toEqual({ x: 540, y: 0.3 * 1920 })
    expect(graphicCandidates('emoji', W, H, { camera: null, action: null })).toEqual([
      { x: 0.8 * W, y: 0.25 * H },
      { x: 0.2 * W, y: 0.25 * H }
    ])
    expect(graphicCandidates('counter', W, H, { camera: null, action: null })[0]).toEqual({ x: 960, y: 0.35 * H })
    expect(graphicCandidates('list', W, H, { camera: null, action: null })[1]).toEqual({ x: 960, y: 540 })
  })

  it('a replacing keyword comes first where its chunk was; an anchored emoji above its word', () => {
    const chunk: Rect = { x: 700, y: 900, w: 520, h: 100 }
    expect(graphicCandidates('keyword', W, H, { camera: null, action: null }, chunk)[0]).toEqual({ x: 960, y: 950 })
    const word: Rect = { x: 800, y: 900, w: 120, h: 60 }
    const above = graphicCandidates('emoji', W, H, { camera: null, action: null }, word)[0]
    expect(above.x).toBe(860)
    expect(above.y).toBeLessThan(900)
  })

  it('a list takes the third away from the camera and the action', () => {
    const camera: Rect = { x: 1500, y: 700, w: 380, h: 340 }
    expect(graphicCandidates('list', W, H, { camera, action: null })[0].x).toBeCloseTo(0.22 * W, 6)
    const action: Rect = { x: 100, y: 400, w: 80, h: 80 }
    expect(graphicCandidates('list', W, H, { camera: null, action })[0].x).toBeCloseTo(0.78 * W, 6)
  })
})

describe('placement (test 21)', () => {
  const box = { w: 400, h: 160 }

  it('takes the first candidate with no overlap', () => {
    const c = graphicCandidates('keyword', W, H, { camera: null, action: null })
    expect(placeGraphic(box, c, AREA, none)).toEqual({ x: 960, y: 0.28 * H, scale: 1 })
    const blocked = placeGraphic(box, c, AREA, { ...none, graphics: [{ x: 700, y: 200, w: 500, h: 200 }] })
    expect(blocked).toEqual({ x: 960, y: 540, scale: 1 })
  })

  it('never covers captions while a candidate is free', () => {
    const c = graphicCandidates('keyword', W, H, { camera: null, action: null })
    const captions = [{ x: 300, y: 200, w: 1300, h: 200 }]
    const p = placeGraphic(box, c, AREA, { ...none, captions })
    expect(hits(boxAt(p, box), captions[0])).toBe(false)
  })

  it('a list card never covers the cursor while a free candidate exists', () => {
    const list = { w: 0.42 * W, h: 360 }
    const cursor: Rect = { x: 300, y: 450, w: 90, h: 90 }
    const c = graphicCandidates('list', W, H, { camera: null, action: cursor })
    const p = placeGraphic(list, c, AREA, { ...none, action: [cursor] })
    expect(hits(boxAt(p, list), cursor)).toBe(false)
  })

  it('shrinks the first candidate (down to 0.6) when no candidate is free at full size', () => {
    const c = graphicCandidates('keyword', W, H, { camera: null, action: null })
    // Everything but a 300 px high band around the first candidate is taken.
    const graphics = [
      { x: 0, y: 0, w: W, h: 0.28 * H - 150 },
      { x: 0, y: 0.28 * H + 150, w: W, h: H }
    ]
    const tall = { w: 400, h: 400 }
    const p = placeGraphic(tall, c, AREA, { ...none, graphics })
    expect(p.scale).toBeLessThan(1)
    expect(p.scale).toBeGreaterThanOrEqual(0.6)
    expect(graphics.some((g) => hits(boxAt(p, tall), g))).toBe(false)
  })

  it('else takes the least overlap that never covers a caption', () => {
    const c = graphicCandidates('keyword', W, H, { camera: null, action: null })
    const captions = [{ x: 0, y: 0, w: W, h: 400 }]
    const graphics = [{ x: 0, y: 400, w: W, h: H - 400 }]
    const p = placeGraphic({ w: 400, h: 400 }, c, AREA, { ...none, captions, graphics })
    expect(hits(boxAt(p, { w: 400, h: 400 }), captions[0])).toBe(false)
  })

  it('is a pure function: the same obstacles over its time keep a graphic still', () => {
    const c = graphicCandidates('counter', W, H, { camera: null, action: null })
    const obstacles = { ...none, captions: [{ x: 300, y: 900, w: 1300, h: 120 }], action: [{ x: 900, y: 330, w: 80, h: 80 }] }
    const a = placeGraphic(box, c, AREA, obstacles)
    for (let i = 0; i < 5; i++) expect(placeGraphic(box, c, AREA, structuredClone(obstacles))).toEqual(a)
  })

  it('keeps boxes inside the area', () => {
    const p = placeGraphic({ w: 600, h: 200 }, [{ x: 10, y: 10 }], AREA, none)
    expect(p.x - 300).toBeGreaterThanOrEqual(AREA.x - 1e-9)
    expect(p.y - 100).toBeGreaterThanOrEqual(AREA.y - 1e-9)
  })
})

describe('counter text (§10.1)', () => {
  const counter = (extra: Partial<CounterGraphic>): CounterGraphic =>
    ({ id: 'c', kind: 'counter', start: 0, end: 3, place: 'auto', size: 0.11, enter: GRAPHIC_DEFAULTS.counter.enter, exit: GRAPHIC_DEFAULTS.counter.exit, from: 0, to: 300, decimals: 0, prefix: '', suffix: '%', locale: 'en', countFor: 1.2, ...extra }) as CounterGraphic

  it('formats with fixed decimals for the locale, with its prefix and suffix and digit cells', () => {
    expect(counterText(counter({}), 299.6)).toEqual({ text: '300%', cells: 3 })
    expect(counterText(counter({ decimals: 1, prefix: '$', suffix: 'M' }), 1.2)).toEqual({ text: '$1.2M', cells: 2 })
    expect(counterText(counter({ locale: 'bn', decimals: 1, suffix: '' }), 1234567.5).text).toBe('১২,৩৪,৫৬৭.৫')
    expect(counterText(counter({ locale: 'bn', suffix: '' }), 300).cells).toBe(3)
  })

  it('follows the Digits choice (§0.2)', () => {
    expect(counterText(counter({ locale: 'bn' }), 300, 'western').text).toBe('300%')
    expect(counterText(counter({ locale: 'en' }), 300, 'native').text).toBe('300%')
    expect(counterText(counter({ locale: 'bn-BD' }), 300, 'native').text).toBe('৩০০%')
  })
})
