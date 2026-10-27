import { describe, expect, it } from 'vitest'
import { CAPTION_LIMITS, captionPieces, chunkArgs, localTranscript, MAX_CHUNK_RANGE, modelArgs, readSidecarLine, SIDECAR, type SidecarSegment } from '../src/shared/speech/protocol'

const line = (o: unknown): string => JSON.stringify(o)
const timing = { load_ms: 80, vad_ms: 20, asr_ms: 900, rtf: 0.05, peak_rss_mb: 300 }

describe('readSidecarLine', () => {
  it('reads every type the helper prints', () => {
    expect(readSidecarLine(line({ type: 'cpu', sse42: true, avx: true, avx2: true, fma: true, f16c: true, bmi2: false, logical: 8 }))).toEqual({
      type: 'cpu', sse42: true, avx: true, avx2: true, fma: true, f16c: true, bmi2: false, logical: 8
    })
    expect(readSidecarLine(line({ type: 'vad', audio_s: 10.5, frame: 0.032, n: 3, probs: 'AAAA', detect_ms: 12 }))?.type).toBe('vad')
    expect(readSidecarLine(line({ type: 'ready', model: 'base', multilingual: true, dtw: 'BASE', build: 'host', system: 'AVX2 = 1' }))?.type).toBe('ready')
    expect(readSidecarLine(line({ type: 'speech', segments: [[0.5, 2], [3, 4.25]] }))).toEqual({ type: 'speech', segments: [[0.5, 2], [3, 4.25]] })
    expect(readSidecarLine(line({ type: 'progress', percent: 42, at: 12.5 }))).toEqual({ type: 'progress', percent: 42, at: 12.5 })
    expect(readSidecarLine(line({ type: 'segment', start: 1, end: 2, text: ' Hi there.', words: [{ text: 'Hi', start: 1, end: 1.4, prob: 0.9 }, { text: 'there.', start: 1.4, end: 2, prob: 0.8 }] }))).toMatchObject({
      type: 'segment', words: [{ text: 'Hi' }, { text: 'there.' }]
    })
    expect(readSidecarLine(line({ type: 'result', language: 'en', language_s: 11.2, duration: 30, timing }))).toEqual({ type: 'result', language: 'en', language_s: 11.2, duration: 30, timing })
    expect(readSidecarLine(line({ type: 'cancelled', done_until: 12 }))).toEqual({ type: 'cancelled', done_until: 12 })
    expect(readSidecarLine(line({ type: 'error', code: 'memory', message: 'out of memory' }))).toEqual({ type: 'error', code: 'memory', message: 'out of memory' })
  })

  it('rejects NaN, Infinity, wrong types, unknown types and over-long lines', () => {
    expect(readSidecarLine('{"type":"progress","percent":NaN,"at":1}')).toBeNull()
    expect(readSidecarLine('{"type":"progress","percent":Infinity,"at":1}')).toBeNull()
    expect(readSidecarLine(line({ type: 'progress', percent: '5', at: 1 }))).toBeNull()
    expect(readSidecarLine(line({ type: 'cpu', sse42: 1, avx: true, avx2: true, fma: true, f16c: true, bmi2: true, logical: 4 }))).toBeNull()
    expect(readSidecarLine(line({ type: 'error', code: 'nope', message: 'x' }))).toBeNull()
    expect(readSidecarLine(line({ type: 'mystery' }))).toBeNull()
    expect(readSidecarLine('not json')).toBeNull()
    expect(readSidecarLine('[1,2]')).toBeNull()
    expect(readSidecarLine(line({ type: 'speech', segments: [[2, 1]] }))).toBeNull()
    const long = line({ type: 'segment', start: 0, end: 1, text: 'x'.repeat(SIDECAR.lineMax), words: [] })
    expect(readSidecarLine(long)).toBeNull()
  })

  it('drops words with reversed times, keeping the segment', () => {
    const e = readSidecarLine(line({ type: 'segment', start: 0, end: 2, text: 'a b', words: [{ text: 'a', start: 1, end: 0.5, prob: 1 }, { text: 'b', start: 1, end: 2, prob: 1 }] }))
    expect(e?.type === 'segment' && e.words.map((w) => w.text)).toEqual(['b'])
  })

  it('requires language_s on a result', () => {
    expect(readSidecarLine(line({ type: 'result', language: 'en', duration: 30, timing }))).toBeNull()
    expect(readSidecarLine(line({ type: 'result', language: 'en', language_s: 3, duration: 30, timing: { ...timing, rtf: 'x' } }))).toBeNull()
  })
})

