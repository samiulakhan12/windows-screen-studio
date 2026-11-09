/**
 * Short clips' sentences (docs/design/smart-tools.md §8.1, §22.1 test 49): each sentence's
 * features (how packed it is, its key words, the user's emphasis, statistics, what happens on
 * screen, fillers, Focus on), the earlier takes of retakes marked, sentences under 3 words left out.
 */
import { describe, expect, it } from 'vitest'
import { clipSentences, focusKey, focusWords, scoredSentences } from '../src/shared/clips/sentences'
import type { CaptionMark, Project } from '../src/shared/types'
import { clipProject, NO_TRACK, scanOf, trackOf, type Said } from './clipFixtures'

const SAID: Said[] = [
  { t: 1, text: 'We open the billing page and check the totals.' },
  { t: 6, text: 'Click Export to save the yearly report now.' },
  { t: 11, text: 'Um so uh this is um like the thing.' },
  { t: 16, text: 'Revenue grew 40% to 2 million users this year.', per: 0.25 },
  { t: 21, text: "Billing's settings live under the account menu.", per: 0.5 },
  { t: 27, text: 'Okay.' },
  { t: 30, text: 'Then we open the settings page.' },
  { t: 34, text: 'Then we open the settings page again.' },
  { t: 40, text: 'The second tab shows the history list.' }
]

function fixture(over: Partial<Project> = {}): Project {
  return clipProject({ said: SAID, duration: 50, ...over })
}

const byText = <T extends { text: string }>(list: readonly T[], start: string): T => list.find((s) => s.text.startsWith(start))!

