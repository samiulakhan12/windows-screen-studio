/**
 * Captions Studio test 43 (docs/design/captions-studio.md §11.8): the settle rule. Hand edits make
 * records and items the user's; automation's own updates keep them.
 */
import { describe, expect, it, vi } from 'vitest'
import { settleCaptionAuto } from '../src/shared/captions/captionAutoSettle'
import { DEFAULT_CLEANUP, tidyCaptions, type WordListEntry } from '../src/shared/captions/cleanup'
import { captionReviewItems, expandGroups, removeCaptionItems } from '../src/shared/review/captionReview'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import { studioPreset } from '../src/shared/captions/studioPresets'
import type { Bleep, CaptionMark, Graphic, Project, TitleCard } from '../src/shared/types'
import { captions, studioProject } from './p4Fixtures'

vi.mock('../src/shared/captions/marks', async (o) => (await import('./p1Fillins')).fillMarks(await o()))

const look = studioPreset('bold-pop')!.look
const segs = captions(['so i think this works', 'Second caption here'])
const mark: CaptionMark = { id: 'm1', caption: 'c1', from: 0, to: 0, text: 'Second', auto: true }
const counter: Graphic = {
  id: 'g1', kind: 'counter', from: 0, to: 300, decimals: 0, prefix: '', suffix: '%', locale: 'en', countFor: 1.2, start: 1, end: 3, place: 'auto', size: 0.11,
  enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 }, auto: { by: 'number', via: 'rules', caption: 'c0' }
}
const bleep: Bleep = { id: 'b1', start: 1, end: 1.4, word: 'damn', sound: 'tone', auto: true }
const card: TitleCard = { id: 't1', start: 4, end: 7, title: 'Priya', style: 'lower-third', background: 'blur', auto: { by: 'speaker', via: 'rules', caption: 'c1' } }
const base = (): Project =>
  studioProject({
    segments: segs,
    captions: { ...DEFAULT_CAPTIONS, studio: look },
    captionMarks: [mark],
    graphics: [counter],
    bleeps: [bleep],
    titles: [card],
    captionAuto: { style: { was: null, by: 'great', name: 'Bold Pop' }, text: [{ caption: 'c0', text: 'so i think this works' }] }
  })

