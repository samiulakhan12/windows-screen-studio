/**
 * Names of found chapters (docs/design/smart-tools.md §7.5, §7.6; §22.1 tests 39, 40 and 118): a
 * title card, the first sentence, a phrase said in it, the sentence cut short, a number; private
 * text never; an AI's names checked the same way.
 */
import { describe, expect, it } from 'vitest'
import { chapterNames, cleanName, namesRequestForChapters, phraseName, weakName, withAiNames } from '../src/shared/chapters/names'
import type { Chapter, Project, TitleCard } from '../src/shared/types'
import { chapterProject, type Said } from './chapterFixtures'

const card = (start: number, title: string, extra: Partial<TitleCard> = {}): TitleCard => ({ id: `t${start}`, start, end: start + 3, title, style: 'lower-third', background: 'blur', ...extra })
/** Names of chapters at `starts` in a 3-minute project saying `said`. */
const names = (said: Said[], starts: number[], extra: { titles?: TitleCard[]; language?: string; chapters?: Chapter[]; digits?: 'native' | 'western' } = {}) => {
  const p = chapterProject({ duration: 180, said, language: extra.language, titles: extra.titles, chapters: extra.chapters })
  const project = (extra.digits ? { ...p, captions: { ...p.captions, digits: extra.digits } } : p) as Project
  return chapterNames(
    project,
    starts.map((t) => ({ t }))
  )
}

