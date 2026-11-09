/**
 * Find short clips (docs/design/smart-tools.md §8.2-§8.4; §22.1 tests 50-54, 61 and 62): the
 * candidates and their lengths in viewing time, each score term, the picks, the reasons, silent
 * recordings, the speed of a 1-hour recording and Bangla.
 */
import { describe, expect, it } from 'vitest'
import { clipSentences } from '../src/shared/clips/sentences'
import { CLIP_RULES, findMoments, hookOf, lengthTerm, momentCount, momentTitle, refersBack, type Moment } from '../src/shared/clips/moments'
import { planShort } from '../src/shared/clips/short60'
import { planOf, videoTimeAt } from '../src/shared/engine/freeze'
import type { Clip, Project } from '../src/shared/types'
import { clipProject, NO_TRACK, scanOf, steadyTalk, trackOf, type Said } from './clipFixtures'

const SLOW = process.env.CI ? 6 : 1
const moments = (p: Project, opts: Partial<Parameters<typeof findMoments>[1]> = {}): Moment[] => {
  const out = findMoments(p, { track: null, scan: null, length: 'any', ...opts })
  if (!Array.isArray(out)) throw new Error(`no moments: ${out.reason}`)
  return out
}
const viewing = (p: Project, a: number, b: number): number => videoTimeAt(p.clips, planOf(p), b) - videoTimeAt(p.clips, planOf(p), a)

/** Two sentences of `n` words at 1 s and after a silence of `gap` seconds: the only stretch is both. */
function pair(first: string, opts: { second?: string; gap?: number; clips?: (end: number) => Clip[]; after?: number } = {}): Project {
  const second = opts.second ?? 'That covers the main report page here.'
  const gap = opts.gap ?? 16
  const d1 = (first.split(' ').length - 1) * 0.35 + 0.28
  const t2 = 1 + d1 + gap
  const d2 = (second.split(' ').length - 1) * 0.35 + 0.28
  const said: Said[] = [
    { t: 1, text: first },
    { t: t2, text: second }
  ]
  if (opts.after !== undefined) said.push({ t: t2 + d2 + opts.after, text: 'Done.' })
  const duration = t2 + d2 + 30
  return clipProject({ said, duration, ...(opts.clips ? { clips: opts.clips(duration) } : {}) })
}
const only = (p: Project): Moment => {
  const list = moments(p)
  expect(list).toHaveLength(1)
  return list[0]
}

describe('candidates (test 50)', () => {
  const talk = steadyTalk(60, { every: 5, words: 8 })
  // Sentence 10 runs on from sentence 9 with a 0.1 s gap: no moment starts there.
  const runOn = talk.map((s, i) => (i === 10 ? { ...s, t: talk[9].t + 7 * 0.35 + 0.28 + 0.1 } : s))
  const p = clipProject({ said: runOn, duration: 310 })

  it('start at a sentence start after a gap of 0.3 s or more and end at a sentence end, padded inside the silence', () => {
    const list = clipSentences(p, { track: null, scan: null })
    const starts = new Map(list.map((s) => [Math.round((s.start - 0.15) * 1000), s]))
    const ends = new Set(list.map((s) => Math.round((s.end + 0.25) * 1000)))
    const all = moments(p)
    expect(all.length).toBeGreaterThan(0)
    for (const m of all) {
      const s = starts.get(Math.round(m.start * 1000))
      expect(s, `starts at a sentence: ${m.start}`).toBeDefined()
      expect(s!.gapBefore).toBeGreaterThanOrEqual(0.3)
      expect(ends.has(Math.round(m.end * 1000))).toBe(true)
    }
    // The run-on sentence is never a start, whatever the length asked.
    for (const length of ['any', 'short', 'long'] as const) for (const m of moments(p, { length })) expect(Math.abs(m.start - (runOn[10].t - 0.15))).toBeGreaterThan(0.01)
  })

  it('Under 60 s and 60-90 s bound the only stretch of 70 s', () => {
    const p = pair('We look at the report page today.', { gap: 65 })
    expect(only(p).seconds).toBeGreaterThan(60)
    expect(findMoments(p, { track: null, scan: null, length: 'short' })).toEqual({ reason: 'nothing' })
    expect(moments(p, { length: 'long' })).toHaveLength(1)
    const near = pair('We look at the report page today.', { gap: 40 })
    expect(only(near).seconds).toBeLessThan(60)
    expect(findMoments(near, { track: null, scan: null, length: 'long' })).toEqual({ reason: 'nothing' })
    expect(moments(near, { length: 'short' })).toHaveLength(1)
  })

  it('lengths stay within 15-90 s, under 60 s and 60-90 s, in viewing time on 2× clips', () => {
    const sped = clipProject({ said: talk, duration: 310, clips: [{ id: 'a', start: 0, end: 100, speed: 1 }, { id: 'b', start: 100, end: 220, speed: 2 }, { id: 'c', start: 220, end: 310, speed: 1 }] })
    const bounds = { any: [15, 90], short: [15, 60], long: [60, 90] } as const
    for (const length of ['any', 'short', 'long'] as const) {
      const list = moments(sped, { length })
      expect(list.length).toBeGreaterThan(0)
      for (const m of list) {
        expect(m.seconds).toBeCloseTo(viewing(sped, m.start, m.end), 6)
        expect(m.seconds).toBeGreaterThanOrEqual(bounds[length][0] - 1e-6)
        expect(m.seconds).toBeLessThanOrEqual(bounds[length][1] + 1e-6)
      }
    }
    // A moment inside the 2× clip spans twice as much of the recording as it lasts.
    const inFast = moments(sped).find((m) => m.start > 100 && m.end < 220)
    if (inFast) expect(inFast.end - inFast.start).toBeCloseTo(2 * inFast.seconds, 6)
  })
})

