/**
 * Captions Studio tests 41 and 50 (P4's part) (docs/design/captions-studio.md §11.7): clean-up
 * rules, the word list, bleeping, masks by time, and the AI fix's records.
 */
import { describe, expect, it } from 'vitest'
import { bleepGains, bleepKey, cleanupNotice, DEFAULT_CLEANUP, glossaryLine, glossaryTerms, GLOSSARY_BYTES, isSwearWord, maskBleeped, maskedSegments, maskWord, readCleanupChoices, readWordList, tidyCaptions, type CleanupChoices } from '../src/shared/captions/cleanup'
import { mergeWithNext, splitCaption } from '../src/shared/captions/edit'
import { readBleeps } from '../src/shared/captions/studioData'
import { languageSubtitleFile } from '../src/shared/captions/subtitles'
import { studioProject } from './p4Fixtures'
import { joinGains, soundGainAt, soundGains } from '../src/shared/audio/soundsEdit'
import { anchorCutWords, cutFlags, cutWords, settleDeletedWords, transcriptWords } from '../src/shared/editor/transcript'
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

  it('vowel signs and tone marks are part of a word, never its punctuation: Bangla and Hindi numbers, word-list heard forms', () => {
    const tidy = (language: string, text: string, words: { term: string; heard: string[] }[] = []): string =>
      texts(tidyCaptions(project([{ id: 'a', start: 0, end: 2, text }, { id: 'b', start: 2.2, end: 3, text: 'শেষ' }], language), { ...DEFAULT_CLEANUP, words }).project)[0]
    expect(tidy('bn', 'আমার বয়স এগারো বছর')).toBe('আমার বয়স ১১ বছর')
    expect(tidy('bn', 'বারো আর পনেরো')).toBe('১২ আর ১৫')
    expect(tidy('bn', 'দাম আশি টাকা')).toBe('দাম ৮০ টাকা')
    expect(tidy('bn', 'একশো টাকা')).toBe('১০০ টাকা')
    expect(tidy('hi', 'उम्र अस्सी साल')).toBe('उम्र 80 साल')
    expect(tidy('bn', 'আমরা ফ্লো ইন ব্যবহার করি', [{ term: 'Flown', heard: ['ফ্লো ইন'] }])).toBe('আমরা Flown ব্যবহার করি')
    expect(tidy('hi', 'हम फ्लो इन खोलते हैं', [{ term: 'Flown', heard: ['फ्लो इन'] }])).toBe('हम Flown खोलते हैं')
    expect(tidy('th', 'เปิด ไลน์ แล้ว', [{ term: 'LINE', heard: ['ไลน์'] }])).toBe('เปิด LINE แล้ว')
    // Punctuation after the sign still stays punctuation.
    expect(tidy('bn', 'বয়স এগারো, তাই')).toBe('বয়স ১১, তাই')
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

  it('the word list: whole words and heard forms, heard forms joined', () => {
    const words = [{ term: 'Flown', heard: ['flow in'] }, { term: 'Qbexel', heard: ['qbexl'] }]
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

  it('a word a letter away from a term is another word, never the term; a heard form is', () => {
    const words = ['Slack', 'Swift', 'Claude', 'Notion', 'Flown', 'Stripe', 'Excel', 'Stuart', 'Steven', 'Pearson', 'Flickr', 'Planet', 'Marie', 'Tumblr', 'Linear'].map((term) => ({ term, heard: [] }))
    const said = ['the call stack is full', 'press shift and tab', 'read the clause again', 'the whole nation watched', 'do not frown', 'strike while hot', 'expel the air', 'that was a stride', 'click start to begin', 'there are seven steps', 'every person on the team', 'the screen will flicker', 'water the plant daily', 'a marine biologist', 'the tumbler fell', 'a new liner', 'a clade of birds']
    const p = project(said.map((t, i) => timed(`s${i}`, i * 5, t)))
    expect(texts(tidyCaptions(p, { ...OFF, words }).project)).toEqual(said)
    // "seven" stays a number word, so Digits can still write it.
    expect(texts(tidyCaptions(project([timed('d', 0, 'there are seven steps')]), { ...OFF, digits: 'all', words }).project)).toEqual(['there are 7 steps'])
    const heard = [{ term: 'Notion', heard: ['notiion'] }, { term: 'Claude', heard: ['clade'] }]
    expect(texts(tidyCaptions(project([timed('t', 0, 'open notiion and clade')]), { ...OFF, words: heard }).project)).toEqual(['open Notion and Claude'])
  })

  it('records each changed caption once, keeping the first text across runs', () => {
    const p = project([timed('a', 0, 'so i think'), timed('b', 5, 'Fine.')])
    const once = tidyCaptions(p, { ...OFF, caps: true, words: [] }).project
    // With which words before each word came from: "So I think" word for word.
    expect(once.captionAuto?.text).toEqual([{ caption: 'a', text: 'so i think', words: p.transcript!.segments[0].words, map: [[0, 2, 0, 2]] }])
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
    // A Bengali letter written twice is a word's own spelling (বালককে, "to the boy", is not বালকে).
    expect(bleepKey('বালককে')).toBe('বালককে')
    expect(bleepKey('বাস্টার্ডডা')).toBe('বাস্টার্ডডা')
  })

  it('Strict adds LDNOOBW words; Bangla has the team list', () => {
    const word = 'bullshit'
    expect(isSwearWord(word, 'standard')).toBe(false)
    expect(isSwearWord(word, 'strict')).toBe(true)
    expect(isSwearWord('খানকি', 'standard', 'bn')).toBe(true)
  })

  it('Bangla matches the team list whole: its forms are bleeped, everyday words that start the same are not', () => {
    for (const word of ['বাল', 'বালের', 'চোদা', 'চুদির', 'খানকির', 'হারামজাদারা']) expect(isSwearWord(word, 'standard', 'bn')).toBe(true)
    // শুয়োর (pig) is an everyday word too, with য় written either way.
    const everyday = ['চোদ্দ', 'চোদ্দো', 'বালক', 'বালকটি', 'বালিকা', 'বালিশ', 'বালতি', 'বালু', 'বালি', 'বালা', 'বালাই', 'মাগিনা', 'শুয়োর', 'শু\u09DFোর']
    everyday.push('চৌদ্দ', 'হারাম', 'হারামের', 'শুয়ে', 'বালাম', 'মাগুর', 'বালুচর')
    // বালককে, "to the boy", and কেঁচোদের, "earthworms'".
    everyday.push('বালককে', 'বালককেও', 'বালককেই', 'কেঁচোদের', 'কেঁচোদেরকে')
    for (const word of everyday) {
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
    // Every person and tense, made from the stems চোদ, চুদ and the causative চোদা, and the Dhaka forms.
    forms.push('চোদব', 'চোদবে', 'চোদবেন', 'চোদছি', 'চোদছো', 'চোদছ', 'চোদল', 'চোদলে', 'চোদলাম', 'চোদলি', 'চোদতো', 'চোদাবো', 'চোদাবে', 'চোদালো', 'চোদাতাম', 'চোদানি')
    forms.push('চুদলাম', 'চুদছি', 'চুদছে', 'চুদেছে', 'চুদেছিস', 'চুদবো', 'চুদবি', 'চুদতাম', 'চুদতে', 'চোদাচ্ছে', 'চোদাচুদি', 'চুদিরে')
    forms.push('চোদাইছে', 'চোদাইস', 'চোদাইতে', 'চুদতাছে', 'চুদুম')
    // The Dhaka plural গো and the particles ও and ই on the nouns, and বাল's case forms.
    forms.push('খানকিগো', 'মাগিগো', 'হারামিগো', 'হারামজাদাগো', 'খানকিও', 'মাগিও', 'চোদনাই', 'মাগিগুলো', 'বালও', 'বালে', 'বালটার')
    // Written another way, as a cloud transcript, a translation or typed text may: য় as one code point
    // (U+09DF), ো in two parts (U+09C7 U+09BE).
    forms.push('চোদা\u09DF', 'শু\u09DFোরের', 'চ\u09C7\u09BEদনা', 'চ\u09C7\u09BEদব')
    // The participle (চুদিয়ে দেব), the Dhaka future and continuous (তোরে চোদমু, চুদতেছিস), the Dhaka ডা
    // and গুলা on the nouns, the nouns written with ী, and the common compounds.
    forms.push('চুদিয়ে', 'চুদিয়া', 'চুদিয়েছে', 'চোদমু', 'চুদমু', 'চুদতেছি', 'চুদতেছিস', 'চুদতেছো', 'চুদছোস')
    forms.push('হারামিডা', 'মাগিডা', 'খানকিডা', 'হারামজাদাডা', 'মাগিগুলা')
    forms.push('মাগী', 'খানকী', 'হারামী', 'মাগীর', 'খানকীর', 'হারামজাদি', 'হারামজাদী')
    forms.push('বোকাচোদা', 'বানচোদ', 'মাদারচোদ', 'চুদমারানি', 'চুতমারানি', 'খানকিরপোলা')
    for (const word of forms) {
      expect(isSwearWord(word, 'standard', 'bn'), word).toBe(true)
      expect(isSwearWord(word, 'strict', 'bn-BD'), word).toBe(true)
    }
  })

  it('a mostly Bangla transcript that names no language is tidied and bleeped as Bangla, as its captions are read (§0.2)', () => {
    const segs = [timed('a', 0, 'তোরে চোদব আমি'), timed('b', 5, 'আমরা আজ শিখব কীভাবে')]
    const unnamed = project(segs, 'bn')
    delete (unnamed.transcript as { language?: string }).language
    for (const p of [project(segs, 'bn'), unnamed]) {
      for (const bleep of ['standard', 'strict'] as const) {
        const out = tidyCaptions(p, { ...OFF, punct: true, bleep, words: [] })
        // The Bangla word is bleeped (never played or shown), and the captions end with the Bangla full stop.
        expect(out.project.bleeps?.map((b) => b.word), bleep).toEqual(['চোদব'])
        expect(texts(out.project)).toEqual(['তোরে চোদব আমি।', 'আমরা আজ শিখব কীভাবে।'])
      }
    }
  })

  it('a mostly Bangla transcript with English words that names no language (OpenAI, Gemini) is tidied and bleeped as Bangla; English with a few Bangla words as English, its Bangla words bleeped by the Bangla list', () => {
    const unnamed = (lines: string[]): Project => {
      const p = project(lines.map((text, i) => timed(String(i), i * 10, text)))
      delete (p.transcript as { language?: string }).language
      return p
    }
    // 16 of its 24 words are Bangla: 44% of its letters, 56% with their vowel signs and hasanta.
    const mixed = ['তো guys আজকের video তে আমরা দেখবো কিভাবে Node.js install করতে হয়', 'প্রথমে browser খুলে official website এ যাবো', 'ধুর বাল আবার error দিচ্ছে']
    const english = ['Today we will install Node.js on Windows', 'first open the browser and go to the official website', 'he said ধুর বাল and left']
    for (const bleep of ['standard', 'strict'] as const) {
      const bn = tidyCaptions(unnamed(mixed), { ...OFF, punct: true, bleep, words: [] })
      expect(bn.project.bleeps?.map((b) => b.word), bleep).toEqual(['বাল'])
      expect(texts(bn.project)).toEqual(mixed.map((t) => `${t}।`))
      const en = tidyCaptions(unnamed(english), { ...OFF, punct: true, bleep, words: [] })
      expect(en.project.bleeps?.map((b) => b.word), bleep).toEqual(['বাল'])
      expect(texts(en.project)).toEqual(english.map((t) => `${t}.`))
    }
  })

  it('Tidy captions bleeps the Bangla participle, the Dhaka forms, the ী spellings and the compounds in a Bangla caption', () => {
    const lines = ['তোরে চুদিয়ে দেব', 'তোরে চোদমু আজকে', 'ওই হারামিডা আবার আসছে', 'এই মাগী কোথায়', 'শালা বোকাচোদা একটা']
    const segs = lines.map((text, i) => timed(String(i), i * 5, text))
    for (const bleep of ['standard', 'strict'] as const) {
      const out = tidyCaptions(project(segs, 'bn'), { ...OFF, bleep, words: [] })
      expect(out.project.bleeps?.map((b) => b.word), bleep).toEqual(['চুদিয়ে', 'চোদমু', 'হারামিডা', 'মাগী', 'বোকাচোদা'].map(bleepKey))
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

  it('a masked word keeps its time when the caption’s words do not line up with its text, so a word cut from the video stays out of the subtitles', () => {
    const spoken = (text: string, words: string[]): CaptionSegment => {
      const ws = words.map((w, i) => ({ text: w, start: i * 0.5, end: i * 0.5 + 0.4 }))
      return { id: 'a', start: 0, end: ws[ws.length - 1].end, text, words: ws }
    }
    // The bleeped word (1.5–1.9 s) cut on the timeline, the bleep made before the cut.
    const clips = [
      { id: 'k0', start: 0, end: 1.45, speed: 1 },
      { id: 'k1', start: 1.95, end: 30, speed: 1 }
    ]
    const bleep: Bleep = { id: 'b1', start: 1.45, end: 1.95, word: 'fucking', sound: 'tone' }
    const scenarios = [
      // "um" deleted from the text by hand: the six word times stay.
      { seg: spoken('so this fucking thing works', ['so', 'um', 'this', 'fucking', 'thing', 'works']), out: 'so this thing works' },
      // whisper-1 gives "well-known" as two words.
      { seg: spoken('This well-known fucking tool works.', ['This', 'well', 'known', 'fucking', 'tool', 'works.']), out: 'This well-known tool works.' },
      // As many words as the text, but not the same ones: "um" deleted and "really" typed in by
      // hand, or "well-known" timed as two words and "really" typed in.
      { seg: spoken('so this fucking thing really works', ['so', 'um', 'this', 'fucking', 'thing', 'works']), out: 'so this thing really works' },
      { seg: spoken('This well-known fucking tool really works.', ['This', 'well', 'known', 'fucking', 'tool', 'works.']), out: 'This well-known tool really works.' },
      // A Bangla caption so edited ("উম" deleted, "গেল" typed in).
      { seg: spoken('ওই তো মাগি চলে গেল', ['ওই', 'উম', 'তো', 'মাগি', 'চলে']), out: 'ওই তো চলে গেল', word: 'মাগি' }
    ]
    for (const { seg, out, word = 'fucking' } of scenarios) {
      const p = { ...studioProject({ segments: [seg] }), clips }
      expect(languageSubtitleFile(p, null, 'txt').trim()).toBe(out)
      const q = { ...p, bleeps: [{ ...bleep, word: bleepKey(word) }] }
      for (const format of ['txt', 'srt', 'vtt'] as const) expect(languageSubtitleFile(q, null, format), `${seg.text} ${format}`).toBe(languageSubtitleFile(p, null, format))
      // Only the bleeped word is masked ("f******"), and it keeps its own time.
      const [masked] = maskedSegments([seg], q.bleeps)
      const at = seg.text.split(' ').indexOf(word)
      const mask = masked.text.split(' ')[at]
      expect(mask).not.toContain(word.slice(0, 2))
      expect(masked.text).toBe(seg.text.replace(word, mask))
      expect(masked.words?.find((w) => w.text === mask), seg.text).toEqual({ text: mask, start: 1.5, end: 1.9 })
    }
    expect(maskedSegments([scenarios[0].seg], [bleep])[0].text).toBe('so this f****** thing works')
    // Captions a bleep masks nothing in stay the same objects.
    const other = spoken('so this fucking thing works', ['so', 'um', 'this', 'fucking', 'thing', 'works'])
    const list = [other]
    expect(maskedSegments(list, [{ ...bleep, start: 20, end: 21 }])).toBe(list)
  })

  it('masks a Bangla word whole, its last vowel sign or hasanta too, and keeps its punctuation', () => {
    const lines = ['ওই মাগি চলে গেল', 'হারামজাদা গেল কই', 'ধুর শালা-খানকি।', 'মাগি, চলে যা', 'ওই বাঞ্চোত্ কোথায়']
    const p = tidyCaptions(project(lines.map((text, i) => timed(String(i), i * 5, text)), 'bn'), { ...OFF, bleep: 'standard', words: [] }).project
    expect(p.bleeps).toHaveLength(5)
    const shown = maskedSegments(p.transcript!.segments, p.bleeps).map((s) => s.text)
    expect(shown.slice(0, 4)).toEqual(['ওই ** চলে গেল', '***** গেল কই', 'ধুর ******।', '**, চলে যা'])
    // Nothing of the word is left, however its conjuncts are counted.
    expect(shown[4]).toMatch(/^ওই \*+ কোথায়$/u)
    // In the subtitle files as well, and in text drawn from caption words.
    expect(languageSubtitleFile({ ...studioProject({ segments: p.transcript!.segments, language: 'bn' }), bleeps: p.bleeps }, null, 'txt')).toContain('ওই ** চলে গেল')
    expect(maskBleeped('মাগি! চলে গেল', p.bleeps)).toBe('**! চলে গেল')
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

  it('a short swear word right after a bleeped one gets its own bleep: masked and muted over all its time, also with the one before deleted', () => {
    // The words touching, as a provider often times them: the middle of the short word after the
    // first one is inside the first one's bleep (its 0.05 s widening), another word's or the same one's.
    for (const [first, second] of [['fucking', 'bitch'], ['fuck', 'fuck']]) {
      const words = [
        { text: 'this', start: 1, end: 1.3 },
        { text: first, start: 1.33, end: 1.7 },
        { text: second, start: 1.7, end: 1.8 },
        { text: 'is', start: 1.83, end: 1.95 }
      ]
      const said = project([{ id: 's1', start: 1, end: 1.95, text: words.map((w) => w.text).join(' '), words }])
      const tidy = (q: Project): Project => tidyCaptions(q, { ...OFF, bleep: 'standard', bleepSound: 'tone', words: [] }).project
      const p = tidy(said)
      expect(p.bleeps!.map((b) => [b.word, b.start, b.end])).toEqual([
        [bleepKey(first), expect.closeTo(1.28, 9), expect.closeTo(1.75, 9)],
        [bleepKey(second), expect.closeTo(1.65, 9), expect.closeTo(1.85, 9)]
      ])
      expect(maskedSegments(p.transcript!.segments, p.bleeps)[0].text).toBe(`this ${maskWord(first)} ${maskWord(second)} is`)
      const gains = joinGains(soundGains(p))
      for (const t of [1.71, 1.74, 1.76, 1.79]) expect(soundGainAt(gains, t)).toBe(0)
      // Tidy captions again adds nothing.
      expect(tidy(p).bleeps).toEqual(p.bleeps)
      // The first word deleted in the Transcript tab: the second is still muted over all its time.
      const cut: Project = { ...p, clips: cutWords(p.clips, transcriptWords(p.transcript), [[1, 1]], p.duration) }
      expect(cutFlags(transcriptWords(cut.transcript), cut.clips)).toEqual([false, true, false, false])
      const left = joinGains(soundGains(cut))
      for (const t of [1.71, 1.74, 1.76, 1.79]) expect(soundGainAt(left, t)).toBe(0)
    }
  })

  it('the same swear word twice, either one short or with no length, in either order: each bleeped for itself, muted over all its time with the other deleted', () => {
    // Providers squeeze fast repeats ("fuck fuck"), or give a word start == end. The other word's
    // bleep (its 0.05 s widening) can cover all of the short one: it is still not the short one's,
    // since deleting the other word drops it (bleepCutOut). Also when an earlier Tidy captions
    // bleeped only the other word, and Tidy run again adds nothing.
    const tidy = (q: Project): Project => tidyCaptions(q, { ...OFF, bleep: 'standard', bleepSound: 'tone', words: [] }).project
    const inside = (w: { start: number; end: number }): number[] =>
      w.end - w.start > 0.004 ? [w.start + 0.002, (w.start + w.end) / 2, w.end - 0.002] : [(w.start + w.end) / 2]
    let cases = 0
    for (const shortFirst of [false, true])
      for (const short of [0, 0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1])
        for (const long of [0.1, 0.3])
          for (const gap of [0, 0.01, 0.03, 0.05]) {
            const at = 1.33
            const [a, b] = shortFirst ? [short, long] : [long, short]
            const words = [
              { text: 'this', start: 1, end: 1.3 },
              { text: 'fuck', start: at, end: at + a },
              { text: 'fuck', start: at + a + gap, end: at + a + gap + b },
              { text: 'is', start: at + a + gap + b + 0.03, end: at + a + gap + b + 0.2 }
            ]
            const said = project([{ id: 's1', start: 1, end: words[3].end, text: words.map((w) => w.text).join(' '), words }])
            const fresh = tidy(said)
            // An earlier Tidy captions bleeped only the long word: the short one is bleeped now.
            const longWord = words[shortFirst ? 2 : 1]
            const earlier = { ...fresh, bleeps: fresh.bleeps!.filter((x) => x.start < longWord.start && x.end > longWord.end) }
            const name = `${shortFirst ? 'short first' : 'short second'}, short ${short} s, long ${long} s, gap ${gap} s`
            expect(earlier.bleeps, name).toHaveLength(1)
            for (const p of [fresh, tidy(earlier)]) {
              expect(maskedSegments(p.transcript!.segments, p.bleeps)[0].text, name).toBe('this f*** f*** is')
              expect(p.bleeps, name).toHaveLength(2)
              expect(tidy(p).bleeps, `${name}: Tidy again`).toEqual(p.bleeps)
              // Either word deleted in the Transcript tab: the other stays muted over all its time.
              for (const [gone, kept] of [[1, 2], [2, 1]]) {
                const clips = cutWords(p.clips, transcriptWords(p.transcript), [[gone, gone]], p.duration)
                const cut = settleDeletedWords({ ...p, clips, transcript: anchorCutWords(p.transcript, p.clips, clips, [[gone, gone]]) }, p)
                const flags = cutFlags(transcriptWords(cut.transcript), cut.clips)
                // A word with no length touching the other keeps its instant in the edit (the cut
                // ends there), and deleting it can also cut the other: nothing to check then.
                if (!flags[gone] || flags[kept]) continue
                const gains = joinGains(soundGains(cut))
                for (const t of inside(words[kept])) expect(soundGainAt(gains, t), `${name}: word ${kept} at ${t} with word ${gone} deleted`).toBe(0)
                cases++
              }
            }
          }
    // 640 deletions in all: nearly every one leaves the other word in the edit.
    expect(cases).toBeGreaterThan(600)
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
