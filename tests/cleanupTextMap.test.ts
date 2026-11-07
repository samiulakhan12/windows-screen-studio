/**
 * The word map each tidy step writes into its text record (docs/design/captions-studio.md §11.1
 * rule 1, §11.7): which words before each tidied word came from, as marks count words. Read back
 * through the project reader unchanged.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CLEANUP, tidyCaptions, type CleanupChoices, type TextResult, type WordListEntry } from '../src/shared/captions/cleanup'
import { readCaptionAuto } from '../src/shared/captions/studioData'
import { wordRanges } from '../src/shared/captions/textMap'
import { studioWordTexts } from '../src/shared/captions/words'
import type { CaptionSegment, Project } from '../src/shared/types'
import { captions, studioProject } from './p4Fixtures'

const OFF: CleanupChoices = { caps: false, punct: false, digits: 'off', bleep: 'off', bleepSound: 'tone', ai: false }

/** Each word of caption `id` and the words before the tidy it came from ("Flown ← flow in"), read through the record's map. */
function sources(p: Project, id = 'c0'): string[] {
  const seg = p.transcript!.segments.find((s) => s.id === id)!
  const r = p.captionAuto!.text!.find((x) => x.caption === id)!
  const lang = p.transcript!.language
  const now = studioWordTexts(seg.text, lang)
  const was = studioWordTexts(r.text, lang)
  const ranges = wordRanges(r.map, now.length, was.length)
  if (!ranges) throw new Error(`no valid map: ${JSON.stringify(r.map)} for “${seg.text}” ← “${r.text}”`)
  // The project reader keeps the map as written.
  expect(readCaptionAuto(JSON.parse(JSON.stringify(p.captionAuto)), p.transcript)).toEqual(p.captionAuto)
  return now.map((w, j) => `${w} ← ${was.slice(ranges[j][0], ranges[j][1] + 1).join(' ')}`)
}

const tidy = (texts: string[], opts: Partial<CleanupChoices> & { words?: WordListEntry[]; fix?: TextResult } = {}, language = 'en', segments?: CaptionSegment[]): Project => {
  const p = studioProject({ language, segments: segments ?? captions(texts) })
  return tidyCaptions(p, { ...DEFAULT_CLEANUP, ...opts, words: opts.words ?? [] }).project
}