describe('each score term (test 51)', () => {
  const FIRST = 'We look at the report page today.'

  it('the length term is 1.5 at 45 s and falls off over 20 s', () => {
    expect(lengthTerm(45)).toBeCloseTo(1.5, 9)
    expect(lengthTerm(25)).toBeCloseTo(1.5 * Math.exp(-0.5), 9)
    expect(lengthTerm(65)).toBeCloseTo(lengthTerm(25), 9)
    expect(lengthTerm(44)).toBeGreaterThan(lengthTerm(30))
  })

  it('with features alike (two sentences of the same length), the score is the terms: a question first +1; mostly silence −1; ends cleanly +0.5', () => {
    const base = only(pair(FIRST))
    // 0.5 (nothing follows) − 1 (78% silence) + the length term.
    expect(base.score).toBeCloseTo(0.5 - 1 + lengthTerm(base.seconds), 6)
    const question = only(pair('We look at the report page today?'))
    expect(question.score - base.score).toBeCloseTo(1, 6)
    expect(only(pair('How we look at the report page.')).score - base.score).toBeCloseTo(1, 6)
  })

  it('a number or a UI verb first is a hook; "as I said" first refers back (−0.5)', () => {
    expect(hookOf('Open the settings page now.', 'en')).toBe('action')
    expect(hookOf('We grew 40% this year.', 'en')).toBe('number')
    expect(hookOf('Why does it fail?', 'en')).toBe('question')
    expect(hookOf('We look at the page.', 'en')).toBeNull()
    expect(refersBack('As I said, we look at it.')).toBe(true)
    expect(refersBack('Like I said we look.')).toBe(true)
    expect(refersBack('That one is the best.')).toBe(true)
    expect(refersBack('Assets are said to load.')).toBe(false)
    const base = only(pair(FIRST))
    const back = only(pair('As I said we look at it.'))
    expect(back.score - base.score).toBeCloseTo(-0.5, 6)
  })

  it('a 0.4 s gap after the last sentence: +0.5 (0.3 s: none)', () => {
    const tight = only(pair(FIRST, { after: 0.3 }))
    const clean = only(pair(FIRST, { after: 0.5 }))
    expect(clean.score - tight.score).toBeCloseTo(0.5 + lengthTerm(clean.seconds) - lengthTerm(tight.seconds), 6)
    expect(clean.reasons).toContain('Ends cleanly')
    expect(tight.reasons).not.toContain('Ends cleanly')
  })

  it('more than 30% with no speech and no input: −1 (31% against 28%)', () => {
    const long = 'We look at the report page today and then we read every total of the page for the team now.'
    const second = 'That covers the main report page here and then we read every total of the page for the team again.'
    const full = only(pair(long, { second, gap: 5 }))
    const empty = only(pair(long, { second, gap: 6 }))
    const share = (m: Moment, gap: number): number => (gap + 0.4) / m.seconds
    expect(share(full, 5)).toBeLessThan(0.3)
    expect(share(empty, 6)).toBeGreaterThan(0.31)
    expect(empty.score - full.score).toBeCloseTo(-1 + lengthTerm(empty.seconds) - lengthTerm(full.seconds), 6)
    // Input in the silence counts as something happening.
    const busy = clipProject({ ...pair(long, { second, gap: 6 }) })
    const clicks = Array.from({ length: 6 }, (_, i) => ({ t: 8.5 + i, x: 0.5, y: 0.5, button: 'left' as const }))
    const withInput = moments(busy, { track: trackOf({ clicks }) })[0]
    expect(withInput.score - empty.score).toBeGreaterThan(0.9)
  })

  it('5 cuts in 30 s: −0.5 (4: none)', () => {
    /** Cuts of 0.1 s in the silence between the sentences. */
    const cuts = (n: number) => (end: number): Clip[] => {
      const out: Clip[] = []
      let at = 0
      for (let i = 0; i < n; i++) {
        const t = 10 + i * 2
        out.push({ id: `k${i}`, start: at, end: t, speed: 1 })
        at = t + 0.1
      }
      out.push({ id: 'last', start: at, end, speed: 1 })
      return out
    }
    const four = only(pair(FIRST, { gap: 29.5, clips: cuts(4) }))
    const five = only(pair(FIRST, { gap: 29.5, clips: cuts(5) }))
    expect(four.seconds).toBeGreaterThan(30)
    expect(five.seconds).toBeLessThan(37.5)
    expect(five.score - four.score).toBeCloseTo(-0.5 + lengthTerm(five.seconds) - lengthTerm(four.seconds), 6)
  })
})