const seg = (start: number, end: number, words: [string, number, number][], text = ''): SidecarSegment => ({
  type: 'segment', start, end, text, words: words.map(([t, s, e]) => ({ text: t, start: s, end: e, prob: 0.9 }))
})

describe('localTranscript', () => {
  it('rebuilds text from the words, keeping punctuation', () => {
    const t = localTranscript([seg(0, 3, [['Ask', 0.5, 0.8], ['not,', 0.8, 1.2], [' what ', 1.3, 1.6]], 'ignored text')], 'en', 10)
    expect(t).toEqual({ language: 'en', segments: [{ start: 0.5, end: 1.6, text: 'Ask not, what', words: [{ text: 'Ask', start: 0.5, end: 0.8 }, { text: 'not,', start: 0.8, end: 1.2 }, { text: 'what', start: 1.3, end: 1.6 }] }] })
  })

  it('clamps times to the part, keeps them monotonic and drops empty words', () => {
    const t = localTranscript([seg(9, 12, [['late', 9.5, 11], ['', 10, 10.5]]), seg(0, 2, [['a', -1, 0.5], ['b', 0.4, 0.3]])], undefined, 10)
    expect(t.segments.map((s) => s.words)).toEqual([
      [{ text: 'a', start: 0, end: 0.5 }, { text: 'b', start: 0.5, end: 0.5 }],
      [{ text: 'late', start: 9.5, end: 10 }]
    ])
    expect(t.language).toBeUndefined()
  })

  it('keeps at most 400 words per segment', () => {
    const words: [string, number, number][] = Array.from({ length: 450 }, (_, i) => [`w${i}`, i * 0.01, i * 0.01 + 0.005])
    expect(localTranscript([seg(0, 5, words)], 'en', 10).segments[0].words).toHaveLength(400)
  })

  it('passes the language through languageCode and leaves out "" and auto', () => {
    expect(localTranscript([], 'EN', 1).language).toBe('en')
    expect(localTranscript([], 'english', 1).language).toBe('en')
    expect(localTranscript([], '', 1)).toEqual({ segments: [] })
    expect(localTranscript([], 'auto', 1)).toEqual({ segments: [] })
  })
})

describe('captions cut from chunk-long segments (the Bangla model, docs/design/offline-captions.md §14.1)', () => {
  /**
   * One 20 s chunk as the Bangla model writes it: a single segment of 30 words, 0.5 s each with
   * 0.15 s between them, and longer pauses after words 8 (0.9 s), 17 (1.2 s) and 23 (0.6 s).
   */
  function chunk(offset = 0): SidecarSegment {
    const words: [string, number, number][] = []
    let t = offset + 0.4
    for (let i = 0; i < 30; i++) {
      words.push([`শব্দ${i}`, t, t + 0.5])
      t += 0.5 + (i === 8 ? 0.9 : i === 17 ? 1.2 : i === 23 ? 0.6 : 0.15)
    }
    return seg(offset, offset + 20, words)
  }

  it('cuts a 20 s segment at its longest pauses into captions of at most 7 s and 14 words, words, text and times in step', () => {
    const one = chunk()
    expect(one.words[29].end - one.words[0].start).toBeGreaterThan(19)
    const t = localTranscript([one], 'bn', 30, { split: true })
    // The 1.2 s pause first, then the 0.9 s and 0.6 s ones: four captions of 9, 9, 6 and 6 words.
    expect(t.segments.map((s) => s.words!.length)).toEqual([9, 9, 6, 6])
    for (const s of t.segments) {
      expect(s.end - s.start).toBeLessThanOrEqual(CAPTION_LIMITS.seconds)
      expect(s.words!.length).toBeLessThanOrEqual(CAPTION_LIMITS.words)
      expect(s.text).toBe(s.words!.map((w) => w.text).join(' '))
      expect([s.start, s.end]).toEqual([s.words![0].start, s.words![s.words!.length - 1].end])
    }
    expect(t.segments.flatMap((s) => s.words!.map((w) => w.text))).toEqual(one.words.map((w) => w.text))
    // Cut again, nothing changes (a part cached after the cut reads back the same).
    const again = localTranscript(t.segments.map((s) => ({ type: 'segment' as const, ...s, words: s.words!.map((w) => ({ ...w, prob: 1 })) })), 'bn', 30, { split: true })
    expect(again).toEqual(t)
    // Without `split` (the Whisper models) the segment is kept whole, as before.
    expect(localTranscript([one], 'bn', 30).segments).toHaveLength(1)
  })

  it('prefers a sentence end, then the middle when the pauses are alike; a caption that fits is kept whole', () => {
    const even = (n: number, mark = -1): [string, number, number][] => Array.from({ length: n }, (_, i) => [i === mark ? `w${i}।` : `w${i}`, i * 0.6, i * 0.6 + 0.5])
    // 20 words with equal pauses (11.9 s): cut in the middle; each half (5.9 s, 10 words) fits.
    expect(captionPieces(even(20).map(([text, start, end]) => ({ text, start, end }))).map((p) => p.length)).toEqual([10, 10])
    // A dari (।) after word 5 wins over the middle; the 14 words after it (8.3 s) are cut in their middle.
    const dari = captionPieces(even(20, 5).map(([text, start, end]) => ({ text, start, end })))
    expect(dari.map((p) => p.length)).toEqual([6, 7, 7])
    expect(dari[0].at(-1)!.text).toBe('w5।')
    // At most 14 words and 7 s: kept whole; one word longer than 7 s is never cut.
    expect(captionPieces(even(11).map(([text, start, end]) => ({ text, start, end })))).toHaveLength(1)
    expect(captionPieces([{ text: 'long', start: 0, end: 9 }])).toEqual([[{ text: 'long', start: 0, end: 9 }]])
    expect(captionPieces([])).toEqual([])
    // 15 quick words in 3 s: cut for the word count alone, at least 3 words on each side.
    const quick = Array.from({ length: 15 }, (_, i) => ({ text: `q${i}`, start: i * 0.2, end: i * 0.2 + 0.15 }))
    expect(captionPieces(quick).map((p) => p.length)).toEqual([7, 8])
  })
})

