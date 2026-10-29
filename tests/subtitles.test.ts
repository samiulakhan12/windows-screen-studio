import { describe, expect, it } from 'vitest'
import { formatTimestamp, outputCues, subtitleFile, subtitleLines, toPlainText, toSrt, toVtt, validSubtitle } from '../src/shared/captions/subtitles'
import { cutFlags, cutWords, transcriptWords } from '../src/shared/editor/transcript'
import { freezePlan, NO_FREEZES } from '../src/shared/engine/freeze'
import type { CaptionSegment, Clip, Transcript } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })
const seg = (id: string, start: number, end: number, text: string, words?: CaptionSegment['words']): CaptionSegment => ({ id, start, end, text, ...(words && { words }) })

describe('formatTimestamp', () => {
  it('writes hours, minutes, seconds and milliseconds', () => {
    expect(formatTimestamp(0, ',')).toBe('00:00:00,000')
    expect(formatTimestamp(1500, ',')).toBe('00:00:01,500')
    expect(formatTimestamp(3_723_004, '.')).toBe('01:02:03.004')
    expect(formatTimestamp(-5, '.')).toBe('00:00:00.000')
  })
})

describe('outputCues: captions in output time', () => {
  it('keeps source times without edits', () => {
    expect(outputCues([seg('a', 1, 2.5, 'Hi')], [clip(0, 10)])).toEqual([{ start: 1, end: 2.5, text: 'Hi' }])
  })

  it('drops captions inside a cut and moves later ones earlier', () => {
    const clips = [clip(0, 3), clip(5, 10)]
    const cues = outputCues([seg('a', 1, 2, 'one'), seg('b', 3.2, 4.8, 'cut'), seg('c', 6, 7, 'three')], clips)
    expect(cues.map((c) => c.text)).toEqual(['one', 'three'])
    expect(cues[1].start).toBeCloseTo(4)
    expect(cues[1].end).toBeCloseTo(5)
  })

  it('clips a caption at cut boundaries (one cue across a cut, without the cut time)', () => {
    const clips = [clip(0, 3), clip(5, 10)]
    const [c] = outputCues([seg('a', 2, 6, 'across')], clips)
    expect(c.start).toBeCloseTo(2)
    expect(c.end).toBeCloseTo(4)
    // A trim at the start: a caption that starts before it begins at 0.
    const [d] = outputCues([seg('a', 0.5, 2, 'trimmed')], [clip(1, 10)])
    expect(d.start).toBeCloseTo(0)
    expect(d.end).toBeCloseTo(1)
  })

  it('scales by the clip speed', () => {
    const clips = [clip(0, 4, 2), clip(4, 10)]
    const cues = outputCues([seg('a', 1, 3, 'fast'), seg('b', 5, 6, 'normal')], clips)
    expect(cues[0].start).toBeCloseTo(0.5)
    expect(cues[0].end).toBeCloseTo(1.5)
    expect(cues[1].start).toBeCloseTo(3)
    expect(cues[1].end).toBeCloseTo(4)
  })

  it('leaves out words that were cut when the word timings match the text', () => {
    const words = [
      { text: 'keep', start: 1, end: 1.5 },
      { text: 'gone', start: 3.2, end: 3.6 },
      { text: 'kept', start: 5.2, end: 5.6 }
    ]
    const [c] = outputCues([seg('a', 1, 6, 'keep gone kept', words)], [clip(0, 3), clip(5, 10)])
    expect(c.text).toBe('keep kept')
  })

  it('leaves out a word deleted in the Transcript tab when the text no longer matches its word timings, or has none', () => {
    const timed = [
      { text: 'So', start: 0.4, end: 0.7 },
      { text: 'um,', start: 1.1, end: 1.5 },
      { text: 'I', start: 2, end: 2.1 },
      { text: 'think', start: 2.15, end: 2.5 },
      { text: 'alot', start: 2.6, end: 3 },
      { text: 'works.', start: 3.1, end: 3.6 }
    ]
    // "alot" fixed to "a lot" in the Captions tab (7 words, 6 timings); and a provider that gave no word timings.
    for (const caption of [seg('a', 0.4, 3.8, 'So um, I think a lot works.', timed), seg('a', 0.4, 3.8, 'So um, I think a lot works.')]) {
      const transcript = { provider: 'local', model: '', createdAt: '', segments: [caption] } as Transcript
      const words = transcriptWords(transcript)
      const um = words.findIndex((w) => w.text === 'um,')
      // Deleted as the Transcript tab does it.
      const clips = cutWords([clip(0, 10)], words, [[um, um]], 10)
      const flags = cutFlags(words, clips)
      expect(words.filter((_, i) => flags[i]).map((w) => w.text)).toEqual(['um,'])
      const [c] = outputCues([caption], clips)
      expect(c.text).toBe('So I think a lot works.')
      expect(subtitleFile([caption], clips, 'srt')).not.toContain('um,')
    }
  })

  it('never overlaps and drops slivers', () => {
    const cues = outputCues([seg('a', 1, 2.02, 'a'), seg('b', 2, 3, 'b'), seg('c', 4.99, 5.02, 'tiny')], [clip(0, 5)])
    expect(cues.map((c) => c.text)).toEqual(['a', 'b'])
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start)
  })
})

