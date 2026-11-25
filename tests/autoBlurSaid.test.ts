import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_BLEEPS } from '../src/shared/captions/studioData'
import { isPrivateBleep, privateGroupOf, privateKindOf } from '../src/shared/privacy/coverData'
import { compileNames, NO_NAMES } from '../src/shared/privacy/detect/names'
import { detectSaid, digitRuns, saidBleeps, saidWord, transcriptWords, type SaidHit } from '../src/shared/privacy/detect/said'
import { SAID_KINDS } from '../src/shared/privacy/kinds'
import { maskPrivate, spokenForms, type SpokenForms } from '../src/shared/privacy/spoken'
import type { Bleep, Project, Transcript } from '../src/shared/types'
import { base } from './autoBlurFixtures'
import { ROOT, speechTranscript } from './autoBlurRulesFixtures'

/* Auto-blur P3: secrets said aloud (docs/design/auto-blur.md §7.2, §4.4, tests 129-133, 225 and 226). */

/** The hits of captions written as a speech vector, each with its own words. */
function said(words: string, opts: { names?: string[]; regions?: string[]; transcript?: Transcript } = {}): { kind: string; words: string; score: number; hit: SaidHit }[] {
  const tr = opts.transcript ?? speechTranscript(words)
  const flat = transcriptWords(tr)
  return detectSaid(tr, { kinds: SAID_KINDS, regions: opts.regions ?? ['US', 'BD'], names: opts.names ? compileNames(opts.names, []) : NO_NAMES }).map((h) => ({
    kind: h.kind,
    words: flat.slice(h.words[0], h.words[1] + 1).map((w) => w.text).join(' '),
    score: h.score,
    hit: h
  }))
}
const kinds = (words: string, opts?: Parameters<typeof said>[1]): string[] => said(words, opts).map((h) => `${h.kind}: ${h.words}`)
const sequence = (seed: number) => {
  let x = seed
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32
}

