import { describe, expect, it } from 'vitest'
import { languageCode, parseGeminiTranscription, parseOpenAiTranscription } from '../src/shared/captions/transcriptParse'

/** Shaped like the documented verbose_json response (TranscriptionVerbose) with segment and word timestamps. */
const OPENAI_VERBOSE = {
  task: 'transcribe',
  language: 'english',
  duration: 8.47,
  text: 'The beach was a popular spot on a hot summer day. People were swimming in the ocean.',
  segments: [
    {
      id: 0, seek: 0, start: 0.0, end: 3.32, text: ' The beach was a popular spot on a hot summer day.',
      tokens: [50364, 440, 7534], temperature: 0.0, avg_logprob: -0.286, compression_ratio: 1.236, no_speech_prob: 0.0098
    },
    {
      id: 1, seek: 0, start: 3.32, end: 6.12, text: ' People were swimming in the ocean.',
      tokens: [50530, 3432], temperature: 0.0, avg_logprob: -0.286, compression_ratio: 1.236, no_speech_prob: 0.0098
    }
  ],
  words: [
    { word: 'The', start: 0.0, end: 0.24 }, { word: 'beach', start: 0.24, end: 0.6 }, { word: 'was', start: 0.6, end: 0.8 },
    { word: 'a', start: 0.8, end: 0.9 }, { word: 'popular', start: 0.9, end: 1.3 }, { word: 'spot', start: 1.3, end: 1.6 },
    { word: 'on', start: 1.6, end: 1.8 }, { word: 'a', start: 1.8, end: 1.9 }, { word: 'hot', start: 1.9, end: 2.2 },
    { word: 'summer', start: 2.2, end: 2.6 }, { word: 'day', start: 2.6, end: 3.1 },
    { word: 'People', start: 3.4, end: 3.8 }, { word: 'were', start: 3.8, end: 4.0 }, { word: 'swimming', start: 4.0, end: 4.6 },
    { word: 'in', start: 4.6, end: 4.8 }, { word: 'the', start: 4.8, end: 4.9 }, { word: 'ocean', start: 4.9, end: 5.6 }
  ],
  usage: { type: 'duration', seconds: 9 }
}

describe('parseOpenAiTranscription', () => {
  it('reads segments and hands each word to its segment', () => {
    const t = parseOpenAiTranscription(OPENAI_VERBOSE, 8.47)
    expect(t.language).toBe('en')
    expect(t.segments.map((s) => [s.start, s.end, s.text])).toEqual([
      [0, 3.32, 'The beach was a popular spot on a hot summer day.'],
      [3.32, 6.12, 'People were swimming in the ocean.']
    ])
    expect(t.segments[0].words?.map((w) => w.text).join(' ')).toBe('The beach was a popular spot on a hot summer day')
    expect(t.segments[1].words?.[0]).toEqual({ text: 'People', start: 3.4, end: 3.8 })
  })

  it('drops malformed segments and words, and clamps times to the part', () => {
    const t = parseOpenAiTranscription(
      {
        segments: [
          { start: 0, end: 1, text: '   ' },
          { start: 'x', end: 1, text: 'bad time' },
          { start: 2, end: 1, text: 'backwards' },
          { start: -1, end: 99, text: 'ok' },
          null
        ],
        words: [{ word: 'ok', start: 1, end: 2 }, { word: 5, start: 0, end: 1 }]
      },
      10
    )
    expect(t.segments).toEqual([{ start: 0, end: 11, text: 'ok', words: [{ text: 'ok', start: 1, end: 2 }] }])
    expect(t.language).toBeUndefined()
  })

  it('says to use whisper-1 when a model returns text without timings', () => {
    expect(() => parseOpenAiTranscription({ text: 'Hello there' }, 5)).toThrow(/whisper-1/)
    expect(parseOpenAiTranscription({ text: '' }, 5).segments).toEqual([])
    expect(() => parseOpenAiTranscription('nope', 5)).toThrow(/not a transcript/)
  })
})

describe('parseGeminiTranscription', () => {
  it('reads the JSON answer with optional words', () => {
    const answer = JSON.stringify({
      language: 'en',
      segments: [
        { start: 4.2, end: 6.0, text: 'Second.' },
        { start: 0.5, end: 2.25, text: 'First  sentence.', words: [{ text: 'First', start: 0.5, end: 1 }, { text: 'sentence.', start: 1, end: 2.25 }, { text: 'far', start: 30, end: 31 }] }
      ]
    })
    const t = parseGeminiTranscription(answer, 10)
    expect(t.language).toBe('en')
    expect(t.segments).toEqual([
      { start: 0.5, end: 2.25, text: 'First sentence.', words: [{ text: 'First', start: 0.5, end: 1 }, { text: 'sentence.', start: 1, end: 2.25 }] },
      { start: 4.2, end: 6, text: 'Second.' }
    ])
  })

  it('rejects answers that are not a transcript', () => {
    expect(() => parseGeminiTranscription('not json', 10)).toThrow(/not a transcript/)
    expect(() => parseGeminiTranscription('{"text":"hi"}', 10)).toThrow(/not a transcript/)
    expect(parseGeminiTranscription('{"segments":[]}', 10).segments).toEqual([])
  })
})

describe('languageCode', () => {
  it('normalises codes and maps Whisper language names', () => {
    expect(languageCode('EN')).toBe('en')
    expect(languageCode('pt-BR')).toBe('pt-BR')
    expect(languageCode('Bengali')).toBe('bn')
    expect(languageCode('klingon')).toBeUndefined()
    expect(languageCode(3)).toBeUndefined()
  })
})
