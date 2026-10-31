/**
 * Captions Studio test 55 and the generation rules of §10.2 (docs/design/captions-studio.md): one
 * switch per kind, density, ownership, ids from content, chapter titles and lower thirds.
 */
import { describe, expect, it, vi } from 'vitest'
import { textHash } from '../src/shared/captions/captionTracks'
import { graphicId, planGraphics, type GraphicOptions } from '../src/shared/captions/graphicRules'
import { studioPreset } from '../src/shared/captions/studioPresets'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import type { Graphic, Project } from '../src/shared/types'
import { captions, studioProject } from './p4Fixtures'

vi.mock('../src/shared/captions/words', async (o) => (await import('./p1Fillins')).fillWords(await o()))
vi.mock('../src/shared/captions/studioLayout', async (o) => (await import('./p1Fillins')).fillLayout(await o(), await import('../src/shared/captions/words')))

const NONE: GraphicOptions = { keywords: false, emoji: false, counters: false, lists: false, speakers: false, chapters: false, quotes: false, sound: 'none' }
const kinds = (p: Project): string[] => (p.graphics ?? []).map((g) => g.kind)

describe('graphic generation (§10.2)', () => {
  it('ids come from content', () => {
    expect(graphicId('counter', 'c1', 3, '300%')).toBe(`g-${textHash('counter|c1|3|300%')}`)
  })

  it('counters for statistics only, starting 0.1 s before the number', () => {
    const p = studioProject({ segments: captions(['Revenue grew 300% this year', 'Set the width to 300 pixels', 'There are 12 options']) })
    const out = planGraphics(p, { ...NONE, counters: true })
    expect(kinds(out)).toEqual(['counter'])
    const g = out.graphics![0] as Extract<Graphic, { kind: 'counter' }>
    expect(g).toMatchObject({ to: 300, from: 0, suffix: '%', decimals: 0, locale: 'en', place: 'auto', auto: { by: 'number', via: 'rules', caption: 'c0' } })
    expect(g.countFor).toBeGreaterThanOrEqual(1.2)
    expect(g.end - g.start).toBeCloseTo(g.countFor + 1)
  })

  it('list cards from spoken lists', () => {
    const p = studioProject({ segments: captions(['Exporting takes three steps.', 'First, open the Settings page.', 'Second, choose the format.', 'Finally, click Export.']) })
    const out = planGraphics(p, { ...NONE, lists: true })
    const list = out.graphics![0] as Extract<Graphic, { kind: 'list' }>
    expect(list).toMatchObject({ kind: 'list', marker: 'number', auto: { by: 'list', caption: 'c0' } })
    expect(list.items.map((i) => i.text)).toEqual(['Open the Settings page', 'Choose the format', 'Click Export'])
    expect(list.end).toBeCloseTo(list.items[2].at + 2)
  })

  it('keyword pop-ups only for looks of a few words, one word or stacked words, on their chunk', () => {
    const segs = captions(['Now turn on Auto Save in the menu', 'and nothing else matters'])
    const subtitle = studioProject({ segments: segs, captions: { ...DEFAULT_CAPTIONS, studio: studioPreset('subtitle')!.look } })
    expect(planGraphics(subtitle, { ...NONE, keywords: true }).graphics).toBeUndefined()
    const pop = studioProject({ segments: segs, captions: { ...DEFAULT_CAPTIONS, studio: { ...studioPreset('bold-pop')!.look, layout: { ...studioPreset('bold-pop')!.look.layout, chunk: 'words', words: 3 } } } })
    const out = planGraphics(pop, { ...NONE, keywords: true })
    const k = out.graphics?.find((g) => g.kind === 'keyword') as Extract<Graphic, { kind: 'keyword' }>
    expect(k).toMatchObject({ text: 'Auto Save', look: 'card', anchor: { caption: 'c0', from: 3, to: 4, text: 'Auto Save' } })
  })

  it('lower thirds only for names the user typed', () => {
    const segs = captions(['Hi there', 'Hello', 'And me']).map((s, i) => ({ ...s, speaker: ['You', 'Priya', 'Speaker 2'][i] }))
    const out = planGraphics(studioProject({ segments: segs }), { ...NONE, speakers: true })
    expect(out.titles?.map((t) => [t.title, t.style, t.auto?.by])).toEqual([['Priya', 'lower-third', 'speaker']])
    expect(out.titles![0].end - out.titles![0].start).toBeCloseTo(3)
  })

  it('test 55: one chapter title per chapter, none in the first 2 s, 2.5 s long, one per 30 s', () => {
    const chapters = [
      { id: 'a', t: 1, title: 'Intro' },
      { id: 'b', t: 10, title: 'Export settings' },
      { id: 'c', t: 25, title: 'Too soon' },
      { id: 'd', t: 50, title: 'Wrap up' }
    ]
    const p = studioProject({ segments: captions(['Hello']), chapters, duration: 90 })
    const out = planGraphics(p, { ...NONE, chapters: true, sound: 'pop' })
    expect(out.titles!.map((t) => t.title)).toEqual(['Export settings', 'Wrap up'])
    const t = out.titles![0]
    expect(t).toMatchObject({ style: 'lower-third', auto: { by: 'chapter', via: 'rules', chapter: 'b' } })
    expect(t.start).toBeCloseTo(10.3)
    expect(t.end - t.start).toBeCloseTo(2.5)
    expect('sound' in t).toBe(false)
  })

  it('density: 1.5 s apart, none on sensitive captions, none just after a pause freeze', () => {
    const texts = ['It grew 300% fast', 'It grew 200% more', 'Then 50% less', 'Our CEO died and sales fell 40%']
    const segs = captions(texts, 'c', 1)
    const out = planGraphics(studioProject({ segments: segs }), { ...NONE, counters: true })
    const starts = out.graphics!.map((g) => g.start)
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1.5)
    expect(out.graphics!.some((g) => g.auto?.caption === 'c3')).toBe(false)
    const start = planGraphics(studioProject({ segments: captions(['It grew 300% fast']) }), { ...NONE, counters: true }).graphics![0].start
    const frozen = (at: number) => studioProject({ segments: captions(['It grew 300% fast']), freezes: [{ id: 'f', at, length: 2, sound: 'pause' }] })
    expect(planGraphics(frozen(start - 0.3), { ...NONE, counters: true }).graphics).toBeUndefined()
    expect(planGraphics(frozen(start - 0.7), { ...NONE, counters: true }).graphics).toHaveLength(1)
  })

  it('at most 5 a minute in wide frames, 8 in tall ones', () => {
    const texts = Array.from({ length: 20 }, (_, i) => `Sales grew ${(i + 2) * 10}% here`)
    const segs = captions(texts, 'c', 2.5)
    expect(planGraphics(studioProject({ segments: segs }), { ...NONE, counters: true }).graphics!.filter((g) => g.start < 59).length).toBeLessThanOrEqual(5)
    expect(planGraphics(studioProject({ segments: segs, aspect: '9:16' }), { ...NONE, counters: true }).graphics!.filter((g) => g.start < 59).length).toBe(8)
  })

  it('keeps the user’s items, replaces automatic ones, and gives the same project on a second run', () => {
    const segs = captions(['Revenue grew 300% this year', 'Then quiet', 'Costs fell 20% too'], 'c', 5)
    const mine: Graphic = { id: 'mine', kind: 'keyword', text: 'Hi', look: 'card', start: 12, end: 13, place: 'auto', size: 0.09, enter: { kind: 'fade', duration: 0.2, strength: 1 }, exit: { kind: 'fade', duration: 0.2, strength: 1 } }
    const p = studioProject({ segments: segs, graphics: [mine] })
    const once = planGraphics(p, { ...NONE, counters: true, sound: 'pop' })
    expect(once.graphics!.map((g) => g.id)).toContain('mine')
    // The counter at 12.5 is within 1.5 s of the user's graphic: not made.
    expect(once.graphics!.filter((g) => g.kind === 'counter')).toHaveLength(1)
    expect(once.graphics!.find((g) => g.kind === 'counter')!.sound).toBe('pop')
    expect(planGraphics(once, { ...NONE, counters: true, sound: 'pop' })).toBe(once)
    // Turned off: the run leaves that kind alone.
    expect(planGraphics(once, { ...NONE })).toBe(once)
  })
})
