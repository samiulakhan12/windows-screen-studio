/**
 * Captions Studio test 55 and the generation rules of §10.2 (docs/design/captions-studio.md): one
 * switch per kind, density, ownership, ids from content, chapter titles and lower thirds.
 */
import { describe, expect, it, vi } from 'vitest'
import { textHash } from '../src/shared/captions/captionTracks'
import { graphicId, planGraphics, type GraphicOptions } from '../src/shared/captions/graphicRules'
import { studioPreset } from '../src/shared/captions/studioPresets'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import { replacedAt } from '../src/shared/captions/replaced'
import { captionWordTimes } from '../src/shared/editor/transcript'
import { graphicDrawn } from '../src/shared/render/popSound'
import type { Bleep, CaptionSegment, Graphic, Project } from '../src/shared/types'
import { captions, studioProject } from './p4Fixtures'

vi.mock('../src/shared/captions/words', async (o) => (await import('./p1Fillins')).fillWords(await o()))
vi.mock('../src/shared/captions/studioLayout', async (o) => (await import('./p1Fillins')).fillLayout(await o(), await import('../src/shared/captions/words')))

const NONE: GraphicOptions = { keywords: false, emoji: false, counters: false, lists: false, speakers: false, chapters: false, quotes: false, sound: 'none' }
const kinds = (p: Project): string[] => (p.graphics ?? []).map((g) => g.kind)

