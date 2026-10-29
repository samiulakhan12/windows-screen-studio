import { describe, expect, it } from 'vitest'
import { cutRange, outputDuration } from '../src/shared/engine/timeline'
import { cutFlags, cutWords, transcriptWords, type TranscriptWord } from '../src/shared/editor/transcript'
import { applySuggestions, refreshSuggestions, reviewSuggestions } from '../src/shared/editor/transcriptReview'
import type { CaptionSegment, Clip, Transcript } from '../src/shared/types'

/** Words 0.1 s apart; "|" before a word is a 1 s pause. */
function say(text: string): TranscriptWord[] {
  const out: TranscriptWord[] = []
  let at = 1
  for (let raw of text.split(' ')) {
    if (raw.startsWith('|')) {
      at += 1
      raw = raw.slice(1)
    }
    out.push({ index: out.length, caption: 'a', text: raw, start: at, end: at + 0.3, estimated: false })
    at += 0.4
  }
  return out
}

const full = (d: number): Clip[] => [{ id: 'c', start: 0, end: d, speed: 1 }]
const quote = (w: TranscriptWord[], s: { first: number; last: number }): string => w.slice(s.first, s.last + 1).map((x) => x.text).join(' ')

describe('the review list', () => {
  const words = say('So um the first thing |So the first thing you do, uh, is open settings. Then, like, you know, click it it.')
  const d = 20

  it('lists fillers, retakes and repeats in order, with what each saves', () => {
    const items = reviewSuggestions(words, full(d), d, 'en')
    expect(items.map((s) => `${s.kind}: ${quote(words, s)}`)).toEqual(['retake: So um the first thing', 'filler: uh,', 'filler: like,', 'filler: you know,', 'repeat: it'])
    expect(items.every((s) => s.saved > 0)).toBe(true)
    // The "um" inside the retake is not listed on its own.
    expect(items.some((s) => s.kind === 'filler' && quote(words, s) === 'um')).toBe(false)
  })

  it('leaves out what is already cut', () => {
    const uh = words.findIndex((w) => w.text === 'uh,')
    const clips = cutWords(full(d), words, [[uh, uh]], d)
    const items = reviewSuggestions(words, clips, d, 'en')
    expect(items.some((s) => s.first === uh)).toBe(false)
    expect(refreshSuggestions(reviewSuggestions(words, full(d), d, 'en'), words, clips, d).some((s) => s.first === uh)).toBe(false)
  })

  it('removes them all as one change of the clips, and says what that saved', () => {
    const items = reviewSuggestions(words, full(d), d, 'en')
    const r = applySuggestions(full(d), words, items, d)
    expect(r.saved).toBeCloseTo(d - outputDuration(r.clips))
    const flags = cutFlags(words, r.clips)
    for (const s of items) for (let i = s.first; i <= s.last; i++) expect(flags[i]).toBe(true)
    // The words kept are not cut.
    expect(flags[words.findIndex((w) => w.text === 'settings.')]).toBe(false)
    expect(reviewSuggestions(words, r.clips, d, 'en')).toEqual([])
  })

  it('finds nothing in clean speech', () => {
    expect(reviewSuggestions(say('This is a clean sentence. And another one here.'), full(20), 20, 'en')).toEqual([])
  })
})

