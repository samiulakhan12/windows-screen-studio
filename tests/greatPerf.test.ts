import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLEANUP, tidyCaptions } from '../src/shared/captions/cleanup'
import { isSensitive } from '../src/shared/captions/emoji'
import { emphasisScores } from '../src/shared/captions/emphasis'
import { GRAPHIC_SPACING, planGraphics } from '../src/shared/captions/graphicRules'
import { DEFAULT_GREAT_OPTIONS, planCaptionsGreat, planCaptionsGreatSteps } from '../src/shared/captions/great'
import { findNumbers, parseNumberWords } from '../src/shared/captions/numbers'
import { studioTokens } from '../src/shared/captions/words'
import type { CaptionSegment, CursorTrack, Graphic, Project } from '../src/shared/types'
import { captions, studioProject, TALL, WIDE } from './p4Fixtures'

/*
 * Make my captions great on 5,000 captions (docs/design/captions-studio.md §9.8: under 200 ms)
 * runs on the editor's thread in one update, so the editor waits for it. It is timed here in a
 * wide frame, the usual screen recording, and in the heaviest, tall and camera-led with emoji and
 * keyword pop-ups, under a 6× margin as test 30 is, so a slow CI machine still passes. What made it
 * two to five times over budget is counted, not timed: a grapheme segmenter for plain ASCII words,
 * a number format made for each caption, the sensitive words tried stem by stem, a spelled-out
 * number read on past a word that is no number, the word scores made twice, each caption's words
 * made again by every rule, each word compared with every click, each pop-up's start with every
 * other start, and the digits of every word rewritten.
 */

const MARGIN = 6
const TEXTS = [
  'today i will show you three ways to make reports faster and I love pizza',
  'First, open the Settings page and click Export. Our sales grew 300 percent',
  'Second, turn on Auto Save so you never lose work, this is amazing',
  'Finally, use the Search box to find any report and grab a coffee',
  'we have twenty five users and three teams in two countries, great job'
]
const project = (n: number) => studioProject({ segments: captions(Array.from({ length: n }, (_, i) => TEXTS[i % TEXTS.length])), camera: 'large' })
const plan = (p: Project, frame = TALL) => planCaptionsGreat({ project: p, frame, cleanup: DEFAULT_CLEANUP, words: [], by: 'great' }, DEFAULT_GREAT_OPTIONS)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Counts the elements `some` and `filter` are called on while `run` runs. */
function elementsRead<T>(run: () => T): { out: T; read: number } {
  let read = 0
  for (const name of ['some', 'filter'] as const) {
    const real = Array.prototype[name] as (...args: unknown[]) => unknown
    vi.spyOn(Array.prototype, name).mockImplementation(function (this: unknown[], ...args: unknown[]) {
      read += this.length
      return real.apply(this, args)
    } as never)
  }
  try {
    return { out: run(), read }
  } finally {
    vi.restoreAllMocks()
  }
}

