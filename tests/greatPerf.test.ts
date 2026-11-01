import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLEANUP, tidyCaptions } from '../src/shared/captions/cleanup'
import { isSensitive } from '../src/shared/captions/emoji'
import { emphasisScores } from '../src/shared/captions/emphasis'
import { DEFAULT_GREAT_OPTIONS, planCaptionsGreat } from '../src/shared/captions/great'
import { parseNumberWords } from '../src/shared/captions/numbers'
import type { Project } from '../src/shared/types'
import { captions, studioProject, TALL, WIDE } from './p4Fixtures'

/*
 * Make my captions great on 5,000 captions (docs/design/captions-studio.md §9.8: under 200 ms)
 * runs on the editor's thread in one update, so the editor waits for it. It is timed here in a
 * wide frame, the usual screen recording, under a 6× margin as test 30 is, so a slow CI machine
 * still passes. What made it two to five times over budget is counted, not timed (in the heaviest
 * frame, tall and camera-led, with emoji and keyword pop-ups): a grapheme segmenter for plain ASCII
 * words, a number format made for each caption, the sensitive words tried stem by stem, a
 * spelled-out number read on past a word that is no number, and the word scores made twice.
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
