import { describe, expect, it } from 'vitest'
import { localTranscript, readSidecarLine, SIDECAR, type SidecarSegment } from '../src/shared/speech/protocol'

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
