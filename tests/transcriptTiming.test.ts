import { describe, expect, it } from 'vitest'
import { mergeParts } from '../src/shared/captions/transcriptMerge'
import { normalizeSpeakerLabels, parseGeminiTranscription, parseOpenAiText } from '../src/shared/captions/transcriptParse'
import { activeIn, checkWordTimes, estimatedShare, isTextOnlyOpenAiModel, providerTiming, spreadWords, TEXT_PART_SECONDS, timeTextPart } from '../src/shared/captions/transcriptTiming'

describe('which models give word times', () => {
  it('treats every OpenAI model after whisper-1 as text only', () => {
    expect(isTextOnlyOpenAiModel('whisper-1')).toBe(false)
    expect(isTextOnlyOpenAiModel(' Whisper-large-v3')).toBe(false)
    expect(isTextOnlyOpenAiModel('gpt-transcribe')).toBe(true)
    expect(providerTiming('openai', 'gpt-transcribe')).toBe('text')
    expect(providerTiming('openai', 'whisper-1')).toBe('words')
    expect(providerTiming('gemini', 'gemini-3.8-flash')).toBe('words')
    expect(providerTiming('local', 'base')).toBe('words')
    expect(TEXT_PART_SECONDS).toBe(30)
  })
})

describe('activeIn', () => {
  it('clips ranges to a part and moves them to its clock', () => {
    expect(activeIn([{ start: 1, end: 3 }, { start: 9, end: 12 }, { start: 20, end: 21 }], 2, 10)).toEqual([
      { start: 0, end: 1 },
      { start: 7, end: 8 }
    ])
  })
})