describe('picks (test 52)', () => {
  it('K is 3 for 5 minutes and 10 for 30 minutes; at most K, none overlapping another by more than 30% of the shorter', () => {
    expect(momentCount(300)).toBe(3)
    expect(momentCount(1800)).toBe(10)
    expect(momentCount(60)).toBe(3)
    const five = moments(clipProject({ said: steadyTalk(58, { every: 5 }), duration: 300 }))
    expect(five).toHaveLength(3)
    const thirty = moments(clipProject({ said: steadyTalk(355, { every: 5 }), duration: 1800 }))
    expect(thirty).toHaveLength(10)
    for (const list of [five, thirty]) {
      for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
          const o = Math.min(list[a].end, list[b].end) - Math.max(list[a].start, list[b].start)
          expect(o / Math.min(list[a].seconds, list[b].seconds)).toBeLessThanOrEqual(CLIP_RULES.overlap + 1e-6)
        }
      // Best first.
      expect(list.map((m) => m.score)).toEqual([...list.map((m) => m.score)].sort((x, y) => y - x))
    }
  })

  it('a 44 s video gives too-short; one with no stretch that fits gives nothing', () => {
    expect(findMoments(clipProject({ said: steadyTalk(8), duration: 44 }), { track: null, scan: null, length: 'any' })).toEqual({ reason: 'too-short' })
    expect(findMoments(clipProject({ said: [{ t: 1, text: 'Only one short sentence here.' }], duration: 50 }), { track: null, scan: null, length: 'any' })).toEqual({ reason: 'nothing' })
  })
})

describe('reasons (test 53)', () => {
  const WORDS = new Set(['Packed with information', 'Important words', 'Words you emphasised', 'Numbers', 'Opens with a question', 'Opens with a number', 'Opens with an action', 'Ends cleanly'])

  it('at most 3, from the words of §8.2, then always the length', () => {
    const p = clipProject({ said: steadyTalk(60, { every: 5 }), duration: 305 })
    for (const m of moments(p, { focus: 'report' })) {
      expect(m.reasons.length).toBeGreaterThanOrEqual(1)
      expect(m.reasons.length).toBeLessThanOrEqual(4)
      expect(m.reasons[m.reasons.length - 1]).toBe(`${Math.round(m.seconds)} s`)
      for (const r of m.reasons.slice(0, -1)) expect(WORDS.has(r) || /^\d+ clicks?$/.test(r) || /^Mentions “.+”$/.test(r)).toBe(true)
    }
  })

  it('“Mentions “billing””, “Words you emphasised”, “Numbers”, “Packed with information”, “6 clicks”', () => {
    const said: Said[] = [
      ...steadyTalk(12, { every: 5 }),
      { t: 61, text: 'Billing grew 40% to 2 million users this quarter.', per: 0.2 },
      { t: 66, text: 'The billing page shows 300 new customers each week.', per: 0.2 },
      { t: 71, text: 'Billing exports reach 25% more teams than last year.', per: 0.2 },
      ...steadyTalk(12, { from: 81, every: 5 })
    ]
    const p = clipProject({
      said,
      duration: 145,
      captionMarks: [
        { id: 'm1', caption: 's12', from: 0, to: 0, text: 'Billing' },
        { id: 'm2', caption: 's13', from: 1, to: 1, text: 'billing' }
      ]
    })
    const clicks = Array.from({ length: 6 }, (_, i) => ({ t: 62 + i * 2, x: 0.5, y: 0.5, button: 'left' as const }))
    const best = moments(p, { focus: 'billing', track: trackOf({ clicks }) }).find((m) => m.start < 61 && m.end > 75)!
    expect(best).toBeDefined()
    const all = moments(p, { focus: 'billing', track: trackOf({ clicks }) }).flatMap((m) => m.reasons)
    expect(all).toContain('Mentions “billing”')
    expect(best.reasons.slice(0, -1).length).toBe(3)
    const plain = moments(clipProject({ ...p, captionMarks: [] }), { track: trackOf({ clicks }) }).flatMap((m) => m.reasons)
    expect(plain.some((r) => r === 'Numbers' || r === 'Packed with information' || r === '6 clicks' || r === 'Important words')).toBe(true)
    // Words the user emphasised in every sentence of a stretch.
    const talk = steadyTalk(40, { every: 5 })
    const marks = talk.slice(20, 30).map((_, i) => ({ id: `e${i}`, caption: `s${20 + i}`, from: 1, to: 1, text: 'x' }))
    const marked = moments(clipProject({ said: talk, duration: 205, captionMarks: marks }), { track: NO_TRACK })
    expect(marked[0].reasons).toContain('Words you emphasised')
    expect(marked[0].start).toBeGreaterThan(talk[19].t)
  })
})

