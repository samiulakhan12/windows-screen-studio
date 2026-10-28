import { describe, expect, it } from 'vitest'
import { outputDuration } from '../src/shared/engine/timeline'
import { cutFlags, cutWords, type TranscriptWord } from '../src/shared/editor/transcript'
import { applySuggestions, refreshSuggestions, reviewSuggestions } from '../src/shared/editor/transcriptReview'
import type { Clip } from '../src/shared/types'

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