describe('timeTextPart', () => {
  it('puts no word in a pause, by length, and marks every word estimated', () => {
    // Sound 1..3 and 6..8; "aaaa bb" said in the first stretch, "cccc dd" in the second.
    const segs = timeTextPart('aaaa bb cccc dd', [{ start: 1, end: 3 }, { start: 6, end: 8 }], 10)
    const words = segs.flatMap((s) => s.words!)
    expect(words.map((w) => w.text)).toEqual(['aaaa', 'bb', 'cccc', 'dd'])
    for (const w of words) {
      expect(w.estimated).toBe(true)
      const inside = (w.start >= 1 - 1e-9 && w.end <= 3 + 1e-9) || (w.start >= 6 - 1e-9 && w.end <= 8 + 1e-9)
      expect(inside).toBe(true)
    }
    // Weights 5, 3, 5, 3 over 4 s of sound: aaaa 1..2.25, bb 2.25..3, cccc 6..7.25.
    expect(words[0]).toMatchObject({ start: 1, end: 2.25 })
    expect(words[1]).toMatchObject({ start: 2.25, end: 3 })
    expect(words[2]).toMatchObject({ start: 6, end: 7.25 })
    // A 3 s pause starts a new caption.
    expect(segs.map((s) => s.text)).toEqual(['aaaa bb', 'cccc dd'])
    expect(segs[0]).toMatchObject({ start: 1, end: 3 })
  })

  it('moves a word across a pause to the side that holds most of it', () => {
    const ranges = [{ start: 0, end: 1 }, { start: 5, end: 6 }]
    const within = (w: { start: number; end: number }): boolean => (w.start >= 0 && w.end <= 1 + 1e-9) || (w.start >= 5 && w.end <= 6 + 1e-9)
    // Weights 2, 6 over 2 s: "yyyyy" has 0.5 s before the pause and 1 s after: it goes after.
    const after = timeTextPart('x yyyyy', ranges, 6).flatMap((s) => s.words!)
    expect(after[1]).toMatchObject({ start: 5, end: 6 })
    // Weights 6, 2 over 2 s: "xxxxx" has 1 s before and 0.5 s after: it stays before.
    const before = timeTextPart('xxxxx y', ranges, 6).flatMap((s) => s.words!)
    expect(before[0]).toMatchObject({ start: 0, end: 1 })
    for (const w of [...after, ...before]) expect(within(w)).toBe(true)
  })

  it('marks the words the sound placed fromSound, not an even spread over the whole part', () => {
    // A pause after the voice: the sound gave the words their place.
    const placed = timeTextPart('one two three', [{ start: 0.5, end: 2 }], 5).flatMap((s) => s.words!)
    expect(placed.map((w) => [w.estimated, w.fromSound])).toEqual([
      [true, true],
      [true, true],
      [true, true]
    ])
    // (Almost) no sound, or sound all through the part (steady music under the voice): spread evenly, a plain guess.
    for (const active of [[{ start: 3, end: 3.1 }], [{ start: 0, end: 5 }], [{ start: 0.1, end: 5 }]]) {
      const words = timeTextPart('one two three', active, 5).flatMap((s) => s.words!)
      expect(words.map((w) => [w.estimated, w.fromSound])).toEqual([
        [true, undefined],
        [true, undefined],
        [true, undefined]
      ])
    }
  })

  it('spreads over the whole part when it has (almost) no sound', () => {
    const words = timeTextPart('one two', [{ start: 3, end: 3.1 }], 4).flatMap((s) => s.words!)
    expect(words[0].start).toBe(0)
    expect(words[1].end).toBe(4)
  })

  it('splits captions at sentence ends (from 3 words), at 12 words and at 6 s', () => {
    // "Hi." and "Yes." are too short to end a caption alone.
    expect(timeTextPart('Hi. Yes. I think so.', [{ start: 0, end: 3 }], 3).map((s) => s.text)).toEqual(['Hi. Yes. I think so.'])
    const sentences = timeTextPart('One two three. Four five six.', [{ start: 0, end: 4 }], 4).map((s) => s.text)
    expect(sentences).toEqual(['One two three.', 'Four five six.'])
    const many = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
    const capped = timeTextPart(many, [{ start: 0, end: 5 }], 5)
    expect(capped.every((s) => s.words!.length <= 12)).toBe(true)
    const long = timeTextPart('a b c d e f g h', [{ start: 0, end: 20 }], 20)
    expect(long.every((s) => s.end - s.start <= 6 + 1e-9)).toBe(true)
    expect(long.length).toBeGreaterThan(1)
  })

  it('leaves out slivers of sound too short to hold a word', () => {
    const words = timeTextPart('one two', [{ start: 0, end: 0.05 }, { start: 2, end: 4 }], 5).flatMap((s) => s.words!)
    expect(words[0].start).toBe(2)
    expect(words.every((w) => w.end - w.start > 0.5)).toBe(true)
  })

  it('returns nothing for no text', () => {
    expect(timeTextPart('   ', [{ start: 0, end: 1 }], 1)).toEqual([])
    expect(timeTextPart('hi', [], 0)).toEqual([])
  })

  it('cuts Chinese, Japanese and Thai text into words: captions end at its sentences and follow its sound', () => {
    const inSound = (w: { start: number; end: number }, sound: { start: number; end: number }[]): boolean => sound.some((r) => w.start >= r.start - 1e-9 && w.end <= r.end + 1e-9)
    const ja = '今日はとても良い天気ですね。私たちは公園へ散歩に行きました。それからカフェで「おいしい」コーヒーを飲みました！'
    const sound = [[0.3, 4], [4.8, 9], [9.9, 14], [15, 20], [20.8, 25], [26, 29.5]].map(([start, end]) => ({ start, end }))
    const segs = timeTextPart(ja, sound, 30)
    expect(segs.length).toBeGreaterThan(3)
    // The text as said, with no space added; a sentence of 3 words or more ends its caption.
    expect(segs.map((s) => s.text).join('')).toBe(ja)
    expect(segs.some((s) => s.text.endsWith('天気ですね。'))).toBe(true)
    for (const s of segs) {
      expect(s.text).not.toMatch(/\s/u)
      expect(s.words!.map((w) => w.text).join('')).toBe(s.text)
      for (const w of s.words!) expect(inSound(w, sound)).toBe(true)
    }
    expect(segs.flatMap((s) => s.words!).map((w) => w.text)).toContain('「おいしい」')
    expect(segs[segs.length - 1].end).toBeGreaterThan(25)

    const zh = '今天天气很好。我们去公园散步吧。然后去喝咖啡。'
    const two = [{ start: 0, end: 10 }, { start: 11, end: 20 }]
    const zhSegs = timeTextPart(zh, two, 20)
    expect(zhSegs.map((s) => s.text).join('')).toBe(zh)
    expect(zhSegs[0].text).toBe('今天天气很好。')
    expect(zhSegs.some((s) => s.start >= 11)).toBe(true)
    expect(zhSegs[zhSegs.length - 1].end).toBe(20)

    const th = timeTextPart('สวัสดีครับวันนี้อากาศดีมาก', [{ start: 0, end: 3 }], 3)
    expect(th.flatMap((s) => s.words!).length).toBeGreaterThan(3)
    expect(th.map((s) => s.text).join('')).toBe('สวัสดีครับวันนี้อากาศดีมาก')
    // Spaces between words of a spaced language stay; text in those scripts keeps its own spaces.
    expect(timeTextPart('我用 iPhone 拍的。', [{ start: 0, end: 3 }], 3).map((s) => s.text)).toEqual(['我用 iPhone 拍的。'])
  })
})