describe('retakes and repeats whose later take is cut', () => {
  const d = 30
  const rows = (w: TranscriptWord[], items: { kind: string; first: number; last: number }[]): string[] => items.map((s) => `${s.kind}: ${quote(w, s)}`)
  /** The clips with the words from `from` up to the next `count` cut. */
  const cutOut = (w: TranscriptWord[], from: number, count: number): Clip[] => cutWords(full(d), w, [[from, from + count - 1]], d)

  it('leaves out a retake when the take it keeps is cut, before or after Find', () => {
    const w = say('Today we will look at the export dialog. |Today we are going to look at the export dialog. |It has three tabs.')
    const found = reviewSuggestions(w, full(d), d, 'en')
    expect(rows(w, found)).toEqual(['retake: Today we will look at the export dialog.'])
    // The user keeps the first take and cuts the second.
    const second = w.findIndex((x, i) => i > 0 && x.text === 'Today')
    const clips = cutOut(w, second, 10)
    expect(cutFlags(w, clips).slice(0, second).some(Boolean)).toBe(false)
    expect(reviewSuggestions(w, clips, d, 'en')).toEqual([])
    expect(refreshSuggestions(found, w, clips, d)).toEqual([])
  })

  it('leaves out a repeat when the word it keeps is cut', () => {
    const w = say('open the the menu now.')
    const found = reviewSuggestions(w, full(d), d, 'en')
    expect(rows(w, found)).toEqual(['repeat: the'])
    const clips = cutOut(w, 2, 1)
    expect(reviewSuggestions(w, clips, d, 'en')).toEqual([])
    expect(refreshSuggestions(found, w, clips, d)).toEqual([])
  })

  it('takes a later take as cut when its first word\'s middle is (a guess the tab may still show kept), or when the tab shows it cut', () => {
    // Captions without word timings: every time a guess.
    const untimed = (segments: CaptionSegment[]): TranscriptWord[] => transcriptWords({ provider: 'gemini', model: '', createdAt: '', segments } as unknown as Transcript)
    const w = untimed([
      { id: 'a', start: 10, end: 12, text: 'So the first thing you do.' },
      { id: 'b', start: 12.5, end: 17, text: 'So the first thing you do is open the settings.' }
    ])
    const found = reviewSuggestions(w, full(d), d, 'en')
    expect(rows(w, found)).toEqual(['retake: So the first thing you do.'])
    // The later take cut on the timeline: its guesses still show kept (the rest of its caption plays), but removing the first would lose both.
    const clips = cutRange(full(d), 12.45, 14.45)
    expect(cutFlags(w, clips).some(Boolean)).toBe(false)
    expect(reviewSuggestions(w, clips, d, 'en')).toEqual([])
    expect(refreshSuggestions(found, w, clips, d)).toEqual([])
    // A repeat whose second "the" is cut so.
    const r = untimed([{ id: 'r', start: 10, end: 14, text: 'Open the the settings menu now please' }])
    const repeats = reviewSuggestions(r, full(d), d, 'en')
    expect(rows(r, repeats)).toEqual(['repeat: the'])
    const cut = cutRange(full(d), r[2].start - 0.05, r[2].end + 0.05)
    expect(cutFlags(r, cut).some(Boolean)).toBe(false)
    expect(reviewSuggestions(r, cut, d, 'en')).toEqual([])
    expect(refreshSuggestions(repeats, r, cut, d)).toEqual([])
    // Heard times: a later take whose caption keeps only 0.04 s, around its first word's middle, is struck through whole.
    const h = say('Today we will look at the export dialog. |Today we are going to look at the export dialog.').map((x, i) => ({ ...x, caption: i < 8 ? 'a' : 'b' }))
    const mid = (h[8].start + h[8].end) / 2
    const sliver = [{ id: 'a', start: 0, end: h[7].end + 0.5, speed: 1 }, { id: 'b', start: mid - 0.02, end: mid + 0.02, speed: 1 }]
    expect(cutFlags(h, sliver).slice(8).every(Boolean)).toBe(true)
    expect(reviewSuggestions(h, sliver, d, 'en')).toEqual([])
  })

  it('keeps a retake listed while a later take than the next one is kept (three takes)', () => {
    const w = say('Click the big button. |Click the big blue button. |Click the big blue button now.')
    const found = reviewSuggestions(w, full(d), d, 'en')
    expect(rows(w, found)).toEqual(['retake: Click the big button.', 'retake: Click the big blue button.'])
    // The middle take removed on its own: the first is still a retake of the last.
    const middle = applySuggestions(full(d), w, [found[1]], d).clips
    expect(rows(w, refreshSuggestions(found, w, middle, d))).toEqual(['retake: Click the big button.'])
    expect(rows(w, reviewSuggestions(w, middle, d, 'en'))).toEqual(['retake: Click the big button.'])
    // The last take cut instead: the first is a retake of the middle one, the middle one no longer is.
    const last = cutOut(w, 9, 6)
    expect(rows(w, refreshSuggestions(found, w, last, d))).toEqual(['retake: Click the big button.'])
  })
})