describe('Make my captions great within its budget (§9.8)', () => {
  it('plans 5,000 captions in a wide frame under the margin', () => {
    // Warmed up as in the editor, where its rules have run on other captions before.
    plan(project(200), WIDE)
    const p = project(5000)
    const t0 = performance.now()
    const { summary } = plan(p, WIDE)
    const ms = performance.now() - t0
    expect(summary.emphasised).toBeGreaterThan(0)
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(200 * MARGIN)
  })

  it('plans 5,000 captions in a tall, camera-led frame under the margin', () => {
    plan(project(200))
    const p = project(5000)
    const t0 = performance.now()
    const { summary } = plan(p)
    const ms = performance.now() - t0
    // Emoji and keyword pop-ups are on in this frame (§11.6).
    expect(summary.emoji + summary.keywords).toBeGreaterThan(0)
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(200 * MARGIN)
  })

  it('plans 5,000 captions a step at a time, no step holding the editor for half the plan', () => {
    plan(project(200))
    const p = project(5000)
    const steps = planCaptionsGreatSteps({ project: p, frame: TALL, cleanup: DEFAULT_CLEANUP, words: [], by: 'great' }, DEFAULT_GREAT_OPTIONS)
    const times: number[] = []
    let r: IteratorResult<void, ReturnType<typeof plan>>
    do {
      const t0 = performance.now()
      r = steps.next()
      times.push(performance.now() - t0)
    } while (!r.done)
    const total = times.reduce((a, b) => a + b, 0)
    // Tidy; style and emphasis; counters, lists, keyword pop-ups, emoji; the rest.
    expect(times.length).toBeGreaterThanOrEqual(7)
    expect(Math.max(...times), times.map((t) => t.toFixed(0)).join(' ')).toBeLessThan(total * 0.6)
    expect(r.value).toEqual(plan(p))
  })

  it("makes a caption's words once for every rule of a run", () => {
    const seg: CaptionSegment = { id: 'c0', start: 0, end: 3, text: 'Open the Settings page' }
    const words = studioTokens(seg, 'en')
    expect(studioTokens(seg, 'en')).toBe(words)
    // Made again for another language, with the speaker's name, or for a caption that changed.
    expect(studioTokens(seg, 'de')).not.toBe(words)
    expect(studioTokens({ ...seg, speaker: 'Priya' }, 'en', true)[0]).toMatchObject({ text: 'Priya:', word: -1 })
    expect(studioTokens({ ...seg, text: 'Open the Export page' }, 'en')[2].text).toBe('Export')
    const changing = { ...seg }
    expect(studioTokens(changing, 'en')).toEqual(words)
    changing.text = 'Close it'
    expect(studioTokens(changing, 'en').map((t) => t.text)).toEqual(['Close', 'it'])
    changing.end = 6
    expect(studioTokens(changing, 'en')[1].end).toBe(6)
  })

  it('scores the words near a click without comparing each word with every click', () => {
    const word = (text: string, start: number, end: number) => ({ text, start, end })
    const seg: CaptionSegment = { id: 'c0', start: 0, end: 4, text: 'open the Settings page', words: [word('open', 0, 0.5), word('the', 0.6, 0.8), word('Settings', 1, 1.6), word('page', 3, 3.5)] }
    const cursor = (...t: number[]) => ({ valid: true, samples: [], clicks: t.map((x) => ({ t: x, x: 0.5, y: 0.5 })) }) as unknown as CursorTrack
    const scoreOf = (c: CursorTrack, w: number) => emphasisScores([seg], { language: 'en', cursor: c, clips: [] }).find((s) => s.word === w)!.score
    // A click 0.5 s after "Settings" ends is near it (0.6 s), not near "page" (0.6 s before it).
    expect(scoreOf(cursor(2.1), 2) - scoreOf(cursor(60), 2)).toBeCloseTo(1)
    expect(scoreOf(cursor(2.1), 3)).toBeCloseTo(scoreOf(cursor(60), 3))
    // An hour's recording: a click every 1.6 s under 2,000 captions.
    const p = project(2000)
    const clicks = cursor(...Array.from({ length: 5000 }, (_, i) => i * 1.6 + 0.3))
    const { read } = elementsRead(() => emphasisScores(p.transcript!.segments, { language: 'en', cursor: clicks, clips: p.clips }))
    // The words and the clicks a few times each, not every word with every click (tens of millions).
    expect(read).toBeLessThan(100_000)
  })

  it("keeps pop-ups apart by reading only the starts near each one, however many the project has", () => {
    // 3,000 of the user's graphics in the first 10 minutes; captions with an emoji word for 20.
    const own = (i: number): Graphic => ({ id: `u${i}`, kind: 'emoji', emoji: '1f4a1', start: i * 0.2, end: i * 0.2 + 1, place: 'auto', size: 1, enter: { kind: 'pop', duration: 0.3 }, exit: { kind: 'fade', duration: 0.3 } }) as Graphic
    const p = studioProject({ segments: captions(Array.from({ length: 300 }, () => 'here is a great idea for you')), aspect: '9:16', graphics: Array.from({ length: 3000 }, (_, i) => own(i)) })
    const options = { keywords: false, emoji: true, counters: false, lists: false, speakers: false, chapters: false, quotes: false, sound: 'none' } as const
    const { out, read } = elementsRead(() => planGraphics(p, options))
    expect(read).toBeLessThan(100_000)
    // The same choices: none among the user's graphics, the rest apart and at most 8 a minute.
    const made = (out.graphics ?? []).filter((g) => g.auto).map((g) => g.start)
    expect(made.length).toBeGreaterThan(50)
    expect(made.every((t) => t >= 600 + GRAPHIC_SPACING)).toBe(true)
    for (let i = 1; i < made.length; i++) expect(made[i] - made[i - 1]).toBeGreaterThanOrEqual(GRAPHIC_SPACING)
    for (const t of made) expect(made.filter((u) => u >= t && u < t + 60).length).toBeLessThanOrEqual(8)
  })

  it('reads a word that is no number without rewriting its digits or parsing it as spelled out', () => {
    const seg: CaptionSegment = { id: 'c0', start: 0, end: 9, text: 'open the settings page and click export to save your video right now please' }
    // Once first, so each word's bare form is made (speech repeats its words).
    expect(findNumbers(seg, 'en')).toEqual([])
    const replace = vi.spyOn(String.prototype, 'replace')
    const split = vi.spyOn(String.prototype, 'split')
    expect(findNumbers(seg, 'en')).toEqual([])
    expect(replace).not.toHaveBeenCalled()
    // The caption split into its words, and no word after it.
    expect(split.mock.calls.length).toBeLessThanOrEqual(1)
    vi.restoreAllMocks()
    // Numbers are found as before.
    const found = findNumbers({ id: 'c1', start: 0, end: 9, text: 'we have twenty-five users, ৩০০ টাকা and grew 40 percent' }, 'en')
    expect(found.map((n) => n.value)).toEqual([25, 300, 40])
  })

  it('counts plain ASCII words without a grapheme segmenter', () => {
    const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment')
    plan(project(50))
    expect(segment).not.toHaveBeenCalled()
  })

  it('makes one number format for a tidy, not one per caption', () => {
    const NumberFormat = Intl.NumberFormat
    let made = 0
    const counted = function (...args: ConstructorParameters<typeof Intl.NumberFormat>) {
      made++
      return new NumberFormat(...args)
    }
    vi.stubGlobal('Intl', Object.create(Intl, { NumberFormat: { value: counted } }))
    // A language never tidied before in this run, so its format is made here.
    const p = studioProject({ segments: captions(Array.from({ length: 50 }, (_, i) => `৳${i + 10} টাকা আর twenty five জন`)), language: 'bn-IN' })
    tidyCaptions(p, { ...DEFAULT_CLEANUP, ai: false, words: [] })
    expect(made).toBe(1)
  })

  it('reads a spelled-out number only as far as its number words', () => {
    const words = ['open', ...Array.from({ length: 30 }, (_, i) => `word${i}`)]
    const lower = vi.spyOn(String.prototype, 'toLocaleLowerCase')
    expect(parseNumberWords(words, 'en')).toBeNull()
    expect(lower.mock.calls.length).toBeLessThanOrEqual(1)
    expect(parseNumberWords(['twenty-five', 'users', 'grew', 'fast'], 'en')).toEqual({ value: 25, used: 1 })
    expect(parseNumberWords(['a', 'hundred', 'and', 'five', 'people', 'came'], 'en')).toEqual({ value: 105, used: 4 })
  })

  it('checks a caption for sensitive words word by word, not stem by stem', () => {
    const starts = vi.spyOn(String.prototype, 'startsWith')
    const text = 'open the settings page and click export to save your video right now'
    expect(isSensitive(text, 'en')).toBe(false)
    expect(starts.mock.calls.length).toBeLessThanOrEqual(text.split(' ').length)
    // The same answers: a stem starts a word; a whole word takes only its endings; English words count whole in another language.
    expect(isSensitive('the cancerous cells', 'en')).toBe(true)
    expect(isSensitive('a warning, not the wars', 'en')).toBe(true)
    expect(isSensitive('a warning sign', 'en')).toBe(false)
    expect(isSensitive('her grandfather passed away', 'en')).toBe(true)
    expect(isSensitive('una bombilla nueva', 'es')).toBe(false)
    expect(isSensitive('una bomb en la calle', 'es')).toBe(true)
    expect(isSensitive('der Tod kam', 'de')).toBe(true)
    expect(isSensitive('heute Todo', 'de')).toBe(false)
  })

  it('makes the word scores once for both the emphasis step and the keyword pop-ups', () => {
    const p = project(20)
    const segments = p.transcript!.segments
    const scores = emphasisScores(segments, { language: 'en', clips: p.clips })
    expect(emphasisScores(segments, { language: 'en', clips: p.clips })).toBe(scores)
    // Another cursor (words near a click score more) or language makes them again.
    const cursor = { valid: true, samples: [], clicks: [{ t: 1, x: 0.5, y: 0.5 }] } as never
    expect(emphasisScores(segments, { language: 'en', clips: p.clips, cursor })).not.toBe(scores)
    expect(emphasisScores(segments, { language: 'en-GB', clips: p.clips })).not.toBe(scores)
  })
})
