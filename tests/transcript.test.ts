import { describe, expect, it } from 'vitest'
import { clipIndexAt, outputDuration } from '../src/shared/engine/timeline'
import {
  alignCaptionWords,
  cutFlags,
  cutWords,
  lcsPairs,
  MAX_REACH,
  normalizeWord,
  restoreWords,
  spansSaving,
  transcriptWords,
  wordIndexAt,
  wordsRange,
  type TranscriptWord
} from '../src/shared/editor/transcript'
import type { CaptionSegment, Clip, Transcript } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1, id = `c${start}`): Clip => ({ id, start, end, speed })

/** Timed words from [text, start, end] triples. */
const timed = (list: [string, number, number][]): { text: string; start: number; end: number }[] => list.map(([text, start, end]) => ({ text, start, end }))

const seg = (id: string, start: number, end: number, text: string, words?: [string, number, number][]): CaptionSegment => ({ id, start, end, text, ...(words ? { words: timed(words) } : {}) })

const transcript = (segments: CaptionSegment[]): Transcript => ({ provider: 'local', model: 'test', createdAt: '', segments })

/** Words of one caption: "w0 w1 ..." with the given [start, end] times. */
function wordsAt(times: [number, number][], caption = 'a'): TranscriptWord[] {
  return times.map(([start, end], index) => ({ index, caption, text: `w${index}`, start, end, estimated: false }))
}

describe('normalizeWord', () => {
  it('lower-cases, takes punctuation and symbols off the ends and keeps inner apostrophes', () => {
    expect(normalizeWord('Um,')).toBe('um')
    expect(normalizeWord('"Don\'t!"')).toBe("don't")
    expect(normalizeWord('...')).toBe('')
    expect(normalizeWord('ＵＭ')).toBe('um')
    expect(normalizeWord('মানে,')).toBe('মানে')
  })
})

describe('lcsPairs', () => {
  it('matches the longest common subsequence in order', () => {
    expect(lcsPairs(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd'])).toEqual([
      [0, 0],
      [2, 2],
      [3, 3]
    ])
    expect(lcsPairs([], ['a'])).toEqual([])
  })
})

describe('alignCaptionWords', () => {
  it('takes the timed words when the text matches them', () => {
    const w = alignCaptionWords(seg('a', 1, 3, 'Hello there world.', [['Hello', 1, 1.4], ['there', 1.5, 2], ['world.', 2.1, 2.9]]))
    expect(w.map((x) => [x.text, x.start, x.end, x.estimated])).toEqual([
      ['Hello', 1, 1.4, false],
      ['there', 1.5, 2, false],
      ['world.', 2.1, 2.9, false]
    ])
  })

  it('keeps the times of a word whose typo was fixed when the word count is the same and the rest match', () => {
    const w = alignCaptionWords(seg('a', 0, 3, 'the quick fox', [['the', 0, 0.5], ['quik', 0.6, 1.2], ['fox', 1.3, 2]]))
    expect(w[0]).toMatchObject({ start: 0, end: 0.5, estimated: false })
    expect(w[2]).toMatchObject({ start: 1.3, end: 2, estimated: false })
    // The fixed word shares out the time between its matched neighbours.
    expect(w[1]).toMatchObject({ text: 'quick', start: 0.5, end: 1.3, estimated: true })
  })

  it('shares time out to an added word and keeps the others exact', () => {
    const w = alignCaptionWords(seg('a', 0, 4, 'one two extra three', [['one', 0, 1], ['two', 1, 2], ['three', 3, 4]]))
    expect(w.map((x) => x.estimated)).toEqual([false, false, true, false])
    expect(w[2]).toMatchObject({ start: 2, end: 3 })
  })

  it('shares a retyped run at a caption end over the timed words it replaced, not the silence after them', () => {
    // The caption runs to 4 s, the speech to 3 s.
    const words: [string, number, number][] = [['a', 0.2, 1], ['b', 1.1, 2], ['c', 2.1, 3]]
    const all = alignCaptionWords(seg('a', 0, 4, 'x y z', words))
    expect(all.every((x) => x.estimated)).toBe(true)
    expect(all[0].start).toBeCloseTo(0.2)
    expect(all[2].end).toBeCloseTo(3)
    const tail = alignCaptionWords(seg('a', 0, 4, 'a y z', words))
    expect(tail[0]).toMatchObject({ start: 0.2, end: 1, estimated: false })
    expect(tail[1].start).toBeCloseTo(1)
    expect(tail[2].end).toBeCloseTo(3)
    const head = alignCaptionWords(seg('a', 0, 4, 'x y c', words))
    expect(head[0].start).toBeCloseTo(0.2)
    expect(head[1].end).toBeCloseTo(2.1)
  })

  it('lets a word added at a caption end, past every timed word, reach the caption end', () => {
    const w = alignCaptionWords(seg('a', 0, 4, 'one two three', [['one', 0.5, 1], ['two', 1.1, 2]]))
    expect(w[2]).toMatchObject({ start: 2, end: 4, estimated: true })
    const first = alignCaptionWords(seg('a', 0, 4, 'so one two', [['one', 0.5, 1], ['two', 1.1, 2]]))
    expect(first[0]).toMatchObject({ start: 0, end: 0.5, estimated: true })
  })

  it('leaves out timed words removed from the text', () => {
    const w = alignCaptionWords(seg('a', 0, 3, 'one three', [['one', 0, 1], ['two', 1, 2], ['three', 2, 3]]))
    expect(w.map((x) => [x.text, x.start, x.end])).toEqual([
      ['one', 0, 1],
      ['three', 2, 3]
    ])
  })

  it('shares the caption time by length when there are no word timings', () => {
    const w = alignCaptionWords(seg('a', 10, 13, 'aa a aaa'))
    expect(w.every((x) => x.estimated)).toBe(true)
    expect(w.map((x) => [+x.start.toFixed(3), +x.end.toFixed(3)])).toEqual([
      [10, 11],
      [11, 11.5],
      [11.5, 13]
    ])
  })

  it('keeps times inside the caption', () => {
    const w = alignCaptionWords(seg('a', 1, 2, 'a b', [['a', 0.5, 1.2], ['b', 1.5, 2.6]]))
    expect(w[0].start).toBe(1)
    expect(w[1].end).toBe(2)
  })
})