describe('graphic generation (§10.2)', () => {
  it('ids come from content', () => {
    expect(graphicId('counter', 'c1', 3, '300%')).toBe(`g-${textHash('counter|c1|3|300%')}`)
  })

  it('an AI emoji goes on its word only when it is one of the chosen emoji', () => {
    const p = studioProject({ segments: captions(['Thanks to my boss Dave', 'Here is a great idea', 'We will celebrate tonight']) })
    const marks = {
      captions: [
        { id: 'c0', emphasis: [], emoji: '1f595', emojiWord: 3 },
        { id: 'c1', emphasis: [], emoji: '1f4a1', emojiWord: 4 },
        { id: 'c2', emphasis: [], emoji: '1f942', emojiWord: 2 }
      ],
      numbers: [],
      lists: [],
      quotes: []
    }
    const out = planGraphics(p, { ...NONE, emoji: true, marks, marksVia: 'gemini' })
    const ai = (out.graphics ?? []).filter((g): g is Extract<Graphic, { kind: 'emoji' }> => g.kind === 'emoji' && g.auto?.via === 'gemini')
    expect(ai.map((g) => `${g.emoji} ${g.anchor?.text}`)).toEqual(['1f4a1 idea'])
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

  it('a mostly Bangla transcript that names no language is read as Bangla, as its captions are (§0.2, §11.4)', () => {
    const plan = (texts: string[], opts: Partial<GraphicOptions>, marks?: GraphicOptions['marks']): Project[] =>
      [undefined, 'bn'].map((language) => {
        const p = studioProject({ segments: captions(texts), language: language as string })
        if (!language) delete (p.transcript as { language?: string }).language
        return planGraphics(p, { ...NONE, ...opts, ...(marks ? { marks, marksVia: 'gemini' as const } : {}) })
      })
    // Spoken numbers: তিনশো শতাংশ is 300%, বারো লক্ষ টাকা 12,00,000 টাকা, grouped as Bangla.
    const counters = plan(['আমাদের বিক্রি তিনশো শতাংশ বেড়েছে এই বছরে', 'আমাদের আয় বারো লক্ষ টাকা হয়েছে এই বছরে'], { counters: true }).map((p) =>
      (p.graphics ?? []).filter((g): g is Extract<Graphic, { kind: 'counter' }> => g.kind === 'counter').map((g) => [g.to, g.suffix, g.locale])
    )
    expect(counters[0]).toEqual([[300, '%', 'bn'], [1200000, ' টাকা', 'bn']])
    expect(counters[0]).toEqual(counters[1])
    // An emoji from a Bangla word (আগুন 🔥).
    const emoji = plan(['রান্নাঘরে হঠাৎ আগুন লেগে গেল সেদিন', 'আমরা আজ রাতে উদযাপন করব সবাই'], { emoji: true }).map((p) => (p.graphics ?? []).filter((g) => g.kind === 'emoji').map((g) => (g as Extract<Graphic, { kind: 'emoji' }>).emoji))
    expect(emoji[0]).toEqual(['1f525'])
    expect(emoji[0]).toEqual(emoji[1])
    // No AI emoji on a caption about a sensitive topic, in Bangla words too (মৃত্যু).
    const marks = { captions: [{ id: 'c0', emphasis: [], emoji: '1f525', emojiWord: 1 }], numbers: [], lists: [], quotes: [] }
    const ai = plan(['তার মৃত্যু আমাদের সবাইকে কাঁদিয়েছে', 'আমরা আবার শুরু করব'], { emoji: true }, marks).map((p) => (p.graphics ?? []).filter((g) => g.kind === 'emoji' && g.auto?.via === 'gemini').length)
    expect(ai).toEqual([0, 0])
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

  it('a bleeped word is never readable on a graphic: no keyword pop-up, AI list or quote on it, no counter label', () => {
    const segs = captions(['Now turn on Auto Save in the menu', 'and nothing else matters'])
    const pop = studioProject({ segments: segs, captions: { ...DEFAULT_CAPTIONS, studio: { ...studioPreset('bold-pop')!.look, layout: { ...studioPreset('bold-pop')!.look.layout, chunk: 'words', words: 3 } } } })
    const bleepOn = (seg: CaptionSegment, word: number, text: string): Bleep => {
      const w = captionWordTimes(seg)[word]
      return { id: `b-${text}`, start: w.start, end: w.end, word: text, sound: 'tone' }
    }
    const bleeps = [bleepOn(segs[0], 3, 'auto')]
    // Made before the bleep: the pop-up on "Auto Save".
    const before = planGraphics(pop, { ...NONE, keywords: true })
    const kw = before.graphics!.find((g) => g.kind === 'keyword')!
    expect(kw).toMatchObject({ text: 'Auto Save' })
    // Drawn after the bleep: the pop-up is not drawn, and its chunk shows with the mask.
    expect(graphicDrawn(before, kw)).toBe(true)
    expect(graphicDrawn({ ...before, bleeps }, kw)).toBe(false)
    expect(replacedAt({ ...before, bleeps }, kw.start + 0.01).chunks).toEqual([])
    // Made with the bleep: no pop-up, AI list or quote shows the word.
    const marks = { captions: [], numbers: [], lists: [{ id: 'c1', from: 0, to: 1, items: [{ id: 'c0', from: 3, to: 4 }, { id: 'c1', from: 2, to: 3 }] }], quotes: [{ id: 'c0', from: 0, to: 4 }] }
    const after = planGraphics({ ...pop, bleeps }, { ...NONE, keywords: true, lists: true, quotes: true, marks })
    expect(JSON.stringify([after.graphics ?? [], after.titles ?? []])).not.toMatch(/Auto/)
    // A counter's label is the word after its number: none when that word is bleeped.
    const stats = captions(['Users grew 300% damn fast this year'])
    const counted = studioProject({ segments: stats })
    expect(planGraphics(counted, { ...NONE, counters: true }).graphics![0]).toMatchObject({ kind: 'counter', label: 'damn' })
    const quiet = planGraphics({ ...counted, bleeps: [bleepOn(stats[0], 3, 'damn')] }, { ...NONE, counters: true }).graphics![0]
    expect(quiet).toMatchObject({ kind: 'counter', to: 300 })
    expect(quiet).not.toHaveProperty('label')
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

  it('quote cards asked for without the provider’s marks answer: the ones made stay', () => {
    const p = studioProject({ segments: captions(['Make every word count today', 'Then quiet']) })
    const marks = { captions: [], numbers: [], lists: [], quotes: [{ id: 'c0', from: 0, to: 4 }] }
    const once = planGraphics(p, { ...NONE, quotes: true, marks, marksVia: 'openai' })
    expect(once.titles?.map((c) => c.auto)).toEqual([{ by: 'quote', via: 'openai', caption: 'c0' }])
    // Add pop-ups from captions with Quotes on asks without marks.
    expect(planGraphics(once, { ...NONE, quotes: true })).toBe(once)
  })
})
