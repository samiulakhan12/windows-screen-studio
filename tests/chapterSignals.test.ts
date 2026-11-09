/**
 * Test 35 of docs/design/smart-tools.md §22.1: the candidates of each signal (§7.3) and how they
 * merge and snap.
 */
import { describe, expect, it } from 'vitest'
import { aiCandidates, cardCandidates, CHAPTER_RULES, cueCandidates, mergeCandidates, pauseCandidates, sentenceCue, type Candidate } from '../src/shared/chapters/signals'
import type { TitleCard } from '../src/shared/types'
import { segmentsOf } from './chapterFixtures'

const card = (start: number, extra: Partial<TitleCard> = {}): TitleCard => ({ id: `t${start}`, start, end: start + 3, title: 'Billing', style: 'lower-third', background: 'blur', ...extra })
const cand = (t: number, from: Candidate['from'], score: number, extra: Partial<Candidate> = {}): Candidate => ({ t, v: t, score, from, ...extra })

describe('pauses and idle input', () => {
  it('a 2.0 s pause gives 1.5 at the next speech start, 1.6 s gives 0.75, 1.4 s nothing', () => {
    expect(pauseCandidates([{ start: 0, end: 5 }, { start: 7, end: 9 }], null)).toEqual([{ t: 7, v: 7, score: 1.5, from: ['pause'] }])
    expect(pauseCandidates([{ start: 0, end: 5 }, { start: 6.6, end: 9 }], null)).toEqual([{ t: 6.6, v: 6.6, score: 0.75, from: ['pause'] }])
    expect(pauseCandidates([{ start: 0, end: 5 }, { start: 6.4, end: 9 }], null)).toEqual([])
    // The first speech start is not after a pause between ranges.
    expect(pauseCandidates([{ start: 4, end: 5 }], null)).toEqual([])
    expect(CHAPTER_RULES.score.pause).toBe(1.5)
    expect(CHAPTER_RULES.score.shortPause).toBe(0.75)
  })

  it('an input gap of 3 s gives 1 at its end; a shorter one nothing', () => {
    expect(pauseCandidates(null, [{ start: 10, end: 13 }, { start: 20, end: 22.9 }])).toEqual([{ t: 13, v: 13, score: 1, from: ['idle'] }])
  })
})

describe('cue words at a sentence start', () => {
  const said = (text: string, t = 10) => segmentsOf([{ t, text }])

  it('"now" gives 1, "moving on" and "ধাপ ২" give 2.5, in the middle nothing', () => {
    expect(cueCandidates(said('Now open the settings page.'))).toEqual([{ t: 10, v: 10, score: 1, from: ['cue'] }])
    expect(cueCandidates(said('Moving on, the billing page.'))).toEqual([{ t: 10, v: 10, score: 2.5, from: ['section'] }])
    expect(cueCandidates(said('ধাপ ২ সেটিংস খুলুন।'), 'bn')).toEqual([{ t: 10, v: 10, score: 2.5, from: ['section'] }])
    expect(cueCandidates(said('Step 3 is the export.'))).toEqual([{ t: 10, v: 10, score: 2.5, from: ['section'] }])
    expect(cueCandidates(said('We click the button now and then move on.'))).toEqual([])
    expect(cueCandidates(said('Open the page, now we wait.'))).toEqual([])
  })

  it('a sentence with both counts once, as 2.5', () => {
    expect(cueCandidates(said("Now let's move on to billing."))).toEqual([{ t: 10, v: 10, score: 2.5, from: ['section'] }])
    expect(cueCandidates(said('Okay so finally the export.'))).toEqual([{ t: 10, v: 10, score: 2.5, from: ['section'] }])
    expect(sentenceCue(['Next', 'step', 'is', 'export'])).toBe('section')
    expect(sentenceCue(['Next,', 'we', 'export'])).toBe('cue')
    expect(sentenceCue(['Export', 'next'])).toBeNull()
  })

  it('every sentence of a caption is read: a cue after a sentence end counts there', () => {
    const segs = segmentsOf([{ t: 0, text: 'This is the plan. Now the invoices.' }])
    const found = cueCandidates(segs)
    expect(found).toHaveLength(1)
    expect(found[0].score).toBe(1)
    expect(found[0].t).toBeCloseTo(4 * 0.35, 6)
  })
})