describe('transcriptWords', () => {
  it('numbers every word of every caption in order', () => {
    const t = transcript([seg('a', 0, 1, 'one two', [['one', 0, 0.4], ['two', 0.5, 1]]), seg('b', 2, 3, 'three')])
    const w = transcriptWords(t)
    expect(w.map((x) => [x.index, x.caption, x.text])).toEqual([
      [0, 'a', 'one'],
      [1, 'a', 'two'],
      [2, 'b', 'three']
    ])
    expect(transcriptWords(undefined)).toEqual([])
  })
})

describe('cutFlags', () => {
  it('agrees with clipIndexAt at each word middle', () => {
    let seed = 7
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let run = 0; run < 30; run++) {
      const clips: Clip[] = []
      let t = rnd()
      while (t < 50) {
        const end = t + 0.2 + rnd() * 3
        clips.push(clip(t, end))
        t = end + rnd() * 2
      }
      const times: [number, number][] = []
      let at = 0
      while (at < 55) {
        const len = rnd() * 0.6
        times.push([at, at + len])
        at += len + rnd() * 0.4
      }
      const words = wordsAt(times)
      const flags = cutFlags(words, clips)
      words.forEach((w, i) => expect(flags[i]).toBe(clipIndexAt(clips, (w.start + w.end) / 2) < 0))
    }
  })
})

describe('wordsRange', () => {
  const words = wordsAt([
    [1, 1.5],
    [1.9, 2.3],
    [2.35, 2.8],
    [5, 5.4]
  ])
  it('goes to the middle of the pause next to it', () => {
    expect(wordsRange(words, 1, 1, 10)).toEqual({ start: 1.7, end: 2.325 })
  })
  it('reaches at most MAX_REACH into a long pause', () => {
    const r = wordsRange(words, 2, 2, 10)
    expect(r.end).toBeCloseTo(2.8 + MAX_REACH)
  })
  it('reaches MAX_REACH without a neighbour, inside the recording', () => {
    expect(wordsRange(words, 0, 0, 10).start).toBeCloseTo(0.5)
    expect(wordsRange(words, 3, 3, 5.6).end).toBe(5.6)
    expect(wordsRange(wordsAt([[0.1, 0.4]]), 0, 0, 10).start).toBe(0)
  })
  it('treats overlapping timings as no pause', () => {
    const w = wordsAt([
      [1, 2],
      [1.8, 2.5]
    ])
    expect(wordsRange(w, 1, 1, 10).start).toBe(1.8)
  })
  it('makes spans next to each other meet exactly', () => {
    expect(wordsRange(words, 0, 0, 10).end).toBe(wordsRange(words, 1, 1, 10).start)
    expect(wordsRange(words, 1, 1, 10).end).toBe(wordsRange(words, 2, 2, 10).start)
  })
  it('accepts the span in either order', () => {
    expect(wordsRange(words, 2, 1, 10)).toEqual(wordsRange(words, 1, 2, 10))
  })
})