describe('silent recordings (test 54)', () => {
  it('the busiest stretches between settled screen changes and input gaps: "Most action", clicks and screens', () => {
    // Three pages, a page change at 40 s and 80 s: one click on the first, a burst of 12 on the third.
    const clicks = [...Array.from({ length: 12 }, (_, i) => ({ t: 82 + i * 0.8, x: 0.5, y: 0.5, button: 'left' as const })), { t: 5, x: 0.5, y: 0.5, button: 'left' as const }]
    const track = trackOf({ clicks })
    const scan = scanOf(120, { 40: 60, 80: 70 })
    const p = clipProject({ duration: 120 })
    const list = moments(p, { track, scan })
    expect(list.length).toBeGreaterThan(0)
    for (const m of list) {
      expect(m.silent).toBe(true)
      expect(m.title).toMatch(/^Most action, \d+:\d\d$/)
      expect(m.first).toBe('')
      expect(m.seconds).toBeGreaterThanOrEqual(15)
      expect(m.seconds).toBeLessThanOrEqual(90)
    }
    // Each starts and ends at a settled screen change, in a gap of input, or at the video's ends.
    const bounds = [0, 40, 80, 120]
    const atBound = (t: number): boolean => bounds.some((b) => Math.abs(t - b) < 1e-6) || [5.5, 4.5, 81.5].some((b) => Math.abs(t - b) < 1e-6) || clicks.some((c) => Math.abs(t - (c.t + 0.5)) < 1e-6 || Math.abs(t - (c.t - 0.5)) < 1e-6)
    for (const m of list) {
      expect(atBound(m.start), `start ${m.start}`).toBe(true)
      expect(atBound(m.end), `end ${m.end}`).toBe(true)
    }
    // A page change inside counts 1: the best holds the change at 80 s and the clicks after it.
    const best = list[0]
    expect(best.start).toBeLessThan(80)
    expect(best.end).toBeGreaterThanOrEqual(clicks[11].t)
    expect(best.reasons).toEqual(['12 clicks', '2 screens', `${Math.round(best.seconds)} s`])
    expect(best.title).toBe(`Most action, ${Math.floor(best.start / 60)}:${String(Math.floor(best.start % 60)).padStart(2, '0')}`)
    // A stretch over the two page changes counts its screens.
    const wide = moments(p, { track, scan, length: 'long' })
    expect(wide.some((m) => m.reasons.includes('2 screens') || m.reasons.includes('3 screens'))).toBe(true)
  })

  it('Use activity only takes the same path on a recording with captions; with nothing happening there is nothing', () => {
    const clicks = Array.from({ length: 10 }, (_, i) => ({ t: 50 + i * 2, x: 0.5, y: 0.5, button: 'left' as const }))
    const p = clipProject({ said: steadyTalk(20, { every: 5 }), duration: 110 })
    expect(moments(p, { track: trackOf({ clicks }), activityOnly: true }).every((m) => m.silent)).toBe(true)
    expect(moments(p, { track: trackOf({ clicks }) }).every((m) => !m.silent)).toBe(true)
    expect(findMoments(clipProject({ duration: 120 }), { track: NO_TRACK, scan: null, length: 'any' })).toEqual({ reason: 'nothing' })
  })
})

