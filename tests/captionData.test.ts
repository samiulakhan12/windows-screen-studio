import { describe, expect, it } from 'vitest'
import { cleanCaptionText, readCaptionSegments, readTranscript } from '../src/shared/captions/captionData'
import {
  applyTextResult,
  captionDragBounds,
  dragCaptionTimes,
  findInCaptions,
  mergeWithNext,
  readSuggestedChapters,
  replaceInCaptions,
  retimeWords,
  splitCaption
} from '../src/shared/captions/edit'
import { DEFAULT_CAPTIONS, readCaptionSettings, withPreset } from '../src/shared/captions/settings'
import { outputCues } from '../src/shared/captions/subtitles'
import { validateSegmentsAnswer } from '../src/shared/captions/transcriptText'
import { migrateProject } from '../src/shared/engine/project'
import type { CaptionSegment } from '../src/shared/types'

const seg = (id: string, start: number, end: number, text: string, words?: CaptionSegment['words']): CaptionSegment => ({ id, start, end, text, ...(words && { words }) })

describe('readCaptionSegments', () => {
  it('drops malformed captions, clamps to the recording, sorts and cleans the text', () => {
    const out = readCaptionSegments(
      [
        null,
        42,
        { id: 'b', start: 5, end: 7, text: '  second\nline\t ' },
        { id: 'a', start: -1, end: 2, text: 'first' },
        { id: 'x', start: 3, end: 3.01, text: 'too short' },
        { id: 'y', start: 'x', end: 4, text: 'bad time' },
        { id: 'z', start: 3, end: 4, text: '   ' },
        { id: 'c', start: 9, end: 20, text: 'past the end' }
      ],
      10
    )
    expect(out.map((s) => [s.id, s.start, s.end, s.text])).toEqual([
      ['a', 0, 2, 'first'],
      ['b', 5, 7, 'second line'],
      ['c', 9, 10, 'past the end']
    ])
  })

  it('gives missing or repeated ids new unique ones', () => {
    const out = readCaptionSegments([seg('a', 0, 1, 'x'), seg('a', 1, 2, 'y'), { start: 2, end: 3, text: 'z' }], 10)
    expect(new Set(out.map((s) => s.id)).size).toBe(3)
    expect(out[0].id).toBe('a')
  })

  it('removes overlaps: a caption starts where the one before ends', () => {
    const out = readCaptionSegments([seg('a', 0, 2, 'x'), seg('b', 1.5, 3, 'y'), seg('c', 2.5, 2.9, 'inside')], 10)
    expect(out.map((s) => [s.id, s.start, s.end])).toEqual([
      ['a', 0, 2],
      ['b', 2, 3]
    ])
  })

  it('keeps usable word timings inside their caption, sorted', () => {
    const [s] = readCaptionSegments(
      [
        seg('a', 1, 3, 'hi there', [
          { text: 'there', start: 2, end: 9 },
          { text: 'hi', start: 0.5, end: 1.5 },
          { text: '', start: 1, end: 2 },
          { text: 'bad', start: NaN, end: 2 } as never
        ])
      ],
      10
    )
    expect(s.words).toEqual([
      { text: 'hi', start: 1, end: 1.5 },
      { text: 'there', start: 2, end: 3 }
    ])
  })

  it('keeps a word timing marked as a guess (stored with a cut in the Transcript tab), and only a real mark', () => {
    const [s] = readCaptionSegments(
      [
        seg('a', 1, 3, 'hi there you', [
          { text: 'hi', start: 1, end: 1.5, estimated: true },
          { text: 'there', start: 1.5, end: 2 },
          { text: 'you', start: 2, end: 3, estimated: 'yes' } as never
        ])
      ],
      10
    )
    expect(s.words).toEqual([
      { text: 'hi', start: 1, end: 1.5, estimated: true },
      { text: 'there', start: 1.5, end: 2 },
      { text: 'you', start: 2, end: 3 }
    ])
  })

  it('keeps a word marked deleted in the Transcript tab, and only a real mark; words without marks read as before', () => {
    const raw = [
      seg('a', 1, 3, 'hi there you', [
        { text: 'hi', start: 1, end: 1.5, estimated: true, deleted: true },
        { text: 'there', start: 1.5, end: 2, estimated: true },
        { text: 'you', start: 2, end: 3, estimated: true, deleted: 1 } as never
      ]),
      seg('b', 4, 5, 'old one', [
        { text: 'old', start: 4, end: 4.5 },
        { text: 'one', start: 4.5, end: 5 }
      ])
    ]
    const read = readCaptionSegments(JSON.parse(JSON.stringify(raw)), 10)
    expect(read[0].words).toEqual([
      { text: 'hi', start: 1, end: 1.5, estimated: true, deleted: true },
      { text: 'there', start: 1.5, end: 2, estimated: true },
      { text: 'you', start: 2, end: 3, estimated: true }
    ])
    // Saved again, a caption without marks is byte for byte what it was.
    expect(JSON.stringify(read[1])).toBe(JSON.stringify(raw[1]))
  })
})