describe('parseOpenAiText', () => {
  it('reads gpt-transcribe text and its detected language as one untimed segment', () => {
    expect(parseOpenAiText({ text: ' Hello\nthere ', languages: [{ code: 'en' }], usage: { type: 'duration', seconds: 3 } }, 12)).toEqual({
      language: 'en',
      segments: [{ start: 0, end: 12, text: 'Hello there' }],
      untimed: true
    })
    expect(parseOpenAiText({ text: '', languages: [] }, 5)).toEqual({ segments: [], untimed: true })
    expect(() => parseOpenAiText({ languages: [] }, 5)).toThrow(/not a transcript/)
  })

  it('keeps at most 2000 characters per 30 s of a part, so a looping answer cannot flood the captions', () => {
    const loop = 'Thank you. '.repeat(1000)
    expect(parseOpenAiText({ text: loop }, TEXT_PART_SECONDS).segments[0].text).toHaveLength(2000)
    expect(parseOpenAiText({ text: loop }, 4).segments[0].text).toHaveLength(2000)
    // A whisper-1 answer with text but no segments (a 600 s part) keeps ten minutes of speech.
    const talk = 'and then we open the settings '.repeat(300).trim()
    expect(parseOpenAiText({ text: talk }, 600).segments[0].text).toBe(talk)
  })
})

describe('checkWordTimes', () => {
  const seg = (words: { text: string; start: number; end: number }[], text = words.map((w) => w.text).join(' ')) => ({ start: 0, end: 4, text, words })
  it('keeps plausible word times', () => {
    const ok = seg([{ text: 'a', start: 0, end: 1 }, { text: 'b', start: 1, end: 2 }, { text: 'c', start: 2, end: 3.5 }])
    expect(checkWordTimes(ok)).toBe(ok)
    expect(checkWordTimes({ start: 0, end: 1, text: 'x' })).toEqual({ start: 0, end: 1, text: 'x' })
  })
  it('replaces words out of order, without length, bunched up or too few', () => {
    const cases = [
      seg([{ text: 'a', start: 2, end: 3 }, { text: 'b', start: 0.5, end: 1 }]),
      seg([{ text: 'a', start: 0, end: 0 }, { text: 'b', start: 1, end: 1 }, { text: 'c', start: 2, end: 3 }]),
      seg([{ text: 'a', start: 0, end: 0.2 }, { text: 'b', start: 0.2, end: 0.4 }]),
      seg([{ text: 'a', start: 0, end: 4 }], 'a b c')
    ]
    for (const c of cases) {
      const out = checkWordTimes(c)
      expect(out.words!.every((w) => w.estimated && !w.fromSound)).toBe(true)
      expect(out.words!.map((w) => w.text)).toEqual(c.text.split(' '))
      expect(out.words![0].start).toBe(0)
      expect(out.words![out.words!.length - 1].end).toBe(4)
    }
  })
})

describe('spreadWords and estimatedShare', () => {
  it('spreads by length and counts estimated words', () => {
    expect(spreadWords(['a', 'bbb'], 0, 6)).toEqual([
      { text: 'a', start: 0, end: 2, estimated: true },
      { text: 'bbb', start: 2, end: 6, estimated: true }
    ])
    expect(estimatedShare([{ words: [{ estimated: true }, {}] }, {}])).toBe(0.5)
    expect(estimatedShare([])).toBe(0)
  })
})