describe('the word map of each tidy step', () => {
  it('the word list: terms with spaces, heard forms of several words, punctuation around them, one word to two', () => {
    const words = [
      { term: 'Google Docs', heard: ['google dogs'] },
      { term: 'Flown', heard: ['flow in'] },
      { term: 'VS Code', heard: ['vscode'] },
      { term: 'Visual Studio', heard: [] },
      { term: 'Q&A', heard: ['q and a'] }
    ]
    const p = tidy(['open "google dogs" and flow in, then vscode and visual studio for the q and a'], { words })
    expect(p.transcript!.segments[0].text).toBe('Open "Google Docs" and Flown, then VS Code and Visual Studio for the Q&A.')
    expect(sources(p)).toEqual([
      'Open ← open',
      '"Google ← "google dogs"',
      'Docs" ← "google dogs"',
      'and ← and',
      'Flown, ← flow in,',
      'then ← then',
      'VS ← vscode',
      'Code ← vscode',
      'and ← and',
      'Visual ← visual',
      'Studio ← studio',
      'for ← for',
      'the ← the',
      'Q&A. ← q and a'
    ])
  })

  it('a term the caption already had, or had in other capitals: each of its words from its own word, through two tidies too', () => {
    const words = [{ term: 'Visual Studio', heard: [] }, { term: 'Google Docs', heard: ['google dogs'] }]
    for (const text of ['we open Visual Studio and google docs', 'we open visual studio and Google Docs']) {
      const p = tidy([text], { ...OFF, caps: true, words })
      expect(p.transcript!.segments[0].text).toBe('We open Visual Studio and Google Docs')
      expect(sources(p)).toEqual(['We ← we', 'open ← open', `Visual ← ${text.split(' ')[2]}`, `Studio ← ${text.split(' ')[3]}`, 'and ← and', `Google ← ${text.split(' ')[5]}`, `Docs ← ${text.split(' ')[6]}`])
    }
    // Written by a first tidy and matched again by a second, which joins the comma written apart:
    // the term's words from the words the first replaced, the comma with the word before it only.
    const once = tidy(['open google dogs , then save'], { ...OFF, words })
    expect(once.transcript!.segments[0].text).toBe('open Google Docs , then save')
    const twice = tidyCaptions(once, { ...OFF, punct: true, caps: true, words }).project
    expect(twice.transcript!.segments[0].text).toBe('Open Google Docs, then save.')
    expect(sources(twice)).toEqual(['Open ← open', 'Google ← google dogs', 'Docs, ← google dogs ,', 'then ← then', 'save. ← save'])
  })

  it('numbers as digits, of every length: one word, two, many, hyphenated, millions', () => {
    const p = tidy(['we had seven then twelve then twenty five then two hundred and fifty', 'one thousand two hundred and thirty four or three million or twenty-five people'], { digits: 'all' })
    expect(p.transcript!.segments.map((s) => s.text)).toEqual(['We had 7 then 12 then 25 then 250', '1234 or 3000000 or 25 people.'])
    expect(sources(p, 'c0')).toEqual(['We ← we', 'had ← had', '7 ← seven', 'then ← then', '12 ← twelve', 'then ← then', '25 ← twenty five', 'then ← then', '250 ← two hundred and fifty'])
    expect(sources(p, 'c1')).toEqual(['1234 ← one thousand two hundred and thirty four', 'or ← or', '3000000 ← three million', 'or ← or', '25 ← twenty-five', 'people. ← people'])
    // Above ten: the small number stays a word, one for one.
    const above = tidy(['we had seven then twenty five'], { digits: 'above-ten' })
    expect(sources(above)).toEqual(['We ← we', 'had ← had', 'seven ← seven', 'then ← then', '25. ← twenty five'])
  })

  it('capitals and punctuation: one for one; punctuation written apart joins the word before it', () => {
    const p = tidy(['so i think. this works , right'])
    expect(p.transcript!.segments[0].text).toBe('So I think. This works, right.')
    expect(sources(p)).toEqual(['So ← so', 'I ← i', 'think. ← think.', 'This ← this', 'works, ← works ,', 'right. ← right'])
    // A clause mark at the end becomes the full stop.
    const stop = tidy(['and then we stop,'], { ...OFF, punct: true })
    expect(sources(stop)).toEqual(['and ← and', 'then ← then', 'we ← we', 'stop. ← stop,'])
  })

  it('repeated words: each word keeps its own', () => {
    const p = tidy(['open flow in in flow in today and and two hundred and and'], { digits: 'all', words: [{ term: 'Flown', heard: ['flow in'] }] })
    expect(sources(p)).toEqual(['Open ← open', 'Flown ← flow in', 'in ← in', 'Flown ← flow in', 'today ← today', 'and ← and', 'and ← and', '200 ← two hundred', 'and ← and', 'and. ← and'])
  })

  it('Bangla and Hindi numbers and full stops; Japanese words split without spaces, a full stop written apart joined', () => {
    expect(sources(tidy(['আমার দুই শো পঞ্চাশ টাকা আছে'], { digits: 'all' }, 'bn'))).toEqual(['আমার ← আমার', '২৫০ ← দুই শো পঞ্চাশ', 'টাকা ← টাকা', 'আছে। ← আছে'])
    expect(sources(tidy(['मेरे पास पच्चीस रुपये हैं'], { digits: 'all' }, 'hi'))).toEqual(['मेरे ← मेरे', 'पास ← पास', '25 ← पच्चीस', 'रुपये ← रुपये', 'हैं। ← हैं'])
    expect(sources(tidy(['今日はいい天気ですね 。'], {}, 'ja'))).toEqual(['今日 ← 今日', 'は ← は', 'いい ← いい', '天気 ← 天気', 'です ← です', 'ね。 ← ね 。'])
    // A term written as a whole: each of its words from all the words it replaced.
    const term = tidy(['東京タワーへようこそ みなさん'], { words: [{ term: '東京スカイツリー', heard: ['東京タワーへようこそ'] }] }, 'ja')
    expect(sources(term)).toEqual(['東京 ← 東京タワー へ ようこそ', 'スカイ ← 東京タワー へ ようこそ', 'ツリー ← 東京タワー へ ようこそ', 'みなさん。 ← みなさん'])
  })

  it('the AI fix: its words found in the text it was given, after the rules', () => {
    const p0 = studioProject({ segments: captions(['so um i think we can go with two hundred users', 'helo world']) })
    const ruled = tidyCaptions(p0, { ...DEFAULT_CLEANUP, words: [] }).project.transcript!.segments
    expect(ruled.map((s) => s.text)).toEqual(['So um I think we can go with 200 users', 'helo world.'])
    const fix = { task: 'cleanup' as const, segments: [{ ...ruled[0], text: "So I think we're going with 200 users" }, { ...ruled[1], text: 'Hello, world.' }] }
    const p = tidyCaptions(p0, { ...DEFAULT_CLEANUP, ai: true, fix, words: [] }).project
    expect(p.transcript!.segments.map((s) => s.text)).toEqual(["So I think we're going with 200 users", 'Hello, world.'])
    expect(sources(p, 'c0')).toEqual(['So ← so um', 'I ← i', 'think ← think', "we're ← we can go", 'going ← we can go', 'with ← with', '200 ← two hundred', 'users ← users'])
    expect(sources(p, 'c1')).toEqual(['Hello, ← helo', 'world. ← world'])
  })

  it('only the words changed (the AI fix gave the text back without them): one for one', () => {
    const seg: CaptionSegment = { id: 'c0', start: 0, end: 2, text: 'Fine words here.', words: [{ text: 'Fine', start: 0, end: 0.5 }, { text: 'words', start: 0.5, end: 1 }, { text: 'here.', start: 1, end: 2 }] }
    const fix = { task: 'cleanup' as const, segments: [{ id: 'c0', start: 0, end: 2, text: 'Fine words here.' }] }
    const p = tidy([], { ...OFF, ai: true, fix }, 'en', [seg])
    expect(p.transcript!.segments[0]).toEqual({ id: 'c0', start: 0, end: 2, text: 'Fine words here.' })
    expect(p.captionAuto?.text).toEqual([{ caption: 'c0', text: 'Fine words here.', words: seg.words, map: [[0, 2, 0, 2]] }])
  })
})