describe('Bengali text and the per-model chunk length (docs/design/offline-captions.md §14)', () => {
  // ো written in two parts (ে U+09C7 + া U+09BE), as whisper's byte tokens can leave it, and composed (U+09CB).
  const split = 'কোন'
  const composed = 'কোন'
  const seg = (text: string): SidecarSegment => ({ type: 'segment', start: 0, end: 1, text, words: [{ text, start: 0, end: 1, prob: 0.9 }] })

  it('puts Bengali words and text in NFC', () => {
    const t = localTranscript([seg(split)], 'bn', 2)
    expect(t.segments[0].words![0].text).toBe(composed)
    expect(t.segments[0].text).toBe(composed)
    expect(localTranscript([{ ...seg(split), words: [] }], 'bn', 2).segments[0].text).toBe(composed)
    expect(localTranscript([seg(split)], 'bengali', 2).segments[0].text).toBe(composed)
  })

  it('keeps every other language exactly as the helper wrote it', () => {
    // A CJK compatibility ideograph, which NFC would replace (U+F900 → U+8C48).
    expect(localTranscript([seg('豈')], 'ja', 2).segments[0].text).toBe('豈')
    expect(localTranscript([seg(split)], 'hi', 2).segments[0].text).toBe(split)
    expect(localTranscript([seg(split)], 'auto', 2).segments[0].text).toBe(split)
    expect(localTranscript([seg(split)], '', 2).segments[0].text).toBe(split)
  })

  it('passes --max-chunk only for a model that sets it, inside the bounds the helper accepts', () => {
    expect(MAX_CHUNK_RANGE).toEqual({ min: 1, max: 29.5 })
    expect(chunkArgs({ maxChunkSeconds: 20 })).toEqual(['--max-chunk', '20'])
    expect(chunkArgs({ maxChunkSeconds: 29.5 })).toEqual(['--max-chunk', '29.5'])
    expect(chunkArgs({})).toEqual([])
    for (const bad of [0.5, 30, Number.NaN, Number.POSITIVE_INFINITY]) expect(chunkArgs({ maxChunkSeconds: bad })).toEqual([])
    // The helper's default stays the frozen SIDECAR.maxChunk.
    expect(SIDECAR.maxChunk).toBe(29)
  })

  it("passes every argument a model sets for itself: its chunk length and --no-timestamps", () => {
    expect(modelArgs({ maxChunkSeconds: 20, noTimestamps: true })).toEqual(['--max-chunk', '20', '--no-timestamps'])
    expect(modelArgs({ noTimestamps: true })).toEqual(['--no-timestamps'])
    expect(modelArgs({ maxChunkSeconds: 20 })).toEqual(['--max-chunk', '20'])
    expect(modelArgs({})).toEqual([])
  })
})