describe('Gemini speakers', () => {
  it('asks for and reads speaker labels, normalised to "Speaker N" per part', () => {
    const answer = JSON.stringify({
      segments: [
        { start: 0, end: 1, text: 'Hi', speaker: 'Host' },
        { start: 1, end: 2, text: 'Hello', speaker: 'Speaker 2' },
        { start: 2, end: 3, text: 'So', speaker: 'host' },
        { start: 3, end: 4, text: 'Yes' }
      ]
    })
    expect(parseGeminiTranscription(answer, 5).segments.map((s) => s.speaker)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1', undefined])
    expect(normalizeSpeakerLabels([{ start: 0, end: 1, text: 'a', speaker: 'Speaker 21' }])[0].speaker).toBe('Speaker 1')
  })

  it('replaces implausible Gemini word times by estimates', () => {
    const answer = JSON.stringify({ segments: [{ start: 0, end: 4, text: 'a b', words: [{ text: 'a', start: 3, end: 3 }, { text: 'b', start: 1, end: 1 }] }] })
    expect(parseGeminiTranscription(answer, 5).segments[0].words!.every((w) => w.estimated)).toBe(true)
  })

  it('checks the order of Gemini word times as sent, before sorting them', () => {
    const words = [{ text: 'Hello', start: 2, end: 2.4 }, { text: 'there', start: 0, end: 0.4 }, { text: 'my', start: 1.2, end: 1.5 }, { text: 'friend', start: 0.5, end: 1 }]
    const out = parseGeminiTranscription(JSON.stringify({ segments: [{ start: 0, end: 2.5, text: 'Hello there my friend', words }] }), 5).segments[0].words!
    expect(out.map((w) => w.text)).toEqual(['Hello', 'there', 'my', 'friend'])
    expect(out.every((w) => w.estimated)).toBe(true)
    // In order but a hair apart (within 0.05 s): kept as timed, sorted by start.
    const close = [{ text: 'a', start: 0.52, end: 1 }, { text: 'b', start: 0.5, end: 0.9 }, { text: 'c', start: 1, end: 2 }]
    const kept = parseGeminiTranscription(JSON.stringify({ segments: [{ start: 0, end: 2, text: 'a b c', words: close }] }), 5).segments[0].words!
    expect(kept.map((w) => [w.text, w.start, w.estimated])).toEqual([['b', 0.5, undefined], ['a', 0.52, undefined], ['c', 1, undefined]])
  })
})

describe('mergeParts', () => {
  it('carries estimated words and speakers into the transcript', () => {
    const part = { index: 0, start: 10, end: 20, keepStart: 10, keepEnd: 20 }
    const merged = mergeParts(
      [{ part, transcript: { segments: [{ start: 1, end: 2, text: 'a b', speaker: 'Speaker 1', words: [{ text: 'a', start: 1, end: 1.5, estimated: true }, { text: 'b', start: 1.5, end: 2, estimated: true }] }, { start: 3, end: 4, text: 'c', speaker: 'Speaker 2' }] } }],
      30
    )
    expect(merged.segments).toEqual([
      { id: 't1', start: 11, end: 12, text: 'a b', speaker: 'Speaker 1', words: [{ text: 'a', start: 11, end: 11.5, estimated: true }, { text: 'b', start: 11.5, end: 12, estimated: true }] },
      { id: 't2', start: 13, end: 14, text: 'c', speaker: 'Speaker 2' }
    ])
  })

  it('carries the mark of words the sound placed', () => {
    const part = { index: 0, start: 10, end: 20, keepStart: 10, keepEnd: 20 }
    const merged = mergeParts([{ part, transcript: { segments: timeTextPart('a b', [{ start: 1, end: 2 }], 10) } }], 30)
    expect(merged.segments[0].words).toEqual([
      { text: 'a', start: 11, end: 11.5, estimated: true, fromSound: true },
      { text: 'b', start: 11.5, end: 12, estimated: true, fromSound: true }
    ])
  })
})