describe('two tidies in a row', () => {
  it('the first record stays; its map composed with the second tidy’s still maps onto the text before the first', () => {
    const p0 = studioProject({ segments: captions(['open google dogs with flow in two hundred times']) })
    const once = tidyCaptions(p0, { ...OFF, caps: true, words: [{ term: 'Google Docs', heard: ['google dogs'] }] }).project
    expect(once.transcript!.segments[0].text).toBe('Open Google Docs with flow in two hundred times')
    const twice = tidyCaptions(once, { ...OFF, punct: true, digits: 'all', words: [{ term: 'Flown', heard: ['flow in'] }] }).project
    expect(twice.transcript!.segments[0].text).toBe('Open Google Docs with Flown 200 times.')
    expect(twice.captionAuto!.text![0].text).toBe('open google dogs with flow in two hundred times')
    expect(sources(twice)).toEqual(['Open ← open', 'Google ← google dogs', 'Docs ← google dogs', 'with ← with', 'Flown ← flow in', '200 ← two hundred', 'times. ← times'])
    // A third tidy that changes nothing keeps the record as it is.
    expect(tidyCaptions(twice, { ...OFF, punct: true, digits: 'all', words: [] }).project).toBe(twice)
  })

  it('a record saved before maps were written stays without one; one with a map that no longer fits loses it, never the record', () => {
    const p0 = studioProject({ segments: captions(['open flow in now']) })
    const once = tidyCaptions(p0, { ...OFF, caps: true, words: [] }).project
    const old: Project = { ...once, captionAuto: { text: [{ caption: 'c0', text: 'open flow in now' }] } }
    const again = tidyCaptions(old, { ...OFF, words: [{ term: 'Flown', heard: ['flow in'] }] }).project
    expect(again.transcript!.segments[0].text).toBe('Open Flown now')
    expect(JSON.stringify(again.captionAuto)).toBe(JSON.stringify({ text: [{ caption: 'c0', text: 'open flow in now' }] }))
    const wrong: Project = { ...once, captionAuto: { text: [{ caption: 'c0', text: 'open flow in now', map: [[0, 2, 0, 2]] }] } }
    const fixed = tidyCaptions(wrong, { ...OFF, words: [{ term: 'Flown', heard: ['flow in'] }] }).project
    expect(JSON.stringify(fixed.captionAuto)).toBe(JSON.stringify({ text: [{ caption: 'c0', text: 'open flow in now' }] }))
  })
})