describe('the sentences short clips are picked from (test 49)', () => {
  it('sentences under 3 words are left out; the earlier take of a retake is marked; times and words are the kept ones', () => {
    const list = scoredSentences(fixture(), { track: null, scan: null })
    expect(list.map((s) => s.text)).toEqual([
      'We open the billing page and check the totals.',
      'Click Export to save the yearly report now.',
      'Um so uh this is um like the thing.',
      'Revenue grew 40% to 2 million users this year.',
      "Billing's settings live under the account menu.",
      'Then we open the settings page.',
      'Then we open the settings page again.',
      'The second tab shows the history list.'
    ])
    expect(list.map((s) => s.retake)).toEqual([false, false, false, false, false, true, false, false])
    const first = list[0]
    expect(first.start).toBeCloseTo(1, 6)
    expect(first.end).toBeCloseTo(1 + 8 * 0.35 + 0.28, 6)
    expect(first.words).toBe(9)
    expect(first.seconds).toBeCloseTo(first.end - first.start, 6)
  })

  it('density is words a second, z-scored; a 2× clip doubles a sentence’s words a second', () => {
    const list = scoredSentences(fixture(), { track: null, scan: null })
    const fast = byText(list, 'Revenue')
    const slow = byText(list, "Billing's")
    expect(fast.features.density).toBeGreaterThan(0)
    expect(slow.features.density).toBeLessThan(0)
    // z-scores: they sum to 0.
    expect(list.reduce((s, x) => s + x.features.density, 0)).toBeCloseTo(0, 6)
    // At 2× the slow sentence takes half the viewing time.
    const sped = scoredSentences(fixture({ clips: [{ id: 'a', start: 0, end: 20.5, speed: 1 }, { id: 'b', start: 20.5, end: 26, speed: 2 }, { id: 'c', start: 26, end: 50, speed: 1 }] }), { track: null, scan: null })
    expect(byText(sped, "Billing's").seconds).toBeCloseTo(slow.seconds / 2, 6)
  })

  it('key words: the sum of scores of 2.5 or more a second, z-scored; a filler sentence has none', () => {
    const list = scoredSentences(fixture(), { track: null, scan: null })
    expect(byText(list, 'Click Export').features.keywords).toBeGreaterThan(byText(list, 'Um so').features.keywords)
    expect(list.reduce((s, x) => s + x.features.keywords, 0)).toBeCloseTo(0, 6)
  })

  it('the user’s emphasis counts +1; an automatic mark does not', () => {
    const marks: CaptionMark[] = [
      { id: 'm1', caption: 's0', from: 3, to: 3, text: 'billing' },
      { id: 'm2', caption: 's8', from: 2, to: 2, text: 'second', auto: true }
    ]
    const list = scoredSentences(fixture({ captionMarks: marks }), { track: null, scan: null })
    expect(byText(list, 'We open').features.emphasis).toBe(1)
    expect(byText(list, 'The second').features.emphasis).toBe(0)
    expect(byText(list, 'Click').features.emphasis).toBe(0)
  })

  it('statistics: +0.5 each, at most +1', () => {
    const list = scoredSentences(fixture(), { track: null, scan: null })
    expect(byText(list, 'Revenue').features.numbers).toBe(1)
    // Three statistics (one sentence over two captions) still give 1.
    const first = 'Revenue grew 40% to 2 million users'
    const second = 'and sales reached $900 in May.'
    const three = scoredSentences(
      clipProject({ said: [{ t: 1, text: first }, { t: 1 + (first.split(' ').length - 1) * 0.35 + 0.28 + 0.1, text: second }, { t: 9, text: 'Nothing else changed in the report at all.' }], duration: 20 }),
      { track: null, scan: null }
    )
    expect(three[0].text).toBe(`${first} ${second}`)
    expect(three[0].features.numbers).toBe(1)
    expect(byText(list, 'We open').features.numbers).toBe(0)
    const one = scoredSentences(clipProject({ said: [{ t: 1, text: 'Sales grew 40% in the north this spring.' }, { t: 6, text: 'Nothing else changed in the report at all.' }], duration: 20 }), { track: null, scan: null })
    expect(one[0].features.numbers).toBe(0.5)
  })

  it('action: clicks, typing, zoom starts and settled screen changes inside it, min(1, count / 3)', () => {
    const track = trackOf({ clicks: [{ t: 7, x: 0.5, y: 0.5, button: 'left' }], typing: [{ t: 7.5, end: 8 }] })
    const p = fixture({ zooms: [{ id: 'z', start: 8, end: 10, scale: 2, focus: { mode: 'cursor' } } as Project['zooms'][number]] })
    const list = scoredSentences(p, { track, scan: null })
    expect(byText(list, 'Click').features.action).toBe(1)
    expect(byText(list, 'We open').features.action).toBe(0)
    // One screen change that settles inside the first sentence.
    const scanned = scoredSentences(fixture(), { track: NO_TRACK, scan: scanOf(50, { 2: 60 }) })
    expect(byText(scanned, 'We open').features.action).toBeCloseTo(1 / 3, 9)
  })

  it('fillers: fillers a second, z-scored (subtracted from the score)', () => {
    const list = scoredSentences(fixture(), { track: null, scan: null })
    const most = [...list].sort((a, b) => b.features.fillers - a.features.fillers)[0]
    expect(most.text).toBe('Um so uh this is um like the thing.')
    expect(most.features.fillers).toBeGreaterThan(1)
  })

  it('Focus on: “billing” matches “Billing’s” (first 5 letters in Latin scripts), +2; whole words in other scripts', () => {
    const list = scoredSentences(fixture(), { track: null, scan: null, focus: 'billing' })
    expect(byText(list, "Billing's").features.focus).toBe(2)
    expect(byText(list, 'We open').features.focus).toBe(2)
    expect(byText(list, 'Click').features.focus).toBe(0)
    expect(byText(clipSentences(fixture(), { track: null, scan: null, focus: 'billing, export' }), "Billing's").focusWord).toBe('billing')
    expect(focusKey("Billing's")).toBe(focusKey('billing'))
    expect(focusKey('বিলিং')).toBe('বিলিং')
    expect(focusKey('বিলিংয়ের')).not.toBe(focusKey('বিলিং'))
    expect(focusWords(' billing,, Export ').map((w) => w.word)).toEqual(['billing', 'Export'])
    // Without Focus on, nothing gets it.
    expect(scoredSentences(fixture(), { track: null, scan: null }).every((s) => s.features.focus === 0)).toBe(true)
  })

  it('cut words are left out; each sentence knows the user chapter it starts in', () => {
    // The first sentence's words cut away entirely.
    const cut = scoredSentences(fixture({ clips: [{ id: 'a', start: 5, end: 50, speed: 1 }] }), { track: null, scan: null })
    expect(cut[0].text).toBe('Click Export to save the yearly report now.')
    const chaptered = scoredSentences(
      fixture({
        chapters: [
          { id: 'c1', t: 0, title: 'Intro' },
          { id: 'c2', t: 20, title: 'Settings' },
          { id: 'f', t: 33, title: 'Found', auto: { by: 'find', from: ['pause'], name: 'sentence' } }
        ]
      }),
      { track: null, scan: null }
    )
    expect(chaptered.map((s) => s.chapter)).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
  })

  it('read again only when what they come from changes (the panel asks on every edit)', () => {
    const p = fixture()
    const first = clipSentences(p, { track: null, scan: null })
    expect(clipSentences({ ...p, style: { ...p.style, padding: 0.2 } }, { track: null, scan: null })).toBe(first)
    expect(clipSentences({ ...p, name: 'Renamed' }, { track: null, scan: null })).toBe(first)
    const cut = clipSentences({ ...p, clips: [{ id: 'a', start: 5, end: 50, speed: 1 }] }, { track: null, scan: null })
    expect(cut).not.toBe(first)
    expect(clipSentences(p, { track: null, scan: null, focus: 'billing' })).not.toBe(cut)
  })
})