describe('auto-blur P3: secrets said aloud', () => {
  it('129. the digit stream across captions and full stops; a 2.0 s pause ends a run; and ends a run (the "400, 300 and 1500, 800" vector); finding 10’s card across sentences', () => {
    const runs = (w: string) => digitRuns(transcriptWords(speechTranscript(w))).map((r) => r.digits)
    // Captions and full stops do not end a run.
    expect(runs('the card is 4917 6123. || 4567 8904. thanks')).toEqual(['4917612345678904'])
    // A pause over 2.0 s ends one; a shorter one does not.
    expect(runs('four eight two <pause 2.1> nine one three')).toEqual(['482', '913'])
    expect(runs('four eight two <pause 1.5> nine one three')).toEqual(['482913'])
    // `and` ends a run: as a filler it made a Luhn-valid card of four quantities.
    expect(runs('content clicks at 400, 300 and 1500, 800')).toEqual(['400300', '1500800'])
    expect(kinds('content clicks at 400, 300 and 1500, 800')).toEqual([])
    // Fillers stay inside a run; any other word ends it.
    expect(runs('zero one seven um one two dash three four')).toEqual(['0171234'])
    expect(runs('seven two cats nine')).toEqual(['72', '9'])
    // Finding 10: digits, then number words, across sentences and captions, are one card.
    expect(kinds("it's 4917 6123 4567 eight nine zero four")).toEqual(['card: 4917 6123 4567 eight nine zero four'])
    expect(kinds('my card number is 4917 6123. || 4567 8904. Thanks')).toEqual(['card: 4917 6123. 4567 8904.'])
    // The hit's own words: the number only, never "is" or "thanks".
    const [h] = said('my card number is 4917 6123 || 4567 8904 thanks')
    expect(h.words).toBe('4917 6123 4567 8904')
  })

  it('130. spoken rules: cards with no label, codes, phones (the libphonenumber check), IDs, passwords, emails said aloud and as one token, names by double metaphone', () => {
    expect(kinds('four nine one seven six one two three four five six seven eight nine zero four')).toEqual(['card: four nine one seven six one two three four five six seven eight nine zero four'])
    expect(said('four nine one seven six one two three four five six seven eight nine zero four')[0].score).toBe(0.96)
    // A card with a card word but no network: still a card.
    expect(kinds('the card is 9999 1234 5678 9012')).toEqual(['card: 9999 1234 5678 9012'])
    // Codes need a code word, and are never a year.
    expect(kinds('your verification code || is 4 8 2 9 1 3')).toEqual(['code: 4 8 2 9 1 3'])
    expect(kinds('the code shipped in 2023 and 2024')).toEqual([])
    expect(kinds('four eight two nine one three')).toEqual([])
    // Phones: a phone word; valid for a region by libphonenumber is 0.92, otherwise 0.85; a Bangladeshi mobile needs no label.
    expect(said('call me on 213 373 4253', { regions: ['US'] })[0]).toMatchObject({ kind: 'phone', score: 0.92 })
    expect(said('my number is double five triple one two three four five')[0]).toMatchObject({ kind: 'phone', score: 0.85, words: 'double five triple one two three four five' })
    expect(said('zero one seven one two three four five six seven eight')[0]).toMatchObject({ kind: 'phone', score: 0.92 })
    expect(kinds('213 373 4253', { regions: ['US'] })).toEqual([])
    // IDs with an ID word.
    expect(kinds('my social security number is 123 45 6789')).toEqual(['id: 123 45 6789'])
    // Passwords: a password word then `is`, up to 6 words to a pause over 1 s or a sentence's end.
    expect(kinds('the password is hunter two exclamation. Then click save')).toEqual(['password: hunter two exclamation.'])
    expect(kinds('the password is blue <pause 1.5> sky and more')).toEqual(['password: blue'])
    expect(kinds('it skips password boxes in the form')).toEqual([])
    // Emails said aloud, and written as one token.
    expect(kinds('email me at jane dot doe at gmail dot com')).toEqual(['email: jane dot doe at gmail dot com'])
    expect(kinds('write to riad at the rate gmail dot com')).toEqual(['email: riad at the rate gmail dot com'])
    expect(kinds('send it to jsmith@gmail.com today')).toEqual(['email: jsmith@gmail.com'])
    expect(kinds('send it to billing@example.com today')).toEqual([])
    // Names by double metaphone: a misspelt name that sounds the same, each listed word in order.
    expect(kinds('thanks Steven Clark for joining', { names: ['Stephen Clarke'] })).toEqual(['name: Steven Clark'])
    expect(said('thanks Steven Clark', { names: ['Stephen Clarke'] })[0].score).toBe(0.8)
    expect(kinds('thanks Stephen for joining', { names: ['Stephen Clarke'] })).toEqual([])
    expect(kinds('thanks Simon Clarke for joining', { names: ['Stephen Clarke'] })).toEqual([])
    expect(said('ask Priya Raman', { names: ['Priya Raman'] })[0]).toMatchObject({ kind: 'name', score: 0.97 })
  })

  it('131. Bangla: NFC with য়, ড় and ঢ়; punctuation stripped without vowel signs; the Bangla digit words and English digits said in Bangla script', () => {
    // The caption writes য় as one code point (U+09DF); the word lists hold its NFC form, two code points.
    const precomposed = 'পাসও\u09dfার্ড হলো amar gopon nine'
    expect(precomposed.includes('য়')).toBe(true)
    expect(kinds(precomposed)).toEqual(['password: amar gopon nine'])
    // Punctuation is stripped, vowel signs and the nukta are kept: নয়, is nine, কোড: is the code word.
    expect(kinds('কোড: চার আট দুই নয়, এক তিন')).toEqual(['code: চার আট দুই নয়, এক তিন'])
    expect(digitRuns(transcriptWords(speechTranscript('চার আট দুই নয়, এক তিন'))).map((r) => r.digits)).toEqual(['482913'])
    // ড় and ঢ় written as one code point read as their NFC forms, as the word lists hold them.
    expect(saidWord('\u09dc\u09dd\u09df')).toBe('\u09a1\u09bc\u09a2\u09bc\u09af\u09bc')
    expect(saidWord('নয\u09bc,')).toBe(saidWord('ন\u09df'))
    // Bangla digits, and English digits said in Bangla script.
    expect(kinds('ওটিপি ৪৮২৯১৩')).toEqual(['code: ৪৮২৯১৩'])
    expect(kinds('আমার নম্বর জিরো ওয়ান সেভেন ওয়ান টু থ্রি ফোর ফাইভ সিক্স সেভেন এইট')).toEqual(['phone: জিরো ওয়ান সেভেন ওয়ান টু থ্রি ফোর ফাইভ সিক্স সেভেন এইট'])
    expect(kinds('আমার ইমেইল riad অ্যাট gmail ডট কম')).toEqual(['email: riad অ্যাট gmail ডট কম'])
  })

  it('132. saidBleeps: widening of 0.05 s and 0.15 s for estimated times, kind and group markers, no bleep inside an existing one', () => {
    const hit = (start: number, end: number, group: string, estimated = false, kind: SaidHit['kind'] = 'card'): SaidHit => ({ kind, score: 0.96, start, end, estimated, group, words: [0, 1] })
    const { bleeps, unplaced } = saidBleeps([hit(10, 12, 'd:4917'), hit(20, 21, 'w:jane', true, 'email')], [], sequence(5))
    expect(unplaced).toBe(0)
    expect(bleeps).toHaveLength(2)
    expect(bleeps[0]).toMatchObject({ start: 9.95, end: 12.05, sound: 'tone', auto: true })
    expect(bleeps[1]).toMatchObject({ start: 19.85, end: 21.15 })
    for (const b of bleeps) {
      expect(isPrivateBleep(b)).toBe(true)
      expect(b.word).toMatch(/^:(card|email):[a-z0-9]{10}$/)
      // The word holds the kind and the group, never the text.
      expect(b.word).not.toMatch(/4917|jane/)
    }
    expect(privateKindOf(bleeps[0])).toBe('card')
    expect(privateKindOf(bleeps[1])).toBe('email')
    // Inside an existing bleep: nothing added; overlapping one only partly: added.
    const existing: Bleep[] = [{ id: 'b-1', start: 9, end: 13, word: 'damn', sound: 'tone' }]
    expect(saidBleeps([hit(10, 12, 'd:4917')], existing, sequence(6)).bleeps).toEqual([])
    expect(saidBleeps([hit(12, 14, 'd:4917')], existing, sequence(6)).bleeps).toHaveLength(1)
    // Times never start before 0; ids are unique beside the existing ones.
    const early = saidBleeps([hit(0.01, 0.5, 'd:1'), hit(3, 4, 'd:2')], existing, sequence(7)).bleeps
    expect(early[0].start).toBe(0)
    expect(new Set([...early, ...existing].map((b) => b.id)).size).toBe(3)
  })

  it('133. speech false hits: Flown’s docs read as speech give at most 10 hits', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p, out)
        else if (e.name.endsWith('.md')) out.push(p)
      }
      return out
    }
    // The docs as the rules measured them (§7.2): docs/design/auto-blur.md is left out, as it quotes the spoken vectors.
    const paragraphs = walk(path.join(ROOT, 'docs'))
      .filter((f) => !f.endsWith(path.join('design', 'auto-blur.md')))
      .flatMap((f) => fs.readFileSync(f, 'utf8').split(/\n\s*\n/))
      .map((p) => p.replace(/[`*|#>_[\]()]/g, ' '))
    let words = 0
    let hits = 0
    for (const p of paragraphs) {
      const ws = p
        .split(/\s+/)
        .filter(Boolean)
        .map((w, i) => ({ text: w, start: i * 0.4, end: i * 0.4 + 0.35 }))
      if (!ws.length) continue
      words += ws.length
      hits += detectSaid({ segments: [{ id: 's', start: 0, end: ws[ws.length - 1].end, text: ws.map((w) => w.text).join(' '), words: ws }] }, { kinds: SAID_KINDS, regions: ['US', 'BD'], names: NO_NAMES }).length
    }
    expect(words).toBeGreaterThan(400_000)
    expect(hits).toBeLessThanOrEqual(10)
  }, 120_000)

  it('225. the bleep limit: with 1,999 ordinary bleeps and 5 said hits, saidBleeps keeps the total at 2,000 by merging private bleeps (across groups when needed, only growing them) and reports the hits it could not place', () => {
    const ordinary: Bleep[] = Array.from({ length: MAX_BLEEPS - 1 }, (_v, i) => ({ id: `b-${i}`, start: 100 + i, end: 100.3 + i, word: 'damn', sound: 'tone' }))
    const hit = (start: number, end: number, group: string): SaidHit => ({ kind: 'code', score: 0.9, start, end, estimated: false, group, words: [0, 0] })
    // Three hits close together (two of one said text, one of another) and two far apart.
    const hits = [hit(10, 10.5, 'd:111'), hit(10.9, 11.2, 'd:111'), hit(11.8, 12, 'd:222'), hit(40, 41, 'd:333'), hit(70, 71, 'd:444')]
    const { bleeps, unplaced } = saidBleeps(hits, ordinary, sequence(8))
    expect(ordinary.length + bleeps.length).toBe(MAX_BLEEPS)
    expect(bleeps).toHaveLength(1)
    // The merged bleep only grew: it holds the three close hits, and takes the earlier group.
    expect(bleeps[0].start).toBeLessThanOrEqual(9.95)
    expect(bleeps[0].end).toBeGreaterThanOrEqual(12.05)
    const groups = saidBleeps([hit(10, 10.5, 'd:111')], [], sequence(8)).bleeps
    expect(privateGroupOf(bleeps[0])).toBe(privateGroupOf(groups[0]))
    // The two it could not place are reported.
    expect(unplaced).toBe(2)
    // With room for all, nothing is merged.
    const roomy = saidBleeps(hits, ordinary.slice(0, 100), sequence(8))
    expect(roomy.bleeps).toHaveLength(5)
    expect(roomy.unplaced).toBe(0)
    // Merging stays within 1 s: neighbours further apart are never joined.
    const apart = saidBleeps([hit(10, 10.5, 'd:1'), hit(12, 12.5, 'd:1')], ordinary, sequence(9))
    expect(apart).toMatchObject({ unplaced: 1 })
    expect(apart.bleeps).toHaveLength(1)
  })

  it('226. said groups: two hits of the same said digit string share a group, a different one gets another; the group is in each bleep’s word', () => {
    const tr = speechTranscript('my card is 4917 6123 4567 8904 <pause 5> again 4917 6123 4567 8904 <pause 5> and the code is 4 8 2 9 1 3')
    const hits = detectSaid(tr, { kinds: SAID_KINDS, regions: ['US'], names: NO_NAMES })
    expect(hits.map((h) => h.kind)).toEqual(['card', 'card', 'code'])
    expect(hits[0].group).toBe(hits[1].group)
    expect(hits[2].group).not.toBe(hits[0].group)
    const { bleeps } = saidBleeps(hits, [], sequence(10))
    expect(bleeps).toHaveLength(3)
    const g = bleeps.map((b) => privateGroupOf(b))
    expect(g[0]).toBe(g[1])
    expect(g[2]).not.toBe(g[0])
    for (const b of bleeps) expect(b.word).toBe(`:${privateKindOf(b)}:${privateGroupOf(b)}`)
    // The same said words as one email give one group, written another way another.
    const em = detectSaid(speechTranscript('mail jane at gmail dot com <pause 5> or jane at gmail dot com'), { kinds: SAID_KINDS, regions: [], names: NO_NAMES })
    expect(em).toHaveLength(2)
    expect(em[0].group).toBe(em[1].group)
  })
})

/** The spoken forms of the private bleeps Find makes for `words` said (§7.3). */
function formsOf(words: string, regions = ['US', 'BD']): { project: Project; forms: SpokenForms | null } {
  const transcript = speechTranscript(words)
  const hits = detectSaid(transcript, { kinds: SAID_KINDS, regions, names: NO_NAMES })
  const project: Project = { ...base('said-forms', 120), transcript: { ...transcript, language: 'en' }, bleeps: saidBleeps(hits, [], sequence(11)).bleeps }
  return { project, forms: spokenForms(project) }
}

describe('auto-blur §7.2-7.3: runs across sentence ends, codes in pairs, and the digit forms of every run the rules find', () => {
  it('a number said before or after a number word across a sentence or clause end or a new caption is found with its own words and digits; finding 10 still holds (second review, finding [4])', () => {
    // A number word starting the next sentence, or the caption after, does not join the number.
    expect(kinds('Pay with 4917 6123 4567 8904. || One second, let me check.')).toEqual(['card: 4917 6123 4567 8904.'])
    expect(kinds('Pay with 4917 6123 4567 8904. One second, let me check.')).toEqual(['card: 4917 6123 4567 8904.'])
    expect(kinds('Pay with 4917 6123 4567 8904 || one more thing')).toEqual(['card: 4917 6123 4567 8904'])
    expect(kinds('My card number is 4917 6123 4567 8904. || One second.')).toEqual(['card: 4917 6123 4567 8904.'])
    expect(kinds('My card number is 4917 6123 4567 8904. || Twenty twenty-four was the year.')).toEqual(['card: 4917 6123 4567 8904.'])
    expect(kinds('My verification code is 482913. || Two more steps.')).toEqual(['code: 482913.'])
    expect(kinds('My verification code is 482913. || Oh wait, it expired.')).toEqual(['code: 482913.'])
    expect(kinds('The PIN is 4829. || One more thing.')).toEqual(['code: 4829.'])
    expect(kinds('the code is 4829, then two factor is on')).toEqual(['code: 4829,'])
    expect(kinds('your OTP is 4 8 2 9 1 3. || Ten seconds later')).toEqual(['code: 4 8 2 9 1 3.'])
    expect(kinds('Call me at 213 373 4253. || Two things after that.', { regions: ['US'] })).toEqual(['phone: 213 373 4253.'])
    // … or ending the sentence before it.
    expect(kinds('That was step two. || 4917 6123 4567 8904 is the card')).toEqual(['card: 4917 6123 4567 8904'])
    // Finding 10: a number a full stop or a new caption splits is found whole; one said in groups with commas too.
    expect(kinds('the card is 4917 6123. || 4567 8904.')).toEqual(['card: 4917 6123. 4567 8904.'])
    expect(kinds('the code is 4, 8, 2, 9')).toEqual(['code: 4, 8, 2, 9'])
    expect(kinds('the code is 4829, 1234')).toEqual(['code: 4829, 1234'])
    // Two numbers a sentence end parts are two.
    expect(kinds('the code is 4829. 1234.')).toEqual(['code: 4829.', 'code: 1234.'])
    // The spoken form is the number's own digits: its typed copies are masked.
    const card = formsOf('My card number is 4917 6123 4567 8904. || One second.').forms!
    expect(card.digits).toContain('4917612345678904')
    expect(maskPrivate('Billing 4917 6123 4567 8904', card)).toBe('Billing •••• •••• •••• ••••')
    expect(maskPrivate('Card 4917-6123-4567-8904', card)).toBe('Card ••••-••••-••••-••••')
    expect(maskPrivate('OTP 482913', formsOf('your OTP is 4 8 2 9 1 3. || Ten seconds later').forms)).toBe('OTP ••••••')
    // Nothing new is found in numbers that sentence ends part.
    for (const none of ['In step one. Two more steps.', 'Call me at five. Six thirty works too.', 'The code is in chapter twelve. Thirty four tests cover it.', 'I have two cats. Three dogs, four birds.']) expect(kinds(none), none).toEqual([])
  })

  it('codes and PINs said in two or three pairs are found; pairs that say a year, or that a sentence end parts, are not (second review, finding [16])', () => {
    expect(kinds('my PIN is forty eight twenty nine')).toEqual(['code: forty eight twenty nine'])
    expect(kinds('my PIN is forty-eight twenty-nine')).toEqual(['code: forty-eight twenty-nine'])
    expect(kinds('my PIN is 48 29')).toEqual(['code: 48 29'])
    expect(kinds('the verification code is twenty five forty eight ninety one')).toEqual(['code: twenty five forty eight ninety one'])
    expect(kinds('the verification code is 25 48 91')).toEqual(['code: 25 48 91'])
    expect(formsOf('my PIN is forty eight twenty nine').forms!.digits).toContain('4829')
    // A year said in pairs is never a code, nor are pairs without a code word.
    for (const none of ['the code shipped in twenty twenty-four', 'the code shipped in twenty twenty four and more', 'the code from nineteen ninety nine', 'we had forty eight twenty nine times', 'The code is in chapter twelve. Thirty four tests cover it.']) expect(kinds(none), none).toEqual([])
  })
})