describe('cutWords and restoreWords', () => {
  const words = wordsAt([
    [1, 1.5],
    [2, 2.5],
    [3, 3.5],
    [4, 4.5],
    [5, 5.5]
  ])
  const full = [clip(0, 10)]

  it('cuts the range of the words and marks them cut', () => {
    const next = cutWords(full, words, [[1, 2]], 10)
    expect(next.map((c) => [c.start, c.end])).toEqual([
      [0, 1.75],
      [3.75, 10]
    ])
    expect(cutFlags(words, next)).toEqual([false, true, true, false, false])
  })

  it('gives the same cut word by word as all at once', () => {
    const together = cutWords(full, words, [[1, 3]], 10)
    const oneByOne = cutWords(cutWords(cutWords(full, words, [[1, 1]], 10), words, [[2, 2]], 10), words, [[3, 3]], 10)
    expect(oneByOne.map((c) => [c.start, c.end])).toEqual(together.map((c) => [c.start, c.end]))
  })

  it('restores what it cut', () => {
    const cut = cutWords(full, words, [[1, 2]], 10)
    const back = restoreWords(cut, words, 1, 2, 10)
    expect(back.map((c) => [c.start, c.end, c.speed])).toEqual([[0, 10, 1]])
  })

  it('restores only the words asked for inside a larger cut', () => {
    const cut = cutWords(full, words, [[1, 3]], 10)
    const back = restoreWords(cut, words, 2, 2, 10)
    expect(cutFlags(words, back)).toEqual([false, true, false, true, false])
  })

  it('never leaves a clip shorter than MIN_CLIP when restoring one short word', () => {
    const w = wordsAt([
      [1, 1.5],
      [1.5, 1.52],
      [1.52, 2]
    ])
    const cut = cutWords(full, w, [[0, 2]], 10)
    const back = restoreWords(cut, w, 1, 1, 10)
    expect(back.every((c) => c.end - c.start >= 0.1 - 1e-9)).toBe(true)
    expect(cutFlags(w, back)[1]).toBe(false)
  })

  it('restores a cut word shorter than MIN_CLIP between touching words, alone or with others', () => {
    // "I saw a cat": "a" is 0.06 s and its neighbours touch it, so its cut is only 0.06 s long.
    const w = wordsAt([
      [1, 1.3],
      [1.3, 1.6],
      [1.6, 1.66],
      [1.66, 2]
    ])
    const cut = cutWords(full, w, [[2, 2]], 10)
    expect(cut.map((c) => [c.start, c.end])).toEqual([
      [0, 1.6],
      [1.66, 10]
    ])
    expect(cutFlags(w, cut)).toEqual([false, false, true, false])
    expect(restoreWords(cut, w, 2, 2, 10).map((c) => [c.start, c.end, c.speed])).toEqual([[0, 10, 1]])
    expect(restoreWords(cut, w, 0, 3, 10).map((c) => [c.start, c.end, c.speed])).toEqual([[0, 10, 1]])
  })

  it('never cuts the whole video', () => {
    const one = wordsAt([[0.2, 9.8]])
    expect(cutWords(full, one, [[0, 0]], 10)).toBe(full)
  })

  it('ignores spans outside the word list', () => {
    expect(cutWords(full, words, [[7, 9]], 10)).toBe(full)
    expect(restoreWords(full, words, 7, 9, 10)).toBe(full)
  })

  it('counts what cutting saves now, once for overlaps, nothing when already cut', () => {
    expect(spansSaving(full, words, [[1, 1]], 10)).toBeCloseTo(1)
    expect(spansSaving(full, words, [[1, 2], [2, 3]], 10)).toBeCloseTo(3)
    const cut = cutWords(full, words, [[1, 1]], 10)
    expect(spansSaving(cut, words, [[1, 1]], 10)).toBeCloseTo(0)
    expect(outputDuration(cut)).toBeCloseTo(9)
  })
})

describe('wordIndexAt', () => {
  const words = wordsAt([
    [1, 1.5],
    [2, 2],
    [2, 2.5]
  ])
  it('finds the word being said, or -1 between words', () => {
    expect(wordIndexAt(words, 0.5)).toBe(-1)
    expect(wordIndexAt(words, 1.2)).toBe(0)
    expect(wordIndexAt(words, 1.5)).toBe(-1)
    expect(wordIndexAt(words, 1.7)).toBe(-1)
    expect(wordIndexAt(words, 2.1)).toBe(2)
    expect(wordIndexAt(words, 3)).toBe(-1)
    expect(wordIndexAt([], 1)).toBe(-1)
  })
})