describe('readTranscript', () => {
  it('reads a transcript or nothing', () => {
    expect(readTranscript(null)).toBeUndefined()
    expect(readTranscript({ segments: 'x' })).toBeUndefined()
    const t = readTranscript({ provider: 'gemini', model: 'm', createdAt: 'now', language: 'bn', segments: [seg('a', 0, 1, 'x')] }, 5)!
    expect(t).toEqual({ provider: 'gemini', model: 'm', createdAt: 'now', language: 'bn', segments: [seg('a', 0, 1, 'x')] })
    const odd = readTranscript({ provider: 'other', language: 'not a language!', segments: [] })!
    expect(odd.provider).toBe('openai')
    expect(odd.language).toBeUndefined()
    expect(odd.segments).toEqual([])
  })
})

describe('readCaptionSettings', () => {
  it('sanitises every field', () => {
    expect(readCaptionSettings(undefined)).toBeUndefined()
    expect(readCaptionSettings([])).toBeUndefined()
    expect(readCaptionSettings({})).toEqual(DEFAULT_CAPTIONS)
    const s = readCaptionSettings({ show: false, preset: 'karaoke', position: 'top', size: 9, color: '#ABCDEF', highlightColor: 'red', background: 'box', maxLines: 1 })!
    expect(s).toEqual({ show: false, preset: 'karaoke', position: 'top', size: 0.09, color: '#abcdef', highlightColor: DEFAULT_CAPTIONS.highlightColor, background: 'box', maxLines: 1 })
    expect(readCaptionSettings({ preset: 'neon', position: 'left', background: 'glow', maxLines: 3 })).toMatchObject({ preset: 'clean', position: 'bottom', background: 'shadow', maxLines: 2 })
  })

  it('picking a preset sets its colours and background and keeps the rest', () => {
    const s = withPreset({ ...DEFAULT_CAPTIONS, position: 'top', size: 0.05 }, 'boxed')
    expect(s).toMatchObject({ preset: 'boxed', background: 'box', position: 'top', size: 0.05 })
  })
})

describe('migrateProject: transcript and captions', () => {
  const base = { id: 'p', version: 2, duration: 10, clips: [{ id: 'c', start: 0, end: 10, speed: 1 }] }

  it('older projects have neither', () => {
    const p = migrateProject(base)
    expect('transcript' in p).toBe(false)
    expect('captions' in p).toBe(false)
  })

  it('reads them through the readers', () => {
    const p = migrateProject({
      ...base,
      transcript: { provider: 'openai', model: 'w', createdAt: '', segments: [seg('b', 4, 12, 'late'), seg('a', 1, 2, 'early'), { bad: true }] },
      captions: { show: true, preset: 'bold', size: -1 }
    })
    expect(p.transcript!.segments.map((s) => [s.id, s.start, s.end])).toEqual([
      ['a', 1, 2],
      ['b', 4, 10]
    ])
    expect(p.captions).toMatchObject({ preset: 'bold', size: 0.025 })
    expect(migrateProject({ ...base, transcript: 'nope', captions: 7 }).transcript).toBeUndefined()
  })
})

