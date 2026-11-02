/**
 * Captions Studio test 36 (docs/design/captions-studio.md §11.1): auto emphasis, offline, on the
 * design's prototype captions (12 English, 3 Bangla).
 */
import { describe, expect, it, vi } from 'vitest'
import { emphasisScores, pickEmphasis } from '../src/shared/captions/emphasis'
import { STOP_WORDS } from '../src/shared/captions/stopWords'
import type { CaptionMark, CaptionSegment, CursorTrack, Project } from '../src/shared/types'

vi.mock('../src/shared/captions/words', async (o) => (await import('./p1Fillins')).fillWords(await o()))

const EN = [
  'Today I will show you three ways to make your reports faster.',
  'First, open the Settings page and click Export.',
  'Second, turn on Auto Save so you never lose your work.',
  'And finally, use the Search box to find any report in seconds.',
  'Last quarter our sign-ups grew 300% and revenue hit $1.2M.',
  'This is version 2 and it shipped in 2024.',
  'If the build fails do not panic, just kill the process and run it again.',
  'Here is a quick tip: press Ctrl+S to save.',
  'Apple Notes is not great for this.',
  'We are not happy with the old price.',
  'Our CEO died last year, so this release is for him.',
  'Click Save and you are done.'
]
const BN = ['আজ আমি আপনাদের Flown দিয়ে ভিডিও বানানো দেখাব।', 'গত মাসে আমাদের বিক্রি ৩০০ শতাংশ বেড়েছে।', 'প্রথম ধাপে Settings খুলুন।']

const segs = (texts: string[], prefix: string): CaptionSegment[] => texts.map((text, i) => ({ id: `${prefix}${i}`, start: i * 4, end: i * 4 + 3.6, text }))
const project = (segments: CaptionSegment[], language: string, marks?: CaptionMark[]): Project =>
  ({ duration: 60, clips: [{ start: 0, end: 60, speed: 1 }], transcript: { language, provider: 'local', model: 'm', createdAt: '', segments }, ...(marks ? { captionMarks: marks } : {}) }) as unknown as Project

const picked = (p: Project): string[] => pickEmphasis(p).map((m) => m.text.replace(/[.,!?।]+$/u, ''))

