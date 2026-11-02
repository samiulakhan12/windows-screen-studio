/**
 * Captions Studio tests 41 and 50 (P4's part) (docs/design/captions-studio.md §11.7): clean-up
 * rules, the word list, bleeping, masks by time, and the AI fix's records.
 */
import { describe, expect, it } from 'vitest'
import { bleepGains, bleepKey, cleanupNotice, glossaryLine, glossaryTerms, GLOSSARY_BYTES, isSwearWord, maskBleeped, maskedSegments, maskWord, readCleanupChoices, readWordList, tidyCaptions, type CleanupChoices } from '../src/shared/captions/cleanup'
import { mergeWithNext, splitCaption } from '../src/shared/captions/edit'
import { readBleeps } from '../src/shared/captions/studioData'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import type { Bleep, CaptionSegment, Project } from '../src/shared/types'

const OFF: CleanupChoices = { caps: false, punct: false, digits: 'off', bleep: 'off', bleepSound: 'tone', ai: false }
const project = (segments: CaptionSegment[], language = 'en', extra: Partial<Project> = {}): Project =>
  ({ duration: 100, clips: [{ start: 0, end: 100, speed: 1 }], transcript: { language, provider: 'local', model: 'm', createdAt: '', segments }, ...extra }) as unknown as Project
const timed = (id: string, start: number, text: string, step = 0.4): CaptionSegment => {
  const words = text.split(' ').map((w, i) => ({ text: w, start: start + i * step, end: start + i * step + step * 0.9 }))
  return { id, start, end: words[words.length - 1].end, text, words }
}
const texts = (p: Project): string[] => p.transcript!.segments.map((s) => s.text)

