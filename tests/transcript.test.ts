import { describe, expect, it } from 'vitest'
import { retimeWords } from '../src/shared/captions/edit'
import { clipIndexAt, cutRange, outputDuration } from '../src/shared/engine/timeline'
import {
  alignCaptionWords,
  anchorCutWords,
  captionWordTimes,
  cutFlags,
  cutWords,
  lcsPairs,
  MAX_REACH,
  normalizeWord,
  restoreWords,
  sameWords,
  settleDeletedWords,
  spansSaving,
  transcriptWords,
  wordIndexAt,
  wordsRange,
  type TranscriptWord
} from '../src/shared/editor/transcript'
import type { CaptionSegment, CaptionWord, Clip, Project, Transcript } from '../src/shared/types'

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

  it('takes, of the longest matchings, the one with the fewest pairs to avoid, then the earliest', () => {
    const shown = ['i', 'think', 'we']
    const stored = ['i', 'think', 'i', 'think', 'we']
    expect(lcsPairs(shown, stored)).toEqual([
      [0, 0],
      [1, 1],
      [2, 4]
    ])
    expect(lcsPairs(shown, stored, Object.is, (_, j) => j < 2)).toEqual([
      [0, 2],
      [1, 3],
      [2, 4]
    ])
    // Never at the cost of length.
    expect(lcsPairs(['a', 'b'], ['a', 'b'], Object.is, (i) => i === 0)).toEqual([
      [0, 0],
      [1, 1]
    ])
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

  it('gives the word left of two equal ones the time of the one not deleted, heard or a guess', () => {
    // "I think" said twice, the first take deleted in the tab, then the repeat taken out of the text.
    const takes = (estimated: boolean): CaptionWord[] =>
      timed([
        ['I', 2, 2.1],
        ['think', 2.1, 2.5],
        ['I', 3, 3.1],
        ['think', 3.1, 3.5],
        ['we', 3.6, 3.8]
      ]).map((w, k) => ({ ...w, ...(estimated ? { estimated: true as const } : {}), ...(k < 2 ? { deleted: true as const } : {}) }))
    for (const estimated of [false, true]) {
      const w = alignCaptionWords({ id: 'a', start: 2, end: 4, text: 'I think we', words: takes(estimated) })
      expect(w.map((x) => [x.start, x.end, x.estimated, !!x.deleted])).toEqual([
        [3, 3.1, estimated, false],
        [3.1, 3.5, estimated, false],
        [3.6, 3.8, estimated, false]
      ])
    }
    // The second take deleted: the first. Nothing deleted: the first, as ever.
    const second = takes(false).map((w, k) => (k === 2 || k === 3 ? { ...w, deleted: true as const } : { text: w.text, start: w.start, end: w.end }))
    expect(alignCaptionWords({ id: 'a', start: 2, end: 4, text: 'I think we', words: second })[0]).toMatchObject({ start: 2, end: 2.1 })
    expect(alignCaptionWords({ id: 'a', start: 2, end: 4, text: 'I think we', words: takes(false).map(({ text, start, end }) => ({ text, start, end })) })[0]).toMatchObject({ start: 2, end: 2.1 })
  })

  it('matches a word with nothing left once normalised (a dash, "&") only to the same text, with its time and mark', () => {
    const w = alignCaptionWords({
      id: 'a',
      start: 0,
      end: 3,
      text: 'Tom & Jerry - fun',
      words: [
        { text: 'Tom', start: 0, end: 0.5 },
        { text: '&', start: 0.6, end: 0.8, estimated: true, deleted: true },
        { text: 'Jerry', start: 1, end: 1.5 },
        { text: '—', start: 1.6, end: 1.8 },
        { text: 'fun', start: 2, end: 2.5 }
      ]
    })
    expect(w.map((x) => [x.text, x.start, x.end, x.estimated, !!x.deleted])).toEqual([
      ['Tom', 0, 0.5, false, false],
      ['&', 0.6, 0.8, true, true],
      ['Jerry', 1, 1.5, false, false],
      ['-', 1.5, 2, true, false],
      ['fun', 2, 2.5, false, false]
    ])
  })

  it('keeps the own time of a deleted word its caption was trimmed past, and the words around it inside the caption', () => {
    const w = alignCaptionWords({
      id: 'a',
      start: 0.9,
      end: 3,
      text: 'Um, uh so today',
      words: [
        { text: 'Um,', start: 0.3, end: 0.6, deleted: true },
        { text: 'so', start: 1.5, end: 2 }
      ]
    })
    expect(w.map((x) => [x.text, +x.start.toFixed(3), +x.end.toFixed(3), x.estimated, !!x.deleted])).toEqual([
      ['Um,', 0.3, 0.6, false, true],
      ['uh', 0.9, 1.5, true, false],
      ['so', 1.5, 2, false, false],
      ['today', 2, 3, true, false]
    ])
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

  it('takes words out of time order: a deleted word left past its trimmed caption, the next caption moved over its time', () => {
    // "um" (29.5-29.8 s) deleted, its caption's end trimmed to 29.4 s, the next caption's start dragged there.
    const words: TranscriptWord[] = [
      { index: 0, caption: 'a', text: 'you', start: 29, end: 29.3, estimated: false },
      { index: 1, caption: 'a', text: 'um', start: 29.5, end: 29.8, estimated: true, deleted: true },
      { index: 2, caption: 'b', text: 'Bye.', start: 29.4, end: 29.5, estimated: false }
    ]
    expect(cutFlags(words, [clip(0, 29.508)])).toEqual([false, true, false])
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

  it('restores a short word at the edge of a longer cut, or at the very start or end, on its own', () => {
    // "I saw a big cat": "a" and "big" are 0.06 s each and every word touches the next.
    const w = wordsAt([
      [1, 1.4],
      [1.4, 1.6],
      [1.6, 1.66],
      [1.66, 1.72],
      [1.72, 2.1]
    ])
    const flags = (c: Clip[]): string => cutFlags(w, c).map(Number).join('')
    const noSliver = (c: Clip[]): boolean => c.every((x) => x.end - x.start >= 0.1 - 1e-9)
    // "a big" cut together, or one by one: the same 0.12 s cut.
    for (const cut of [cutWords(full, w, [[2, 3]], 10), cutWords(cutWords(full, w, [[2, 2]], 10), w, [[3, 3]], 10)]) {
      expect(cut.map((c) => [c.start, c.end])).toEqual([
        [0, 1.6],
        [1.72, 10]
      ])
      expect(flags(restoreWords(cut, w, 2, 2, 10))).toBe('00010')
      expect(flags(restoreWords(cut, w, 3, 3, 10))).toBe('00100')
      expect(flags(restoreWords(cut, w, 1, 2, 10))).toBe('00010')
      for (const [a, b] of [[2, 2], [3, 3], [1, 2]]) expect(noSliver(restoreWords(cut, w, a, b, 10))).toBe(true)
    }
    // Inside "saw a big", "a" meets no kept clip: it comes back on its own all the same.
    const inside = restoreWords(cutWords(full, w, [[1, 3]], 10), w, 2, 2, 10)
    expect(flags(inside)).toBe('01010')
    expect(noSliver(inside)).toBe(true)
    // A short first word at 0 s and a short last word at the recording's end.
    const edges = wordsAt([
      [0, 0.08],
      [0.08, 0.5],
      [9.5, 9.9],
      [9.9, 9.96]
    ])
    const ends = cutWords([clip(0, 9.98)], edges, [[0, 0], [3, 3]], 9.98)
    expect(ends.map((c) => [c.start, c.end])).toEqual([[0.08, 9.9]])
    expect(restoreWords(ends, edges, 0, 0, 9.98).map((c) => [c.start, c.end])).toEqual([[0, 9.9]])
    expect(restoreWords(ends, edges, 3, 3, 9.98).map((c) => [c.start, c.end])).toEqual([[0.08, 9.98]])
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

describe('anchorCutWords', () => {
  const full = [clip(0, 20)]
  // An untimed caption, one with word timings, and an untimed one nothing is cut in.
  const t = transcript([
    seg('a', 0.4, 3.8, 'So um, I thnk it works.'),
    seg('b', 5, 6, 'and this', [
      ['and', 5, 5.4],
      ['this', 5.5, 6]
    ]),
    seg('c', 8, 10, 'too, um, maybe')
  ])
  const words = transcriptWords(t)
  const at = (text: string): number => words.findIndex((w) => w.text === text)

  it('stores the times of an untimed caption with a word newly cut, as the tab showed them: the cut word marked deleted, the others still guesses', () => {
    const cut = cutWords(full, words, [[at('um,'), at('um,')]], 20)
    const out = anchorCutWords(t, full, cut)!
    expect(out.segments[0].words).toEqual(
      alignCaptionWords(t.segments[0]).map(({ text, start, end }) => (text === 'um,' ? { text, start, end, estimated: true, deleted: true } : { text, start, end, estimated: true }))
    )
    // Nothing else changes: the timed caption and the untouched one stay the same objects.
    expect(out.segments[1]).toBe(t.segments[1])
    expect(out.segments[2]).toBe(t.segments[2])
    expect(sameWords(transcriptWords(out), words)).toBe(true)
    expect(transcriptWords(out).filter((w) => w.caption === 'a' && w.deleted).map((w) => w.text)).toEqual(['um,'])
    expect(transcriptWords(out).every((w) => w.caption !== 'a' || w.estimated)).toBe(true)
    // A second word cut there later is marked too; the first stays marked.
    const again = cutWords(cut, words, [[at('thnk'), at('thnk')]], 20)
    const out2 = anchorCutWords(out, cut, again)!
    expect(transcriptWords(out2).filter((w) => w.caption === 'a' && w.deleted).map((w) => w.text)).toEqual(['um,', 'thnk'])
    expect(sameWords(transcriptWords(out2), words)).toBe(true)
  })

  it('stores the times of a caption with word timings when a word with a guessed time is cut (the text was edited)', () => {
    // "alot" fixed to "a lot" in the Captions tab: "a" and "lot" are guessed between "think" and "works.".
    const edited = transcript([
      seg('w', 0.4, 3.8, 'So um, I think a lot works.', [
        ['So', 0.4, 0.7],
        ['um,', 1.0, 1.5],
        ['I', 1.9, 2.0],
        ['think', 2.0, 2.4],
        ['alot', 2.5, 2.9],
        ['works.', 3.0, 3.6]
      ])
    ])
    const ws = transcriptWords(edited)
    const a = ws.findIndex((w) => w.text === 'a')
    const cut = cutWords(full, ws, [[a, a + 1]], 20)
    const out = anchorCutWords(edited, full, cut)!
    expect(out.segments[0].words).toEqual([
      { text: 'So', start: 0.4, end: 0.7 },
      { text: 'um,', start: 1.0, end: 1.5 },
      { text: 'I', start: 1.9, end: 2.0 },
      { text: 'think', start: 2.0, end: 2.4 },
      { text: 'a', start: ws[a].start, end: ws[a].end, estimated: true, deleted: true },
      { text: 'lot', start: ws[a + 1].start, end: ws[a + 1].end, estimated: true, deleted: true },
      { text: 'works.', start: 3.0, end: 3.6 }
    ])
    expect(transcriptWords(out).map((w) => !!w.deleted)).toEqual([false, false, false, false, true, true, false])
    expect(sameWords(transcriptWords(out), ws)).toBe(true)
  })

  it('marks a heard word cut in the tab too, its caption\'s timings otherwise as they were', () => {
    const cut = cutWords(full, words, [[at('this'), at('this')]], 20)
    const out = anchorCutWords(t, full, cut, [[at('this'), at('this')]])!
    expect(out.segments[1].words).toEqual([
      { text: 'and', start: 5, end: 5.4 },
      { text: 'this', start: 5.5, end: 6, deleted: true }
    ])
    expect(out.segments[0]).toBe(t.segments[0])
    expect(out.segments[2]).toBe(t.segments[2])
    expect(sameWords(transcriptWords(out), words)).toBe(true)
    // Cut by its middle as before.
    expect(cutFlags(transcriptWords(out), cut)).toEqual(cutFlags(words, cut))
  })

  it('changes nothing when no word is newly cut', () => {
    // A restore; a word already cut on the timeline, outside the spans.
    const timedCut = cutWords(full, words, [[at('this'), at('this')]], 20)
    expect(anchorCutWords(t, timedCut, full)).toBe(t)
    const early = cutWords(full, words, [[at('maybe'), at('maybe')]], 20)
    expect(anchorCutWords(t, early, early)).toBe(t)
    expect(anchorCutWords(t, early, early, [[at('and'), at('and')]])).toBe(t)
    expect(anchorCutWords(undefined, full, early)).toBeUndefined()
  })

  it('marks every guess inside the spans being cut whose middle is then cut, also one an earlier cut had already cut', () => {
    const g = transcript([seg('g', 10, 17, 'Now open the settings and pick a folder for your recordings')])
    const ws = transcriptWords(g)
    const i = (text: string): number => ws.findIndex((w) => w.text === text)
    const deleted = (x: Transcript | undefined): string[] => transcriptWords(x).filter((w) => w.deleted).map((w) => w.text)
    // Smart speed > Silences first: it cuts the pause at 11.85-13.75 s, where "settings and pick a" are guessed.
    const silences = [clip(0, 11.85), clip(13.75, 30)]
    // Then "the settings" deleted: both marked, "settings" too though its middle was already cut; "and pick a" not.
    const cut = cutWords(silences, ws, [[i('the'), i('settings')]], 30)
    expect(deleted(anchorCutWords(g, silences, cut, [[i('the'), i('settings')]]))).toEqual(['the', 'settings'])
    // A span wholly inside the earlier cut: the clips do not change, the word is marked all the same.
    expect(cutWords(silences, ws, [[i('pick'), i('pick')]], 30).map((c) => [c.start, c.end])).toEqual([[0, 11.85], [13.75, 30]])
    expect(deleted(anchorCutWords(g, silences, silences, [[i('pick'), i('pick')]]))).toEqual(['pick'])
    // Words of the spans that stay in a clip (a cut refused: it would cut the whole video) are not marked.
    expect(anchorCutWords(g, [clip(0, 30)], [clip(0, 30)], [[0, ws.length - 1]])).toBe(g)
  })
})

describe('cutFlags: one rule for heard words, deleted words and guesses (edit-by-text.md §4.2)', () => {
  const struck = (segments: CaptionSegment[], clips: Clip[]): string[] => {
    const ws = transcriptWords(transcript(segments))
    const flags = cutFlags(ws, clips)
    return ws.filter((_, i) => flags[i]).map((w) => w.text)
  }
  const cut = (from: number, to: number): Clip[] => [clip(0, from), clip(to, 30)]
  // "alot" fixed to "a lot" in the Captions tab: "a" and "lot" are guessed between "think" and "works.".
  const whisper = seg('w', 0.4, 3.8, 'So I think a lot works.', [
    ['So', 0.4, 0.7],
    ['I', 1.9, 2.0],
    ['think', 2.0, 2.4],
    ['alot', 2.5, 2.9],
    ['works.', 3.0, 3.6]
  ])

  it('cuts a guess only when its heard neighbours and everything between their middles are cut', () => {
    expect(struck([whisper], cut(1.8, 3.7))).toEqual(['I', 'think', 'a', 'lot', 'works.'])
    expect(struck([whisper], cut(2.1, 3.5))).toEqual(['think', 'a', 'lot', 'works.'])
    // "think" (middle 2.2 s) still plays: the guesses after it may still be heard.
    expect(struck([whisper], cut(2.3, 3.5))).toEqual(['works.'])
    expect(struck([whisper], cut(2.45, 2.95))).toEqual([])
  })

  it('takes the caption\'s first start or last end where a guess has no heard neighbour: a caption without timings goes only when all of it is cut', () => {
    const gemini = seg('g', 10, 17, 'Now open the settings and pick a folder for your recordings')
    expect(struck([gemini], cut(11.85, 13.75))).toEqual([])
    expect(struck([gemini], cut(10, 16.9))).toEqual([])
    expect(struck([gemini], cut(9, 18))).toEqual(gemini.text.split(' '))
    // A word added before the first timed one: from the caption's start to the middle of "So".
    const added = seg('a', 0.5, 1.4, 'uh So', [['So', 1.0, 1.4]])
    expect(struck([added], [clip(0.9, 30)])).toEqual([])
    expect(struck([added], [clip(1.3, 30)])).toEqual(['uh', 'So'])
  })

  it('takes a clip that only touches that time as keeping none of it: a caption cut up to its very end, the next one right after it', () => {
    const untimed = seg('g', 10, 17, 'Now open the settings and pick a folder for your recordings')
    const next = seg('n', 17, 20, 'Then press Start.')
    // A range cut snapped to the caption's edges, or from before it; a start trim to its end.
    for (const clips of [cut(10, 17), cut(9, 17), [clip(17, 30)]]) expect(struck([untimed, next], clips)).toEqual(untimed.text.split(' '))
    // From the end of a caption before it: the clip that ends where it starts keeps none of it either.
    expect(struck([seg('p', 8, 10, 'First.'), untimed], cut(10, 17.5))).toEqual(untimed.text.split(' '))
    // Words added after "world" (cut), up to the caption's end where the next clip starts: surely cut, while "Hello" plays.
    const added = seg('h', 10, 12, 'Hello world, I said', [
      ['Hello', 10, 10.5],
      ['world,', 11, 11.5]
    ])
    expect(struck([added, next], cut(10.8, 12))).toEqual(['world,', 'I', 'said'])
  })

  it('cuts every word of a caption a cut reached and its clips keep less than MIN_CUE of (output seconds), heard words too: the subtitle files leave it out', () => {
    const untimed = seg('g', 10, 17, 'Now open the settings and pick a folder for your recordings')
    expect(struck([untimed], cut(10, 16.97))).toEqual(untimed.text.split(' '))
    expect(struck([untimed], [clip(0, 10), clip(16.92, 30, 2)])).toEqual(untimed.text.split(' '))
    // 0.1 s kept, or 0.06 s at 1x: a guess there may still be heard.
    expect(struck([untimed], cut(10, 16.9))).toEqual([])
    expect(struck([untimed], [clip(0, 10), clip(16.94, 30)])).toEqual([])
    // "works." keeps its middle (0.94 s) in the 0.045 s left of its caption ending at 0.98 s; one running to 1.5 s keeps 0.565 s, a cue.
    const yes = (end: number): CaptionSegment =>
      seg('y', 0.4, end, 'Yes works.', [
        ['Yes', 0.4, 0.7],
        ['works.', 0.9, 0.98]
      ])
    expect(struck([yes(0.98)], [clip(0.935, 30)])).toEqual(['Yes', 'works.'])
    expect(struck([yes(0.98)], [clip(0.92, 30)])).toEqual(['Yes'])
    expect(struck([yes(1.5)], [clip(0.935, 30)])).toEqual(['Yes'])
    // Measured on the caption's own time, wider than its words' (a Whisper segment, a caption dragged longer): "it." keeps its middle and 1 s of its caption.
    const said = seg('c', 20, 21.6, "So that's it.", [
      ['So', 20.1, 20.3],
      ["that's", 20.3, 20.6],
      ['it.', 20.6, 20.64]
    ])
    expect(struck([said], [clip(0, 19.75), clip(20.6, 30)])).toEqual(['So', "that's"])
    expect(struck([said], [clip(0, 19.75, 2), clip(20.6, 30, 2)])).toEqual(['So', "that's"])
    expect(struck([said], [clip(0, 19.8), clip(20.6, 21.64)])).toEqual(['So', "that's"])
    expect(struck([said], [clip(0, 19.8), clip(20.6, 20.69, 2), clip(21.6, 30)])).toEqual(['So', "that's", 'it.'])
    // Word timings shorter than a cue, none of them cut: nothing is; "yes." cut, "Hmm," stays (its caption keeps 0.215 s).
    const hmm = seg('h', 5, 5.5, 'Hmm, yes.', [
      ['Hmm,', 5.2, 5.2],
      ['yes.', 5.2, 5.23]
    ])
    expect(struck([hmm], [clip(0, 30)])).toEqual([])
    expect(struck([hmm], [clip(0, 5.215)])).toEqual(['yes.'])
  })

  it('cuts a guess deleted in the tab by its middle, and never takes one as a heard neighbour', () => {
    const g = transcript([seg('g', 10, 17, 'Now open the settings and pick a folder for your recordings')])
    const ws = transcriptWords(g)
    const i = ws.findIndex((w) => w.text === 'settings')
    const full = [clip(0, 30)]
    const marked = anchorCutWords(g, full, cutWords(full, ws, [[i, i]], 30), [[i, i]])!
    // Only the Silences cut left (the word's own cut restored on the timeline would clear the mark: settleDeletedWords).
    expect(struck(marked.segments, cut(11.85, 13.75))).toEqual(['settings'])
    // "a" deleted, "lot" a guess: its neighbours are "think" (still heard at 2.2 s) and "works.", not "a".
    const deletedA = seg('w', 0.4, 3.8, 'So I think a lot works.')
    deletedA.words = [
      { text: 'So', start: 0.4, end: 0.7 },
      { text: 'I', start: 1.9, end: 2.0 },
      { text: 'think', start: 2.0, end: 2.4 },
      { text: 'a', start: 2.4, end: 2.55, estimated: true, deleted: true },
      { text: 'works.', start: 3.0, end: 3.6 }
    ]
    expect(struck([deletedA], cut(2.4, 3.7))).toEqual(['a', 'works.'])
  })

  it('cuts a guess that follows the recording\'s sound (a text-only answer) by its middle, and takes it as a heard neighbour', () => {
    // gpt-transcribe's words placed over the sound (transcriptTiming.timeTextPart).
    const placed = seg('s', 0.4, 3.6, 'So I think it works.')
    placed.words = [
      { text: 'So', start: 0.4, end: 0.7, estimated: true, fromSound: true },
      { text: 'I', start: 0.7, end: 0.9, estimated: true, fromSound: true },
      { text: 'think', start: 0.9, end: 1.5, estimated: true, fromSound: true },
      { text: 'it', start: 1.5, end: 1.8, estimated: true, fromSound: true },
      { text: 'works.', start: 1.8, end: 2.6, estimated: true, fromSound: true }
    ]
    expect(struck([placed], cut(0.85, 1.85))).toEqual(['think', 'it'])
    // "it" retyped as "that": a plain guess between "think" and "works.", cut only with the time between their middles.
    const retyped = { ...placed, text: 'So I think that works.' }
    expect(struck([retyped], cut(1.4, 1.7))).toEqual([])
    expect(struck([retyped], cut(1.1, 2.3))).toEqual(['think', 'that', 'works.'])
  })
})

describe('captionWordTimes', () => {
  it('stores heard times as they are, guesses marked, and deleted guesses marked deleted (kept from before, or now)', () => {
    const s = seg('w', 0, 4, 'So um, I think', [
      ['So', 0, 0.5],
      ['think', 3, 4]
    ])
    const once = captionWordTimes(s, (i) => i === 1)
    expect(once.map((w) => [w.text, !!w.estimated, !!w.deleted])).toEqual([
      ['So', false, false],
      ['um,', true, true],
      ['I', true, false],
      ['think', false, false]
    ])
    expect(captionWordTimes({ ...s, words: once }).map((w) => !!w.deleted)).toEqual([false, true, false, false])
    // A heard word deleted keeps its time, marked.
    expect(captionWordTimes(s, (i) => i === 0)[0]).toEqual({ text: 'So', start: 0, end: 0.5, deleted: true })
    expect(captionWordTimes({ ...s, words: captionWordTimes(s, (i) => i === 3) })[3]).toEqual({ text: 'think', start: 3, end: 4, deleted: true })
  })

  it('keeps a guess that follows the sound marked so, deleted or not; a word added is a plain guess', () => {
    const s = seg('s', 0, 2, 'So it works.')
    s.words = [
      { text: 'So', start: 0, end: 0.5, estimated: true, fromSound: true },
      { text: 'works.', start: 1, end: 2, estimated: true, fromSound: true }
    ]
    expect(captionWordTimes(s, (i) => i === 0)).toEqual([
      { text: 'So', start: 0, end: 0.5, estimated: true, fromSound: true, deleted: true },
      { text: 'it', start: 0.5, end: 1, estimated: true },
      { text: 'works.', start: 1, end: 2, estimated: true, fromSound: true }
    ])
  })
})

describe('settleDeletedWords', () => {
  const g = transcript([seg('g', 10, 17, 'Now open the settings and pick a folder for your recordings'), seg('h', 20, 22, 'Thanks.')])
  const ws = transcriptWords(g)
  const i = ws.findIndex((w) => w.text === 'settings')
  const full = [clip(0, 30)]
  const cutClips = cutWords(full, ws, [[i, i]], 30)
  const deleted: Project = { duration: 30, clips: cutClips, transcript: anchorCutWords(g, full, cutClips, [[i, i]]) } as unknown as Project
  const marks = (p: Project): string[] => transcriptWords(p.transcript).filter((w) => w.deleted).map((w) => w.text)

  it('takes the mark off a deleted word whose middle plays after an edit, and only then', () => {
    expect(marks(deleted)).toEqual(['settings'])
    // Restored (the tab's Restore, Restore the whole recording, the timeline): a guess again, still `estimated`.
    const restored = settleDeletedWords({ ...deleted, clips: full }, deleted)
    expect(marks(restored)).toEqual([])
    expect(restored.transcript!.segments[0].words!.every((w) => w.estimated)).toBe(true)
    expect(restored.transcript!.segments[1]).toBe(deleted.transcript!.segments[1])
    // Still cut after another edit (a Silences cut over it): the mark stays, the same object.
    const silences = { ...deleted, clips: cutRange(cutClips, 11.85, 13.75) }
    expect(settleDeletedWords(silences, deleted)).toBe(silences)
    // Its caption moved on the track so that the word plays: the mark goes too.
    const moved = { ...deleted, transcript: { ...g, segments: [retimeWords(deleted.transcript!.segments[0], { start: 14, end: 21 }), g.segments[1]] } }
    expect(marks(settleDeletedWords(moved, deleted))).toEqual([])
  })

  it('reads a deleted word at its own time, outside its caption when a trim left it there', () => {
    // "settings" (about 11.9-13.1 s) deleted, the caption's start trimmed past it to 13.5 s.
    const trimmed = { ...deleted, transcript: { ...g, segments: [retimeWords(deleted.transcript!.segments[0], { start: 13.5, end: 17 }), g.segments[1]] } }
    expect(settleDeletedWords(trimmed, deleted)).toBe(trimmed)
    expect(marks(trimmed)).toEqual(['settings'])
    // Its own time brought back: the mark goes, though the caption starts after it.
    expect(marks(settleDeletedWords({ ...trimmed, clips: full }, trimmed))).toEqual([])
  })

  it('keeps a guess that follows the sound marked so, through the delete and the restore', () => {
    const placed = transcript([seg('s', 0, 2, 'So it works.')])
    placed.segments[0].words = [
      { text: 'So', start: 0, end: 0.5, estimated: true, fromSound: true },
      { text: 'it', start: 0.5, end: 1.2, estimated: true, fromSound: true },
      { text: 'works.', start: 1.2, end: 2, estimated: true, fromSound: true }
    ]
    const cutIt = cutWords(full, transcriptWords(placed), [[1, 1]], 30)
    const gone = { duration: 30, clips: cutIt, transcript: anchorCutWords(placed, full, cutIt, [[1, 1]]) } as unknown as Project
    expect(marks(gone)).toEqual(['it'])
    expect(gone.transcript!.segments[0].words!.every((w) => w.fromSound)).toBe(true)
    expect(settleDeletedWords({ ...gone, clips: full }, gone).transcript!.segments[0].words).toEqual(placed.segments[0].words)
  })

  it('changes nothing when neither the clips nor the transcript changed, or there is no mark', () => {
    const stale = { ...deleted, clips: full }
    expect(settleDeletedWords(stale, stale)).toBe(stale)
    const plain = { duration: 30, clips: full, transcript: g } as unknown as Project
    expect(settleDeletedWords({ ...plain, clips: cutClips }, plain).transcript).toBe(g)
    const none = { duration: 30, clips: full } as unknown as Project
    expect(settleDeletedWords({ ...none, clips: cutClips }, none).transcript).toBeUndefined()
  })
})

describe('sameWords', () => {
  it('compares captions, texts and times', () => {
    const a = wordsAt([
      [0, 1],
      [1, 2]
    ])
    expect(sameWords(a, a.map((w) => ({ ...w, start: w.start + 1e-9, estimated: true })))).toBe(true)
    expect(sameWords(a, a.slice(1))).toBe(false)
    expect(sameWords(a, a.map((w, i) => (i ? { ...w, text: 'x' } : w)))).toBe(false)
    expect(sameWords(a, a.map((w, i) => (i ? { ...w, end: 2.5 } : w)))).toBe(false)
    expect(sameWords(a, a.map((w) => ({ ...w, caption: 'b' })))).toBe(false)
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