describe('performance (test 61)', () => {
  it('moments of a 1-hour recording under 300 ms; planShort under 100 ms', () => {
    const said = steadyTalk(600, { every: 6, words: 12 })
    const clicks = Array.from({ length: 900 }, (_, i) => ({ t: i * 4 + 0.5, x: 0.5, y: 0.5, button: 'left' as const }))
    const p = clipProject({ said, duration: 3600 })
    const track = trackOf({ clicks })
    const scan = scanOf(3600, Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i * 60 + 30, 40])))
    // Warm up the shared parsers once (as the panel does on opening).
    findMoments(clipProject({ said: steadyTalk(20), duration: 120 }), { track: null, scan: null, length: 'any' })
    let t0 = performance.now()
    const list = findMoments(p, { track, scan, length: 'any' })
    const took = performance.now() - t0
    expect(Array.isArray(list) && list.length).toBe(10)
    expect(took).toBeLessThan(300 * SLOW)
    const sentences = clipSentences(p, { track, scan })
    t0 = performance.now()
    const plan = planShort(p, sentences, { seconds: 60 })
    expect(performance.now() - t0).toBeLessThan(100 * SLOW)
    expect(plan.ok).toBe(true)
  })
})

describe('Bangla (test 62)', () => {
  it('a sentence ending in "?" or starting with "কীভাবে" is a hook; "যেমন বললাম" first refers back', () => {
    expect(hookOf('আমরা রিপোর্ট পাতাটা খুলব?', 'bn')).toBe('question')
    expect(hookOf('কীভাবে রিপোর্ট পাতাটা খুলব।', 'bn')).toBe('question')
    expect(hookOf('আমরা রিপোর্ট পাতাটা খুলব।', 'bn')).toBeNull()
    expect(refersBack('যেমন বললাম, রিপোর্ট পাতাটা খুলুন।')).toBe(true)
    expect(refersBack('আগেই বলেছি এটা জরুরি।')).toBe(true)
    expect(refersBack('রিপোর্ট পাতাটা খুলুন।')).toBe(false)
    // In a moment: the hook and the reference back are scored.
    const second = 'তারপর আমরা মোট হিসাবটা আবার দেখে নিই।'
    const base = only(pair('আমরা রিপোর্ট পাতাটা খুলে দেখি।', { second }))
    expect(only(pair('কীভাবে রিপোর্ট পাতাটা খুলে দেখি।', { second })).score - base.score).toBeCloseTo(1, 6)
    expect(only(pair('যেমন বললাম রিপোর্ট পাতাটা খুলুন।', { second })).score - base.score).toBeCloseTo(-0.5, 6)
  })

  it('titles are cut by graphemes, at a word, never inside a cluster', () => {
    const clusters = (t: string): number => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)].length
    // Twelve words: no sentence name (2 to 8 words), so the sentence cut to 40 graphemes.
    const long = 'ক্ষেত্রবিশেষে স্বয়ংক্রিয়ভাবে প্রতিবেদনগুলোর পরিসংখ্যানবিষয়ক তথ্যসমূহ পুনর্বিন্যস্ত করা যায় এবং সেগুলো আবার দেখা যায়'
    const title = momentTitle(long, 2, 'bn')
    expect(long.startsWith(title)).toBe(true)
    expect(title.length).toBeLessThan(long.length)
    expect(clusters(title)).toBeLessThanOrEqual(48)
    // It ends where a word ends: never inside a conjunct (no virama last) or before a vowel sign.
    expect(long.slice(title.length, title.length + 1)).toBe(' ')
    expect(title).not.toMatch(/্$/u)
    // A sentence name of 8 long words is cut to 80 graphemes, at a word.
    const eight = Array.from({ length: 8 }, () => 'পরিসংখ্যানবিষয়কগুলো').join(' ')
    const named = momentTitle(eight, 1, 'bn')
    expect(clusters(named)).toBeLessThanOrEqual(80 + 20)
    expect(named.length).toBeLessThan(eight.length)
    expect(eight.slice(named.length, named.length + 1)).toBe(' ')
    expect(momentTitle('', 3, 'bn')).toBe('Clip 3')
    expect(momentTitle('খুলুন রিপোর্ট পাতাটা এখন।', 1, 'bn')).toBe('খুলুন রিপোর্ট পাতাটা এখন')
    // Nothing private-like becomes a title.
    expect(momentTitle('Open C:\\Users\\sam\\notes.txt now please.', 4, 'en')).toBe('Clip 4')
  })
})