describe('readCleanupChoices (test 41)', () => {
  it('reads defaults for missing and unknown values', () => {
    expect(readCleanupChoices(undefined)).toEqual({ caps: true, punct: true, digits: 'above-ten', bleep: 'off', bleepSound: 'tone', ai: false })
    expect(readCleanupChoices({ caps: false, digits: 'all', bleep: 'strict', bleepSound: 'silence', ai: true, punct: 'x' })).toEqual({
      caps: false,
      punct: true,
      digits: 'all',
      bleep: 'strict',
      bleepSound: 'silence',
      ai: true
    })
  })

  it('reads the word list: terms, heard forms, no repeats', () => {
    expect(readWordList([{ term: ' Flown ', heard: ['flow in', 7] }, { term: 'flown' }, { heard: ['x'] }, 'x'])).toEqual([{ term: 'Flown', heard: ['flow in'] }])
    // §4.6: terms and heard forms at most 40 characters, at most 5 heard forms.
    const long = readWordList([{ term: 'x'.repeat(50), heard: ['a', 'b', 'c', 'd', 'e', 'f', 'y'.repeat(45)] }])[0]
    expect(long.term).toHaveLength(40)
    expect(long.heard).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('tidyCaptions (test 41)', () => {
  it('capitals: sentence starts, English "i", only after an ended sentence', () => {
    const p = project([timed('a', 0, 'so i think. this works'), timed('b', 5, 'and it goes on'), timed('c', 9, 'yes. more')])
    const out = tidyCaptions(p, { ...OFF, caps: true, words: [] })
    expect(texts(out.project)).toEqual(['So I think. This works', 'and it goes on', 'yes. More'])
    expect(out.changed).toBe(2)
  })

  it('numbers as digits leave a word every object has a name for as it is ("constructor", not "NaN")', () => {
    const p = project([timed('a', 0, 'now we call the constructor of the class')])
    expect(texts(tidyCaptions(p, { ...OFF, digits: 'all', words: [] }).project)).toEqual(['now we call the constructor of the class'])
    expect(texts(tidyCaptions(p, { ...OFF, digits: 'above-ten', words: [] }).project)).toEqual(['now we call the constructor of the class'])
  })

  it('capitals only in scripts with case', () => {
    const p = project([{ id: 'a', start: 0, end: 2, text: 'আমি খুশি। ভালো' }], 'bn')
    expect(tidyCaptions(p, { ...OFF, caps: true, words: [] }).changed).toBe(0)
  })

  it('end marks per language before a pause of 0.7 s, none in Thai; spaces before punctuation go', () => {
    const p = project([timed('a', 0, 'first part ,'), timed('b', 1.2, 'still going'), timed('c', 5, 'the end')])
    expect(texts(tidyCaptions(p, { ...OFF, punct: true, words: [] }).project)).toEqual(['first part,', 'still going.', 'the end.'])
    // Numbers as digits follow the Digits choice (§0.2): Bangla ০–৯ by default and when native, 0–9 when western.
    const count = (language: string, text: string, digits?: 'native' | 'western') =>
      texts(tidyCaptions(project([{ id: 'n', start: 0, end: 2, text }], language, digits ? ({ captions: { ...DEFAULT_CAPTIONS, digits } } as Partial<Project>) : {}), { ...OFF, digits: 'all', words: [] }).project)[0]
    expect(count('bn', 'পঁচিশ টাকা')).toBe('২৫ টাকা')
    expect(count('bn', 'পঁচিশ টাকা', 'native')).toBe('২৫ টাকা')
    expect(count('bn', 'পঁচিশ টাকা', 'western')).toBe('25 টাকা')
    expect(count('hi', 'पच्चीस रुपये', 'native')).toBe('२५ रुपये')
    expect(count('hi', 'पच्चीस रुपये')).toBe('25 रुपये')
    const bn = project([{ id: 'a', start: 0, end: 2, text: 'আমি খুশি' }], 'bn')
    expect(texts(tidyCaptions(bn, { ...OFF, punct: true, words: [] }).project)).toEqual(['আমি খুশি।'])
    const zh = project([{ id: 'a', start: 0, end: 2, text: '我们今天学习' }], 'zh')
    expect(texts(tidyCaptions(zh, { ...OFF, punct: true, words: [] }).project)).toEqual(['我们今天学习。'])
    const th = project([{ id: 'a', start: 0, end: 2, text: 'สวัสดี' }], 'th')
    expect(tidyCaptions(th, { ...OFF, punct: true, words: [] }).changed).toBe(0)
  })

  it('numbers above ten become digits and their word times merge', () => {
    const p = project([timed('a', 0, 'we have twenty five users and three teams')])
    const out = tidyCaptions(p, { ...OFF, digits: 'above-ten', words: [] }).project
    const seg = out.transcript!.segments[0]
    expect(seg.text).toBe('we have 25 users and three teams')
    expect(seg.words).toHaveLength(seg.text.split(' ').length)
    const w = seg.words![2]
    expect(w).toMatchObject({ text: '25', start: 0.8 })
    expect(w.end).toBeCloseTo(1.2 + 0.36)
  })

  it('"All" writes small numbers too, but "this one" and "one of the" stay words', () => {
    const p = project([timed('a', 0, 'pick this one or one of the three')])
    expect(texts(tidyCaptions(p, { ...OFF, digits: 'all', words: [] }).project)).toEqual(['pick this one or one of the 3'])
  })

  it('the word list: whole words, one letter off for long words, heard forms joined', () => {
    const words = [{ term: 'Flown', heard: ['flow in'] }, { term: 'Qbexel', heard: [] }]
    const p = project([timed('a', 0, 'open flown now'), timed('b', 5, 'made by qbexl and flow in team'), timed('c', 9, 'it has flow')])
    const out = tidyCaptions(p, { ...OFF, words }).project
    expect(texts(out)).toEqual(['open Flown now', 'made by Qbexel and Flown team', 'it has flow'])
    const b = out.transcript!.segments[1]
    expect(b.words![4]).toMatchObject({ text: 'Flown', start: 5 + 4 * 0.4 })
  })

  it('the word list leaves words heard right alone', () => {
    const words = [{ term: 'Flown', heard: ['flow in', 'flowen'] }, { term: 'React', heard: [] }, { term: 'Notion', heard: [] }, { term: 'Slack', heard: [] }, { term: 'Figma', heard: [] }]
    const said = ['please reach out', 'the data flows', 'it flowed in', 'the flower icon', 'blown away', 'the motion of the black panel', 'a sigma']
    const p = project(said.map((t, i) => timed(`w${i}`, i * 5, t)))
    expect(texts(tidyCaptions(p, { ...OFF, words }).project)).toEqual(said)
    // A heard form is matched as written.
    expect(texts(tidyCaptions(project([timed('h', 0, 'add a flowen step')]), { ...OFF, words }).project)).toEqual(['add a Flown step'])
  })

  it('a swapped letter is another word, never a term; a letter added or dropped still is', () => {
    const words = ['Slack', 'Swift', 'Claude', 'Notion', 'Flown', 'Stripe', 'Excel'].map((term) => ({ term, heard: [] }))
    const said = ['the call stack is full', 'press shift and tab', 'read the clause again', 'the whole nation watched', 'do not frown', 'strike while hot', 'expel the air', 'that was a stride']
    const p = project(said.map((t, i) => timed(`s${i}`, i * 5, t)))
    expect(texts(tidyCaptions(p, { ...OFF, words }).project)).toEqual(said)
    const typo = project([timed('t', 0, 'open notiion and clade')])
    expect(texts(tidyCaptions(typo, { ...OFF, words }).project)).toEqual(['open Notion and Claude'])
  })

  it('records each changed caption once, keeping the first text across runs', () => {
    const p = project([timed('a', 0, 'so i think'), timed('b', 5, 'Fine.')])
    const once = tidyCaptions(p, { ...OFF, caps: true, words: [] }).project
    expect(once.captionAuto?.text).toEqual([{ caption: 'a', text: 'so i think', words: p.transcript!.segments[0].words }])
    const twice = tidyCaptions(once, { ...OFF, caps: true, punct: true, words: [] }).project
    expect(twice.captionAuto?.text?.[0].text).toBe('so i think')
  })

  it('nothing to tidy returns the same project', () => {
    const p = project([timed('a', 0, 'Fine.')])
    expect(tidyCaptions(p, { ...OFF, caps: true, punct: true, digits: 'above-ten', words: [] })).toEqual({ project: p, changed: 0, bleeped: 0, estimated: 0 })
  })

  it('the AI fix applies after the rules and its changes are recorded', () => {
    const p = project([timed('a', 0, 'helo world'), timed('b', 5, 'Fine.')])
    const ai = { task: 'cleanup' as const, segments: [{ ...p.transcript!.segments[0], text: 'hello world' }, p.transcript!.segments[1]] }
    const out = tidyCaptions(p, { ...OFF, ai: true, words: [], fix: ai })
    expect(texts(out.project)).toEqual(['hello world', 'Fine.'])
    expect(out.project.captionAuto?.text).toMatchObject([{ caption: 'a', text: 'helo world' }])
  })
})

describe('bleeping (tests 41, 50)', () => {
  it('matches swear words with obscenity, not their safe look-alikes', () => {
    expect(isSwearWord('Fuck!', 'standard')).toBe(true)
    expect(isSwearWord('fuuuuck', 'standard')).toBe(true)
    expect(isSwearWord('assassin', 'standard')).toBe(false)
    expect(isSwearWord('classic', 'standard')).toBe(false)
    expect(bleepKey('Shiiiit!!')).toBe('shit')
  })

  it('Strict adds LDNOOBW words; Bangla has the team list', () => {
    const word = 'bullshit'
    expect(isSwearWord(word, 'standard')).toBe(false)
    expect(isSwearWord(word, 'strict')).toBe(true)
    expect(isSwearWord('খানকি', 'standard', 'bn')).toBe(true)
  })

  it('Bangla matches the team list whole: its forms are bleeped, everyday words that start the same are not', () => {
    for (const word of ['বাল', 'বালের', 'চোদা', 'চুদির', 'খানকির', 'হারামজাদারা']) expect(isSwearWord(word, 'standard', 'bn')).toBe(true)
    for (const word of ['চোদ্দ', 'চোদ্দো', 'বালক', 'বালকটি', 'বালিকা', 'বালিশ', 'বালতি', 'বালু', 'বালি', 'বালা', 'বালাই', 'মাগিনা']) {
      expect(isSwearWord(word, 'standard', 'bn')).toBe(false)
      expect(isSwearWord(word, 'strict', 'bn-BD')).toBe(false)
    }
  })

  it('Bangla bleeps the other forms its words take: verb forms, and the nouns with their case and plural endings', () => {
    const forms = ['চোদনা', 'চোদো', 'চোদাও', 'চোদাস', 'খানকিদের', 'খানকিকে', 'মাগিদের', 'মাগিকে', 'বালছাল', 'হারামিদের', 'হারামিকে', 'হারামজাদাকে', 'হারামজাদাদের']
    // The verb forms, চোদনা with its endings (চোদনার বাচ্চা) and the words made from the stems.
    forms.push('চোদি', 'চোদেন', 'চোদত', 'চোদতে', 'চোদবো', 'চোদছে', 'চোদায়', 'চোদাই', 'চোদান', 'চোদনের', 'চুদিনি')
    forms.push('চোদনার', 'চোদনারা', 'চোদনাকে', 'চোদনাটা')
    forms.push('খানকিপনা', 'মাগিবাজ', 'হারামিপনা', 'বালডা')
    for (const word of forms) {
      expect(isSwearWord(word, 'standard', 'bn'), word).toBe(true)
      expect(isSwearWord(word, 'strict', 'bn-BD'), word).toBe(true)
    }
  })

  it('bleeps are time-based: the word ± 0.05 s (± 0.15 s estimated), its word lower case', () => {
    const p = project([timed('a', 10, 'well fuck this'), { id: 'b', start: 20, end: 22, text: 'damn it' }])
    const out = tidyCaptions(p, { ...OFF, bleep: 'standard', words: [] })
    expect(out.bleeped).toBe(1)
    const [b] = out.project.bleeps!
    expect(b).toMatchObject({ word: 'fuck', sound: 'tone', auto: true })
    expect(b.start).toBeCloseTo(10.4 - 0.05)
    expect(b.end).toBeCloseTo(10.4 + 0.36 + 0.05)
    expect(out.project.transcript).toBe(p.transcript)
    // A second run adds none.
    expect(tidyCaptions(out.project, { ...OFF, bleep: 'standard', words: [] }).bleeped).toBe(0)
    expect(bleepGains(out.project)).toEqual([{ start: b.start, end: b.end, gain: 0 }])
    // Exact word times: none estimated. A caption without word times has estimated ones, bleeped wider and counted.
    expect(out.estimated).toBe(0)
    const guessed = tidyCaptions(project([{ id: 'c', start: 30, end: 32, text: 'oh fuck no' }]), { ...OFF, bleep: 'standard', words: [] })
    expect(guessed).toMatchObject({ bleeped: 1, estimated: 1 })
  })

  it('masks keep the first letter in cased scripts, all stars otherwise', () => {
    expect(maskWord('fuck')).toBe('f***')
    expect(maskWord('খানকি')).toBe('***')
  })

  it('masks the bleeped word by time, and every word in the span when the text was edited', () => {
    const seg = timed('a', 10, 'well fuck this, really')
    const bleep: Bleep = { id: 'b', start: 10.35, end: 10.81, word: 'fuck', sound: 'tone' }
    const [masked] = maskedSegments([seg], [bleep])
    expect(masked.text).toBe('well f*** this, really')
    expect(masked.words![1].text).toBe('f***')
    const edited = { ...seg, text: 'well frick this, really', words: seg.words!.map((w, i) => (i === 1 ? { ...w, text: 'frick' } : w)) }
    expect(maskedSegments([edited], [bleep])[0].text).toBe('well f**** this, really')
    expect(maskedSegments([seg], undefined)).toEqual([seg])
    const list = [seg]
    expect(maskedSegments(list, [])).toBe(list)
  })

  it('masks the words the bleeps are for in text drawn from caption words, also made before the bleep', () => {
    const p = tidyCaptions(project([timed('a', 10, 'well fuck this now')]), { ...OFF, bleep: 'standard', words: [] }).project
    expect(maskBleeped('Fuck, this is easy', p.bleeps)).toBe('F***, this is easy')
    const plain = 'nothing to hide here'
    expect(maskBleeped(plain, p.bleeps)).toBe(plain)
    expect(maskBleeped('fuck', undefined)).toBe('fuck')
  })

  it('a bleep survives split and merge, and the project equals what reading it gives', () => {
    const p0 = project([timed('a', 10, 'well fuck this now'), timed('b', 13, 'and more')])
    const p = tidyCaptions(p0, { ...OFF, bleep: 'standard', words: [] }).project
    const split = splitCaption(p.transcript!.segments, 'a', 10.75)!
    const merged = mergeWithNext(split, split[0].id)!
    for (const segments of [split, merged]) {
      const q = { ...p, transcript: { ...p.transcript!, segments } }
      const shown = maskedSegments(segments, q.bleeps).map((s) => s.text).join(' ')
      expect(shown).toContain('f***')
      expect(shown).not.toContain('fuck')
      expect(readBleeps(JSON.parse(JSON.stringify(q.bleeps)), q.duration)).toEqual(q.bleeps)
    }
  })
})

describe('the word list as a transcription hint (§11.7 rule 4)', () => {
  it('keeps plain terms, without repeats, whole terms within the byte cap', () => {
    expect(glossaryTerms(['Flown', ' Qbexel ', 'flown', '', 7, 'a\nb', 'বাংলা\u200c'])).toEqual(['Flown', 'Qbexel', 'a b', 'বাংলা\u200c'])
    expect(glossaryTerms('Flown')).toEqual([])
    // Bangla is three bytes a letter: the cap counts bytes, so the engine's 1,024-byte prompt always fits.
    const many = glossaryTerms(Array.from({ length: 100 }, (_, i) => `অআইঈউঊঋএঐও${i}`))
    const bytes = new TextEncoder().encode(glossaryLine(many)!).length
    expect(bytes).toBeLessThanOrEqual(GLOSSARY_BYTES + 11)
    expect(bytes).toBeGreaterThan(GLOSSARY_BYTES - 40)
  })

  it('reads as one line', () => {
    expect(glossaryLine(['Flown', 'Qbexel'])).toBe('Glossary: Flown, Qbexel.')
    expect(glossaryLine(['Flown'], 'Spell these names as written')).toBe('Spell these names as written: Flown.')
    expect(glossaryLine([])).toBeUndefined()
  })
})

describe("Tidy captions' notice (§2.9)", () => {
  it('says what changed, or that there was nothing to tidy', () => {
    expect(cleanupNotice({ changed: 12, bleeped: 2 })).toBe('Tidied 12 captions, bleeped 2 words')
    expect(cleanupNotice({ changed: 1, bleeped: 0 })).toBe('Tidied 1 caption')
    expect(cleanupNotice({ changed: 0, bleeped: 1, estimated: 1 })).toBe('Bleeped 1 word. Some bleeped words have estimated times, so a little more is bleeped')
    expect(cleanupNotice({ changed: 0, bleeped: 0 })).toBe('Nothing to tidy')
  })
})