describe('settleCaptionAuto (test 43)', () => {
  it('returns next itself when nothing changes', () => {
    const p = base()
    const q = { ...p, name: 'renamed' }
    expect(settleCaptionAuto(q, p)).toBe(q)
  })

  it('a hand edit makes a mark, graphic, bleep or title card the user’s', () => {
    const p = base()
    const q: Project = {
      ...p,
      captionMarks: [{ ...mark, tone: 2 }],
      graphics: [{ ...counter, to: 400 } as Graphic],
      bleeps: [{ ...bleep, end: 1.5 }],
      titles: [{ ...card, title: 'Priya S.' }]
    }
    const out = settleCaptionAuto(q, p)
    expect(out.captionMarks![0].auto).toBeUndefined()
    expect(out.graphics![0].auto).toBeUndefined()
    expect(out.bleeps![0].auto).toBeUndefined()
    expect(out.titles![0].auto).toBeUndefined()
  })

  it('automation’s own update keeps them (a new auto object); a brand-kit font rewrite keeps title cards automatic', () => {
    const p = base()
    const q: Project = { ...p, graphics: [{ ...counter, to: 400, auto: { ...counter.auto! } } as Graphic], titles: [{ ...card, font: 'cat:inter', auto: { ...card.auto! } }] }
    const out = settleCaptionAuto(q, p)
    expect(out.graphics![0].auto).toBeDefined()
    expect(out.titles![0].auto).toBeDefined()
  })

  it('showing captions, speaker names, the track or dragging the block keeps the style record; a look change drops it', () => {
    const p = base()
    for (const captions of [
      { ...p.captions!, show: false },
      { ...p.captions!, showSpeaker: true as const },
      { ...p.captions!, track: 'bn' },
      { ...p.captions!, studio: { ...look, layout: { ...look.layout, place: { x: 0.5, y: 0.2 } } } }
    ])
      expect(settleCaptionAuto({ ...p, captions }, p).captionAuto?.style).toBeDefined()
    const changed = settleCaptionAuto({ ...p, captions: { ...p.captions!, studio: { ...look, text: { ...look.text, size: 0.1 } } } }, p)
    expect(changed.captionAuto?.style).toBeUndefined()
    expect(changed.captionAuto?.text).toHaveLength(1)
    // Automation changing the look and the record together keeps it.
    const auto = settleCaptionAuto({ ...p, captions: { ...p.captions!, preset: 'bold' }, captionAuto: { ...p.captionAuto, style: { was: null, by: 'polish', name: 'X' } } }, p)
    expect(auto.captionAuto?.style?.name).toBe('X')
  })

  it('editing a tidied caption drops its text record', () => {
    const p = base()
    const segments = [{ ...segs[0], text: 'so I think this works well' }, segs[1]]
    const out = settleCaptionAuto({ ...p, transcript: { ...p.transcript!, segments } }, p)
    expect(out.captionAuto?.text).toBeUndefined()
    expect(out.captionAuto?.style).toBeDefined()
    // A word deleted in the Transcript tab changes the words too.
    const words = [{ text: 'so', start: 0, end: 0.5 }, { text: 'i', start: 0.5, end: 1, deleted: true as const }]
    const withWords = { ...p, transcript: { ...p.transcript!, segments: [{ ...segs[0], words: [{ text: 'so', start: 0, end: 0.5 }, { text: 'i', start: 0.5, end: 1 }] }, segs[1]] } }
    const deleted = { ...withWords, transcript: { ...withWords.transcript, segments: [{ ...withWords.transcript.segments[0], words }, segs[1]] } }
    expect(settleCaptionAuto(deleted, withWords).captionAuto?.text).toBeUndefined()
  })

  it('marks follow their words when a caption changes', () => {
    const p = base()
    const segments = [segs[0], { ...segs[1], text: 'A Second caption here' }]
    const out = settleCaptionAuto({ ...p, transcript: { ...p.transcript!, segments } }, p)
    expect(out.captionMarks![0]).toMatchObject({ caption: 'c1', from: 1, to: 1, text: 'Second', auto: true })
  })

  it('a second tidy keeps a caption’s first record; Remove then puts back the words from before the first tidy', () => {
    const p0 = studioProject({ segments: captions(['today we open flow in', 'then flow in opens them']) })
    const tidy = (p: Project, words: WordListEntry[]): Project => settleCaptionAuto(tidyCaptions(p, { ...DEFAULT_CLEANUP, words }).project, p)
    const once = tidy(p0, [])
    expect(once.captionAuto?.text?.map((r) => r.text)).toEqual(['today we open flow in', 'then flow in opens them'])
    const twice = tidy(once, [{ term: 'Flown', heard: ['flow in'] }])
    expect(twice.transcript!.segments.map((s) => s.text)).not.toEqual(once.transcript!.segments.map((s) => s.text))
    expect(twice.captionAuto?.text).toEqual(once.captionAuto?.text)
    const back = settleCaptionAuto(removeCaptionItems(twice, expandGroups(captionReviewItems(twice))), twice)
    expect(back.transcript!.segments.map((s) => s.text)).toEqual(['today we open flow in', 'then flow in opens them'])
    expect(back.captionAuto).toBeUndefined()
    // A hand edit afterwards still makes that caption the user's.
    const segments = twice.transcript!.segments.map((s) => (s.id === 'c0' ? { ...s, text: 'Hand edited' } : s))
    expect(settleCaptionAuto({ ...twice, transcript: { ...twice.transcript!, segments } }, twice).captionAuto?.text?.map((r) => r.caption)).toEqual(['c1'])
  })
})