describe('caption editing', () => {
  it('cleans text to one line', () => {
    expect(cleanCaptionText(' a\r\nb  c ')).toBe('a b c')
    expect(cleanCaptionText('x'.repeat(900))).toHaveLength(500)
  })

  it('drags between neighbours, never shorter than the minimum', () => {
    const list = [seg('a', 0, 2, 'a'), seg('b', 3, 5, 'b'), seg('c', 6, 8, 'c')]
    const bounds = captionDragBounds(list, 'b', 10)
    expect(bounds).toEqual({ min: 2, max: 6 })
    expect(dragCaptionTimes({ start: 3, end: 5 }, 'move', -5, bounds)).toEqual({ start: 2, end: 4 })
    expect(dragCaptionTimes({ start: 3, end: 5 }, 'move', 5, bounds)).toEqual({ start: 4, end: 6 })
    expect(dragCaptionTimes({ start: 3, end: 5 }, 'start', 5, bounds)).toEqual({ start: 4.8, end: 5 })
    expect(dragCaptionTimes({ start: 3, end: 5 }, 'end', 5, bounds)).toEqual({ start: 3, end: 6 })
    expect(dragCaptionTimes({ start: 3, end: 5 }, 'start', -5, bounds)).toEqual({ start: 2, end: 5 })
    expect(captionDragBounds(list, 'a', 10)).toEqual({ min: 0, max: 3 })
    expect(captionDragBounds(list, 'c', 10)).toEqual({ min: 5, max: 10 })
  })

  it('moves word timings with a moved caption and keeps them inside a trimmed one', () => {
    const s = seg('a', 1, 3, 'a b', [
      { text: 'a', start: 1, end: 2 },
      { text: 'b', start: 2, end: 3 }
    ])
    expect(retimeWords(s, { start: 2, end: 4 }).words).toEqual([
      { text: 'a', start: 2, end: 3 },
      { text: 'b', start: 3, end: 4 }
    ])
    expect(retimeWords(s, { start: 1, end: 2.5 }).words).toEqual([
      { text: 'a', start: 1, end: 2 },
      { text: 'b', start: 2, end: 2.5 }
    ])
  })

  it('splits at the word spoken there', () => {
    const s = seg('a', 0, 3, 'one two three', [
      { text: 'one', start: 0, end: 1 },
      { text: 'two', start: 1, end: 2 },
      { text: 'three', start: 2, end: 3 }
    ])
    const out = splitCaption([s], 'a', 1.6)!
    expect(out.map((x) => [x.start, x.end, x.text])).toEqual([
      [0, 1.6, 'one two'],
      [1.6, 3, 'three']
    ])
    expect(out[0].id).toBe('a')
    expect(out[1].id).not.toBe('a')
    expect(out[1].words).toEqual([{ text: 'three', start: 2, end: 3 }])
    expect(splitCaption([s], 'a', 0.01)).toBeNull()
    expect(splitCaption([seg('b', 0, 3, 'single')], 'b', 1.5)).toBeNull()
    // Without word timings: by length.
    const even = splitCaption([seg('c', 0, 2, 'aaaa bbbb')], 'c', 1)!
    expect(even.map((x) => x.text)).toEqual(['aaaa', 'bbbb'])
  })

  it('merges with the next caption', () => {
    const out = mergeWithNext([seg('a', 0, 1, 'one'), seg('b', 1.2, 2, 'two'), seg('c', 3, 4, 'three')], 'a')!
    expect(out.map((x) => [x.id, x.start, x.end, x.text])).toEqual([
      ['a', 0, 2, 'one two'],
      ['c', 3, 4, 'three']
    ])
    expect(mergeWithNext([seg('a', 0, 1, 'x')], 'a')).toBeNull()
  })

  it('keeps every word time when one caption has word timings and the other none, or they no longer match the text', () => {
    const timed = seg('a', 0, 2, 'one two', [
      { text: 'one', start: 0.2, end: 0.6 },
      { text: 'two', start: 1, end: 1.5 }
    ])
    // The untimed one's words keep the times they had on their own, marked as guesses.
    const merged = mergeWithNext([timed, seg('b', 2, 4, 'aa bb')], 'a')!
    expect(merged[0].words).toEqual([
      { text: 'one', start: 0.2, end: 0.6 },
      { text: 'two', start: 1, end: 1.5 },
      { text: 'aa', start: 2, end: 3, estimated: true },
      { text: 'bb', start: 3, end: 4, estimated: true }
    ])
    expect(mergeWithNext([seg('b', 0, 1, 'aa'), seg('c', 1, 2, 'bb')], 'b')![0].words).toBeUndefined()
    // "won" fixed to "one too" after the timings were made: the words are split where they were spoken.
    const edited = seg('a', 0, 3, 'one too three', [
      { text: 'won', start: 0, end: 0.8 },
      { text: 'three', start: 2.2, end: 3 }
    ])
    const out = splitCaption([edited], 'a', 2)!
    expect(out.map((x) => x.text)).toEqual(['one too', 'three'])
    expect(out[0].words).toEqual([
      { text: 'one', start: 0, end: 1.1, estimated: true },
      { text: 'too', start: 1.1, end: 2, estimated: true }
    ])
    expect(out[1].words).toEqual([{ text: 'three', start: 2.2, end: 3 }])
  })

  it('finds and replaces ignoring case, removing captions left empty', () => {
    const list = [seg('a', 0, 1, 'Um, hello um'), seg('b', 1, 2, 'um'), seg('c', 2, 3, 'clean')]
    expect(findInCaptions(list, 'UM')).toEqual([
      { id: 'a', count: 2 },
      { id: 'b', count: 1 }
    ])
    const r = replaceInCaptions(list, 'um', '')
    expect(r.count).toBe(3)
    expect(r.segments.map((s) => s.text)).toEqual([', hello', 'clean'])
    expect(replaceInCaptions(list, 'a.b', 'x').count).toBe(0)
    expect(replaceInCaptions(list, 'hello', '$&$&').segments[0].text).toBe('Um, $&$& um')
  })

  it('applies an AI result only when ids and times are unchanged', () => {
    const list = [seg('a', 0, 1, 'helo'), seg('b', 1, 2, 'wrld')]
    const good = [
      { id: 'a', start: 0, end: 1, text: 'hello' },
      { id: 'b', start: 1.0004, end: 2, text: 'world' }
    ]
    expect(applyTextResult(list, good)!.map((s) => s.text)).toEqual(['hello', 'world'])
    expect(applyTextResult(list, good.slice(0, 1))).toBeNull()
    expect(applyTextResult(list, [good[1], good[0]])).toBeNull()
    expect(applyTextResult(list, [good[0], { ...good[1], start: 1.5 }])).toBeNull()
    expect(applyTextResult(list, [good[0], { ...good[1], text: '  ' }])).toBeNull()
    expect(applyTextResult(list, 'nope')).toBeNull()
  })

  it('drops the word timings of a translation, keeps those of a clean-up that kept the words (CAP-6)', () => {
    const words = [
      { text: 'the', start: 0, end: 0.5 },
      { text: 'red', start: 0.6, end: 1.2 },
      { text: 'car', start: 1.3, end: 2 }
    ]
    const list = [seg('a', 0, 2, 'the red car', words)]
    // What the main process answers (it drops the words of a translation).
    const translated = validateSegmentsAnswer('translate', list, { segments: [{ id: 'a', text: 'el coche rojo' }] })
    const t = applyTextResult(list, translated)!
    expect(t[0].text).toBe('el coche rojo')
    expect(t[0].words).toBeUndefined()
    // Cutting 'red' out keeps the whole (untimed) translation, rather than dropping 'coche' by the English times.
    expect(outputCues(t, [{ id: 'x', start: 0, end: 0.55, speed: 1 }, { id: 'y', start: 1.25, end: 2, speed: 1 }])[0].text).toBe('el coche rojo')
    const cleaned = validateSegmentsAnswer('cleanup', list, { segments: [{ id: 'a', text: 'The red car.' }] })
    const c = applyTextResult(list, cleaned)!
    expect(c[0].text).toBe('The red car.')
    expect(c[0].words).toBe(words)
  })

  it('a caption that was already empty may come back empty; other captions may not (CAP-7)', () => {
    const list = [seg('a', 0, 1, 'hello world'), seg('b', 1, 2, ''), seg('c', 2, 3, 'bye now')]
    const answer = validateSegmentsAnswer('cleanup', list, { segments: [{ id: 'a', text: 'Hello, world.' }, { id: 'b', text: '' }, { id: 'c', text: 'Bye now.' }] })
    expect(applyTextResult(list, answer)!.map((s) => s.text)).toEqual(['Hello, world.', '', 'Bye now.'])
    expect(applyTextResult(list, answer.map((s) => (s.id === 'c' ? { ...s, text: '' } : s)))).toBeNull()
  })

  it('reads suggested chapters', () => {
    expect(readSuggestedChapters([{ t: 50, title: 'End' }, { t: -2, title: ' Intro\n' }, { t: 3 }, null, { t: NaN, title: 'x' }], 20)).toEqual([
      { t: 0, title: 'Intro' },
      { t: 20, title: 'End' }
    ])
    expect(readSuggestedChapters('x', 10)).toEqual([])
  })
})