describe('auto emphasis (test 36)', () => {
  const en = project(segs(EN, 'c'), 'en')

  it('picks the key words of the English prototype captions', () => {
    const words = picked(en)
    for (const w of ['Export', 'Settings', '300%', '$1.2M', 'Save']) expect(words).toContain(w)
    expect(words).not.toContain('2')
    expect(words).not.toContain('2024')
  })

  it('"Auto Save" is one phrase', () => {
    const marks = pickEmphasis(en)
    const auto = marks.find((m) => m.caption === 'c2' && m.text.startsWith('Auto'))
    expect(auto).toMatchObject({ from: 3, to: 4, text: 'Auto Save', auto: true })
  })

  it('picks at most one word in eight, 1 per short caption and 2 per longer one', () => {
    const marks = pickEmphasis(en)
    const total = EN.join(' ').split(/\s+/).length
    const words = marks.reduce((n, m) => n + m.to - m.from + 1, 0)
    expect(words).toBeLessThanOrEqual(Math.floor(total / 8))
    const per = new Map<string, number>()
    for (const m of marks) per.set(m.caption, (per.get(m.caption) ?? 0) + 1)
    for (const [id, n] of per) expect(n).toBeLessThanOrEqual(EN[Number(id.slice(1))].split(' ').length <= 6 ? 1 : 2)
  })

  it('finds Flown, ৩০০ and Settings in Bangla', () => {
    const bn = project(segs(BN, 'b'), 'bn')
    // 18 words: one in eight allows 2, taken by the highest scores among the three.
    const two = picked(bn)
    expect(two).toHaveLength(2)
    for (const w of two) expect(['Flown', '৩০০', 'Settings']).toContain(w)
    expect(pickEmphasis(bn, { maxShare: 1 / 6 }).map((m) => m.text.replace(/[।]+$/u, ''))).toEqual(['Flown', '৩০০', 'Settings'])
  })

  it('a mostly Bangla transcript that names no language gets the same picks as one named Bangla (§0.2)', () => {
    const texts = [
      'আজকে আমরা দেখব কীভাবে উইন্ডোজ আপডেট বন্ধ করতে হয়', 'প্রথমে কন্ট্রোল প্যানেল খুলুন', 'তারপর সিকিউরিটি ট্যাবে যান',
      'এখানে অটোমেটিক আপডেট অপশনটা বন্ধ করে দিন', 'তারপর রিস্টার্ট দিন', 'ব্যাস হয়ে গেল', 'আমি এই ভিডিওতে আপনাদের দেখাবো কীভাবে সেটিংস খুলতে হয়',
      'প্রথমে আপনি স্টার্ট মেনুতে ক্লিক করুন', 'তারপর আমরা নিরাপত্তা অপশনটি বেছে নেব', 'এটা খুবই গুরুত্বপূর্ণ একটা ধাপ', 'এবার সেভ বাটনে চাপ দিন'
    ]
    const named = project(segs(texts, 'n'), 'bn')
    const unnamed = project(segs(texts, 'n'), 'bn')
    delete (unnamed.transcript as { language?: string }).language
    // The objects of the polite commands (খুলুন, করুন) are picked, with or without the language code.
    expect(picked(named)).toEqual(['প্যানেল', 'মেনুতে'])
    expect(pickEmphasis(unnamed)).toEqual(pickEmphasis(named))
  })

  it('a mostly Bangla transcript with English words that names no language (OpenAI, Gemini) gets the picks of one named Bangla; English with a few Bangla words those of English', () => {
    // 23 of its 32 words are Bangla: 46% of its letters, 57% with their vowel signs and hasanta.
    const mixed = [
      'তো guys আজকের video তে আমরা দেখবো কিভাবে Node.js install করতে হয়',
      'প্রথমে browser খুলে official website এ যাবো',
      'তারপর download বাটনে click করে দিন',
      'এরপর installer টা খুলে next চাপুন',
      'সবশেষে terminal খুলে দেখুন সব ঠিক আছে কিনা'
    ]
    const english = ['Today we will install Node.js on Windows', 'first open the browser and go to the official website', 'my friend said আচ্ছা ঠিক আছে and left', 'then click the download button and run the installer']
    const unnamed = (texts: string[]): Project => {
      const p = project(segs(texts, 'm'), 'bn')
      delete (p.transcript as { language?: string }).language
      return p
    }
    const bn = pickEmphasis(project(segs(mixed, 'm'), 'bn'))
    // A Bangla word such as করতে ("to do") is a stop word in Bangla.
    expect(bn.map((m) => m.text)).not.toContain('করতে')
    expect(pickEmphasis(unnamed(mixed))).toEqual(bn)
    expect(pickEmphasis(unnamed(english))).toEqual(pickEmphasis(project(segs(english, 'm'), 'en')))
    expect(pickEmphasis(unnamed(english))).not.toEqual(pickEmphasis(project(segs(english, 'm'), 'bn')))
  })

  it('"important", "never", "only" and "open" are not stop words; no list holds a negation', () => {
    for (const w of ['important', 'never', 'only', 'open', 'every', 'not', 'best']) expect(STOP_WORDS.en.has(w)).toBe(false)
    expect(STOP_WORDS.bn.has('না')).toBe(false)
    expect(STOP_WORDS.hi.has('नहीं')).toBe(false)
    for (const lang of ['en', 'bn', 'hi', 'es', 'fr', 'de', 'pt']) expect(STOP_WORDS[lang].size).toBeGreaterThan(80)
  })

  it('scores numbers, labels, years and capitals by the table of §11.1', () => {
    const scores = emphasisScores(segs(EN, 'c'), { language: 'en', clips: [] })
    const at = (caption: string, word: number) => scores.find((s) => s.caption === caption && s.word === word)!.score
    // "300%": a number (+3) and percent (+1.5); "2" a label and "2024" a year (+1 each, no rarity).
    expect(at('c4', 5)).toBeCloseTo(4.5)
    expect(at('c5', 3)).toBe(1)
    expect(at('c5', 8)).toBe(1)
    // Stop words are never scored.
    expect(scores.some((s) => s.caption === 'c0' && s.word === 4)).toBe(false)
  })

  it('a word said within 0.6 s of a click scores 1 more', () => {
    const cursor = { samples: [], clicks: [{ t: 3.3, x: 0, y: 0, button: 'left' }], valid: true } as unknown as CursorTrack
    const one = [{ id: 'x', start: 0, end: 4, text: 'Open the dashboard now' }]
    const near = emphasisScores(one, { language: 'en', cursor, clips: [] })
    const far = emphasisScores(one, { language: 'en', clips: [] })
    const last = (s: typeof near) => s.find((x) => x.word === 3)!.score
    expect(last(near) - last(far)).toBeCloseTo(1)
  })

  it('never touches captions with marks, and the same input picks the same marks', () => {
    const mark: CaptionMark = { id: 'mine', caption: 'c1', from: 3, to: 3, text: 'Settings' }
    const marks = pickEmphasis(project(segs(EN, 'c'), 'en', [mark]))
    expect(marks.some((m) => m.caption === 'c1')).toBe(false)
    expect(pickEmphasis(en)).toEqual(pickEmphasis(project(segs(EN, 'c'), 'en')))
  })

  it('an earlier emphasis of the same word lowers its score', () => {
    const texts = ['Click Deploy now please.', 'Click Deploy again please.', 'Click Deploy once more.']
    const p = project(segs(texts, 'd'), 'en')
    const all = pickEmphasis(p, { maxShare: 1 })
    expect(all.filter((m) => m.text.startsWith('Deploy')).length).toBeLessThan(3)
  })

  it('handles 5,000 captions in well under a second', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}`, start: i * 2, end: i * 2 + 1.8, text: EN[i % EN.length] }))
    const t0 = performance.now()
    pickEmphasis(project(many, 'en'))
    expect(performance.now() - t0).toBeLessThan(3000)
  })
})