describe('subtitle files', () => {
  const cues = [
    { start: 1, end: 2.5, text: 'Hello <world> & you --> there' },
    { start: 3, end: 4.0004, text: 'Second line' }
  ]

  it('writes SRT', () => {
    expect(toSrt(cues)).toBe('1\n00:00:01,000 --> 00:00:02,500\nHello <world> & you -> there\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n')
    expect(validSubtitle('srt', toSrt(cues))).toBe(true)
  })

  it('writes WebVTT with its header and escapes markup', () => {
    expect(toVtt(cues)).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello &lt;world&gt; &amp; you -&gt; there\n\n00:00:03.000 --> 00:00:04.000\nSecond line\n')
    expect(validSubtitle('vtt', toVtt(cues))).toBe(true)
  })

  it('writes plain text, one caption per line', () => {
    expect(toPlainText(cues)).toBe('Hello <world> & you --> there\nSecond line\n')
    expect(toPlainText([])).toBe('')
  })

  it('breaks long cue text into lines of at most 42 characters', () => {
    const long = 'This is a fairly long caption that will not fit on a single subtitle line at all'
    const lines = subtitleLines(long)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(42)
    expect(lines.join(' ')).toBe(long)
  })

  it('makes the file in output time after a cut', () => {
    const srt = subtitleFile([seg('a', 1, 2, 'one'), seg('b', 6, 7, 'two')], [clip(0, 3), clip(5, 10)], 'srt')
    expect(srt).toContain('2\n00:00:04,000 --> 00:00:05,000\ntwo\n')
  })

  it('stretches a caption across a pause freeze; one starting at it shows through it, one ending at it ends before (E-11)', () => {
    const clips = [clip(0, 10)]
    const plan = freezePlan(clips, [{ id: 'f', at: 2, length: 3, sound: 'pause' }])
    const file = (s: CaptionSegment): string => subtitleFile([s], clips, 'srt', plan)
    expect(file(seg('a', 1, 3, 'across'))).toContain('00:00:01,000 --> 00:00:06,000')
    expect(file(seg('a', 2, 2.5, 'at'))).toContain('00:00:02,000 --> 00:00:05,500')
    expect(file(seg('a', 1, 2, 'before'))).toContain('00:00:01,000 --> 00:00:02,000')
    const segments = [seg('a', 1, 2, 'one'), seg('b', 6, 7, 'two')]
    for (const f of ['srt', 'vtt', 'txt'] as const) {
      expect(subtitleFile(segments, [clip(0, 3), clip(5, 10)], f, NO_FREEZES)).toBe(subtitleFile(segments, [clip(0, 3), clip(5, 10)], f))
    }
  })

  it('leaves out empty captions (an emptied caption brought back by Undo; CAP-7)', () => {
    const words = [{ text: 'gone', start: 0, end: 1 }]
    const segments = [seg('a', 0, 2, '', words), seg('b', 2, 4, 'second'), seg('c', 4, 5, '  ')]
    expect(subtitleFile(segments, [clip(0, 10)], 'srt')).toBe('1\n00:00:02,000 --> 00:00:04,000\nsecond\n')
    expect(subtitleFile(segments, [clip(0, 10)], 'vtt')).toBe('WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nsecond\n')
    expect(subtitleFile(segments, [clip(0, 10)], 'txt')).toBe('second\n')
  })

  it('validates content before it is written', () => {
    expect(validSubtitle('srt', '')).toBe(true)
    expect(validSubtitle('srt', 'hello')).toBe(false)
    expect(validSubtitle('vtt', '1\n00:00')).toBe(false)
    expect(validSubtitle('txt', 'a\u0000b')).toBe(false)
    expect(validSubtitle('exe', 'x')).toBe(false)
    expect(validSubtitle('txt', 42)).toBe(false)
  })
})
