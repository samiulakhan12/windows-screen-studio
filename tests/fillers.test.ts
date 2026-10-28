import { describe, expect, it } from 'vitest'
import { FILLER_PAUSE, fillerLanguage, findFillers, isFiller } from '../src/shared/editor/fillers'
import type { TranscriptWord } from '../src/shared/editor/transcript'

/** Words said 0.1 s apart unless a "|" before a word marks a pause of `pause` seconds. */
function say(text: string, pause = 0.5): TranscriptWord[] {
  const out: TranscriptWord[] = []
  let at = 0
  for (const raw of text.split(' ')) {
    const gap = raw.startsWith('|')
    const word = gap ? raw.slice(1) : raw
    if (gap) at += pause
    out.push({ index: out.length, caption: 'a', text: word, start: at, end: at + 0.3, estimated: false })
    at += 0.4
  }
  return out
}

const texts = (words: TranscriptWord[], spans: readonly (readonly [number, number])[]): string[] => spans.map(([a, b]) => words.slice(a, b + 1).map((w) => w.text).join(' '))

describe('fillers', () => {
  it('finds the English hesitation sounds, whatever their case and punctuation', () => {
    const w = say('So, Um, I think uh we should, er, go. Hmm.')
    expect(texts(w, findFillers(w, 'en'))).toEqual(['Um,', 'uh', 'er,', 'Hmm.'])
  })

  it('flags "like" and "you know" only when they stand apart', () => {
    const plain = say('I like it and you know it')
    expect(findFillers(plain, 'en')).toEqual([])
    const comma = say('it was, like, slow you know, really')
    expect(texts(comma, findFillers(comma, 'en'))).toEqual(['like,', 'you know,'])
    const paused = say('it was |like |slow')
    expect(texts(paused, findFillers(paused, 'en'))).toEqual(['like'])
  })

  it('uses FILLER_PAUSE as the pause that sets a context filler apart', () => {
    expect(texts(say('it was |like slow', FILLER_PAUSE), findFillers(say('it was |like slow', FILLER_PAUSE), 'en'))).toEqual(['like'])
    expect(findFillers(say('it was |like slow', FILLER_PAUSE - 0.15), 'en')).toEqual([])
  })

  it('finds "I mean" as two words', () => {
    const w = say('it is, I mean, fine')
    expect(findFillers(w, 'en')).toEqual([[2, 3]])
  })

  it('has a Bangla list', () => {
    const w = say('আমি উম আজকে, মানে, হুম যাব')
    expect(texts(w, findFillers(w, 'bn'))).toEqual(['উম', 'মানে,', 'হুম'])
    expect(fillerLanguage('bn-BD')).toBe('bn')
  })

  it('reads the language before the region, English when unknown, shared sounds for others', () => {
    expect(fillerLanguage(undefined)).toBe('en')
    expect(fillerLanguage('en-GB')).toBe('en')
    expect(fillerLanguage('ja')).toBe('other')
    const w = say('er um like')
    // "er" is a German word ("he"): only the shared sounds in other languages.
    expect(texts(w, findFillers(w, 'de'))).toEqual(['um'])
    expect(texts(w, findFillers(w, 'ja'))).toEqual(['um'])
    expect(isFiller('äh', 'de')).toBe(true)
    expect(isFiller('euh', 'fr')).toBe(true)
  })
})