describe('title cards and AI suggestions', () => {
  it("a user's lower-third card gives 4; a Captions Studio chapter-title card nothing", () => {
    expect(cardCandidates([card(30)])).toEqual([{ t: 30, v: 30, score: 4, from: ['card'] }])
    expect(cardCandidates([card(30, { style: 'centered' }), card(60, { style: 'big' })]).map((c) => c.score)).toEqual([4, 4])
    expect(cardCandidates([card(30, { auto: { by: 'chapter', via: 'rules', chapter: 'c1' } })])).toEqual([])
    // A quote card or the brand kit's intro is not a section start.
    expect(cardCandidates([card(5, { style: 'quote' }), card(0, { brand: 'intro' })])).toEqual([])
  })

  it('an AI suggestion gives 3.5 with its title', () => {
    expect(aiCandidates([{ t: 12.3, title: 'Settings' }])).toEqual([{ t: 12.3, v: 12.3, score: 3.5, from: ['ai'], ai: { title: 'Settings' } }])
  })
})

describe('merging and snapping', () => {
  it('candidates 1.9 s apart merge with the kinds summed; 2.1 s apart do not', () => {
    const merged = mergeCandidates([cand(10, ['page'], 3.5), cand(11.9, ['pause'], 1.5)], [])
    expect(merged).toHaveLength(1)
    expect(merged[0].score).toBe(5)
    expect(merged[0].from).toEqual(['page', 'pause'])
    expect(mergeCandidates([cand(10, ['page'], 3.5), cand(12.1, ['pause'], 1.5)], [])).toHaveLength(2)
  })

  it('the best of each kind counts once: two pauses do not add up', () => {
    const merged = mergeCandidates([cand(10, ['pause'], 0.75), cand(11, ['pause'], 1.5), cand(11.5, ['cue'], 1)], [])
    expect(merged).toHaveLength(1)
    expect(merged[0].score).toBe(2.5)
    // A page change and a screen change are one kind.
    expect(mergeCandidates([cand(10, ['page'], 3.5), cand(10.5, ['screen'], 1.5)], [])[0].score).toBe(3.5)
  })

  it('moves to the nearest sentence start within 2 s; else stays at the screen change or the speech start', () => {
    expect(mergeCandidates([cand(10, ['page'], 3.5)], [8.4, 11.5]).map((c) => c.t)).toEqual([11.5])
    // Equally near: the earlier.
    expect(mergeCandidates([cand(10, ['page'], 3.5)], [8.5, 11.5]).map((c) => c.t)).toEqual([8.5])
    expect(mergeCandidates([cand(10, ['page'], 3.5)], [9.4, 11.5]).map((c) => c.t)).toEqual([9.4])
    expect(mergeCandidates([cand(10, ['page'], 3.5)], [7.9, 12.1]).map((c) => c.t)).toEqual([10])
    expect(mergeCandidates([cand(10, ['idle'], 1), cand(11, ['pause'], 1.5)], [20]).map((c) => c.t)).toEqual([11])
    // An AI suggestion snaps too, and keeps its title.
    expect(mergeCandidates(aiCandidates([{ t: 12.3, title: 'Settings' }]), [12.4])).toEqual([{ t: 12.4, v: 12.4, score: 3.5, from: ['ai'], ai: { title: 'Settings' } }])
    // A title card's start stays where the card starts.
    expect(mergeCandidates([cand(30, ['card'], 4), cand(31, ['pause'], 1.5)], [31]).map((c) => c.t)).toEqual([30])
  })
})