describe('the offline names (test 39)', () => {
  it("a title card the user made within 3 s wins; one Captions Studio made does not", () => {
    const said = [{ t: 61, text: 'Now we open settings.' }]
    expect(names(said, [0, 60], { titles: [card(62.5, 'Settings tour')] })[1]).toEqual({ title: 'Settings tour', name: 'card' })
    expect(names(said, [0, 60], { titles: [card(64, 'Settings tour')] })[1]).toEqual({ title: 'Open settings', name: 'sentence' })
    expect(names(said, [0, 60], { titles: [card(60, 'Settings', { auto: { by: 'chapter', via: 'rules', chapter: 'x' } })] })[1].name).toBe('sentence')
  })

  it('the first sentence: cue words, fillers and lead-ins off, cut at the clause', () => {
    expect(names([{ t: 61, text: "Now let's set up billing, which takes a minute." }], [0, 60])[1]).toEqual({ title: 'Set up billing', name: 'sentence' })
    expect(names([{ t: 61, text: 'So, okay, first we open the settings page' }], [0, 60])[1]).toEqual({ title: 'Open the settings page', name: 'sentence' })
    expect(names([{ t: 61, text: 'Next we open settings' }], [0, 60])[1]).toEqual({ title: 'Open settings', name: 'sentence' })
    // Only a sentence starting in the first 20 s of the chapter.
    expect(names([{ t: 81, text: 'Next we open settings' }], [0, 60])[1].name).not.toBe('sentence')
  })

  it('a 9-word clause gives a phrase said in the chapter', () => {
    const said = [
      { t: 61, text: 'Open the quarterly billing report for the whole team.' },
      { t: 66, text: 'The billing report lists every invoice.' }
    ]
    const out = names(said, [0, 60])[1]
    expect(out.name).toBe('phrase')
    expect(out.title).toBe('Billing report')
  })

  it('a long sentence with nothing said twice is cut to 40 graphemes at a word, never inside ক্ষ or স্ত্র', () => {
    const text = 'আমরা এখানে বিভিন্ন ক্ষেত্রের স্ত্রী পুরুষ সবার জন্য একটি নতুন পরীক্ষামূলক ব্যবস্থার কথা বলছি।'
    const out = names([{ t: 61, text }], [0, 60], { language: 'bn' })[1]
    expect(out.name).toBe('cut')
    const graphemes = Array.from(new Intl.Segmenter('bn', { granularity: 'grapheme' }).segment(out.title))
    expect(graphemes.length).toBeLessThanOrEqual(40)
    // At a word: what is left of the sentence starts with a space.
    expect(text.startsWith(out.title)).toBe(true)
    expect(text[out.title.length]).toBe(' ')
    expect(out.title.endsWith('্')).toBe(false)
    const english = names([{ t: 61, text: 'This is one more really long sentence that keeps going on past forty characters.' }], [0, 60])[1]
    expect(english.name).toBe('cut')
    expect(english.title.length).toBeLessThanOrEqual(40)
  })

  it('a name with a link, an address or a path falls to the next source', () => {
    expect(names([{ t: 61, text: 'Next we open settings' }], [0, 60], { titles: [card(60, 'see example.com')] })[1]).toEqual({ title: 'Open settings', name: 'sentence' })
    expect(names([{ t: 61, text: 'Next we open settings' }], [0, 60], { titles: [card(60, 'C:\\Users\\sam')] })[1]).toEqual({ title: 'Open settings', name: 'sentence' })
    const linked = names([{ t: 61, text: 'Now open example.com in the browser.' }], [0, 60])[1]
    expect(linked.title).not.toMatch(/example/)
    const path = names([{ t: 61, text: 'Next we open C:\\Users\\sam\\notes now.' }], [0, 60])[1]
    expect(path.title).not.toMatch(/Users|sam/)
    for (const n of [linked, path]) expect(['phrase', 'cut', 'number']).toContain(n.name)
  })

  it('a duplicate falls to the next source', () => {
    const said = [
      { t: 1, text: 'Next we open settings.' },
      { t: 61, text: 'Now we open settings.' },
      { t: 64, text: 'The settings page shows the settings of the team.' }
    ]
    const out = names(said, [0, 60])
    expect(out[0]).toEqual({ title: 'Open settings', name: 'sentence' })
    expect(out[1].title).not.toBe('Open settings')
    // The user's chapter names count too.
    expect(names([{ t: 61, text: 'Next we open settings' }], [0, 60], { chapters: [{ id: 'u', t: 120, title: 'open SETTINGS' }] })[1].name).not.toBe('sentence')
  })

  it('a number: "Part 3" and "অংশ ৩"; the 0:00 chapter "Intro" and "শুরু"', () => {
    expect(names([], [0, 60, 120])).toEqual([
      { title: 'Intro', name: 'number' },
      { title: 'Part 2', name: 'number' },
      { title: 'Part 3', name: 'number' }
    ])
    const bn = chapterProject({ duration: 180, said: [{ t: 170, text: 'শেষ।' }], language: 'bn' })
    expect(chapterNames(bn, [{ t: 0 }, { t: 60 }, { t: 120 }]).map((n) => n.title)).toEqual(['শুরু', 'অংশ ২', 'অংশ ৩'])
    // Digits as the captions' Digits choice.
    expect(chapterNames({ ...bn, captions: { ...bn.captions, digits: 'western' } } as Project, [{ t: 0 }, { t: 60 }, { t: 120 }]).map((n) => n.title)).toEqual(['শুরু', 'অংশ 2', 'অংশ 3'])
    // Numbered by place among every chapter: the user's at 1:30 is the third.
    expect(names([], [0, 60, 120], { chapters: [{ id: 'u', t: 90, title: 'Mine' }] }).map((n) => n.title)).toEqual(['Intro', 'Part 2', 'Part 4'])
  })

  it('names are cut to 100 graphemes, never inside a cluster', () => {
    const clean = cleanName('ক্ষ'.repeat(120))
    expect(clean).toBe('ক্ষ'.repeat(100))
    expect(Array.from(new Intl.Segmenter('bn', { granularity: 'grapheme' }).segment(clean))).toHaveLength(100)
    expect(cleanName(' a\nb\tc ')).toBe('a b c')
  })
})

describe('names, rule by rule (test 118)', () => {
  it('rule 2 takes up to 8 words after the clause cut, and no more', () => {
    expect(names([{ t: 61, text: "Now let's open the quarterly billing report for the team, then share it." }], [0, 60])[1]).toEqual({ title: 'Open the quarterly billing report for the team', name: 'sentence' })
    expect(names([{ t: 61, text: 'Open the quarterly billing report for the whole team.' }], [0, 60])[1].name).not.toBe('sentence')
  })

  it('the phrase rule picks a run said in one sentence, never one that starts or ends with a stop word', () => {
    const chapter = [
      ['The', 'invoice', 'settings', 'page.'],
      ['Change', 'the', 'invoice', 'settings', 'there.']
    ]
    const all = [...chapter.flat(), 'other', 'words', 'elsewhere', 'in', 'the', 'video']
    expect(phraseName(chapter, all, 'en')).toBe('Invoice settings')
    // A run never crosses sentences: "page Change" is not one.
    expect(phraseName([['Billing.'], ['Billing.']], ['Billing', 'Billing'], 'en')).toBeNull()
    // Nothing said twice: no phrase.
    expect(phraseName([['Open', 'the', 'quarterly', 'report']], ['Open', 'the', 'quarterly', 'report'], 'en')).toBeNull()
    // A comma ends a run.
    expect(phraseName([['Billing,', 'invoices', 'billing']], ['Billing', 'invoices', 'billing'], 'en')).toBe('Invoices billing')
  })

  it('falls back to the object said most often in the chapter (uiObjects), at least twice', () => {
    const said = [
      { t: 61, text: 'Okay so now we are going to do this one more time.' },
      { t: 66, text: 'Click OK.' },
      { t: 68, text: 'Click OK.' }
    ]
    expect(names(said, [0, 60])[1]).toEqual({ title: 'OK', name: 'phrase' })
    // Said once: not a name.
    expect(names(said.slice(0, 2), [0, 60])[1].name).toBe('cut')
  })

  it("weakName is true for 'cut' and 'number' only", () => {
    expect(weakName('cut')).toBe(true)
    expect(weakName('number')).toBe(true)
    for (const n of ['card', 'sentence', 'phrase', 'ai'] as const) expect(weakName(n)).toBe(false)
  })
})

describe('names with AI (test 40)', () => {
  const said = [
    { t: 1, text: 'Welcome to the billing tour.' },
    { t: 61, text: 'Now open example.com in the browser and sign in.' },
    { t: 125, text: 'Finally we export the report.' }
  ]

  it('sends each chapter with words, by its index, its kept narration from the start, bleeped words masked', () => {
    const p = chapterProject({ duration: 180, said })
    const request = namesRequestForChapters(p, [0, 60, 120])
    expect(request.kind).toBe('chapter')
    expect(request.language).toBe('en')
    expect(request.items.map((i) => i.id)).toEqual(['0', '1', '2'])
    expect(request.items[0].text).toBe('Welcome to the billing tour.')
    // A chapter with no words is not sent.
    expect(namesRequestForChapters(p, [0, 30, 60, 120]).items.map((i) => i.id)).toEqual(['0', '2', '3'])
    // A cut word is not sent.
    const cut = { ...p, clips: [{ id: 'a', start: 0, end: 125, speed: 1 }, { id: 'b', start: 125.32, end: 180, speed: 1 }] }
    expect(namesRequestForChapters(cut, [0, 60, 120]).items[2].text).not.toMatch(/Finally/)
    // At most 1,500 characters.
    const long = chapterProject({ duration: 600, said: Array.from({ length: 80 }, (_, i) => ({ t: 1 + i * 6, text: 'Billing settings and invoices for everyone here.' })) })
    expect(namesRequestForChapters(long, [0]).items[0].text.length).toBeLessThanOrEqual(1500)
  })

  it("a valid answer replaces the names; a name holding a link or a path keeps the offline name, also when the chapter's words held it", () => {
    const p = chapterProject({ duration: 180, said })
    const offline = chapterNames(p, [{ t: 0 }, { t: 60 }, { t: 120 }])
    const out = withAiNames(offline, [
      { id: '0', name: 'Billing tour' },
      { id: '1', name: 'Open example.com' },
      { id: '2', name: 'Export from C:\\Users\\sam' }
    ])
    expect(out[0]).toEqual({ title: 'Billing tour', name: 'ai', ai: true })
    expect(out[1]).toEqual({ ...offline[1], ai: false })
    expect(out[2]).toEqual({ ...offline[2], ai: false })
    // Unknown ids and repeats are ignored; a name that repeats another keeps the offline one.
    const again = withAiNames(offline, [
      { id: '9', name: 'Ghost' },
      { id: '1', name: offline[2].title },
      { id: '2', name: 'Export the report again' },
      { id: '2', name: 'Ignored' }
    ])
    expect(again[1].ai).toBe(false)
    expect(again[2]).toEqual({ title: 'Export the report again', name: 'ai', ai: true })
  })

  it("an AI's suggested title (Suggest chapters) names its start, checked the same way", () => {
    const p = chapterProject({ duration: 180, said })
    expect(chapterNames(p, [{ t: 0, ai: 'Billing tour' }, { t: 60, ai: 'Go to example.com' }])).toEqual([
      { title: 'Billing tour', name: 'ai' },
      expect.objectContaining({ name: expect.not.stringMatching(/^ai$/) })
    ])
  })
})
