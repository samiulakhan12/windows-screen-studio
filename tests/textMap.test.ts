/**
 * Word maps of text records (docs/design/captions-studio.md §4.2 rule 8, §11.1 rule 1): reading
 * them strictly, writing them as runs, composing two tidies, and moving words both ways.
 */
import { describe, expect, it } from 'vitest'
import { alignedRanges, composeRanges, newWordsOf, oldWordsOf, pieceRanges, readTextMap, oneToOne, textMapRuns, wordRanges } from '../src/shared/captions/textMap'

/** A small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random ranges of a valid map: groups of 1–3 old words become 1–3 new words, word for word or sharing them. */
function randomRanges(r: () => number, groups: number): { ranges: [number, number][]; old: number } {
  const ranges: [number, number][] = []
  let old = 0
  for (let g = 0; g < groups; g++) {
    const o = 1 + Math.floor(r() * 3)
    const n = 1 + Math.floor(r() * 3)
    if (o === n && r() < 0.5) for (let k = 0; k < n; k++) ranges.push([old + k, old + k])
    else for (let k = 0; k < n; k++) ranges.push([old, old + o - 1])
    old += o
  }
  return { ranges, old }
}

describe('wordRanges and readTextMap: strict', () => {
  it('reads runs that pair words one for one, and runs whose new words share old words', () => {
    // "our q and a and fifty users" → "Our Q&A and 50 users".
    expect(wordRanges([[0, 0, 0, 0], [1, 1, 1, 3], [2, 2, 4, 4], [3, 3, 5, 5], [4, 4, 6, 6]], 5, 7)).toEqual([[0, 0], [1, 3], [4, 4], [5, 5], [6, 6]])
    expect(wordRanges([[0, 4, 0, 4]], 5, 5)).toEqual(oneToOne(5))
    // "google dogs" → "Google Docs": each new word from both.
    expect(wordRanges([[0, 0, 0, 1], [1, 1, 0, 1]], 2, 2)).toEqual([[0, 1], [0, 1]])
    // "flown" → "Flow In" (one word to two) and two words to three.
    expect(wordRanges([[0, 1, 0, 0]], 2, 1)).toEqual([[0, 0], [0, 0]])
    expect(wordRanges([[0, 2, 0, 1]], 3, 2)).toEqual([[0, 1], [0, 1], [0, 1]])
  })

  it('drops a map that is out of range, out of order, not covering, or not runs of four integers', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'x',
      [],
      {},
      [[0, 1, 0]],
      [[0, 1, 0, 1, 9]],
      [[0, 1, 0, '1']],
      [[0, 1, 0, 1.5]],
      [[0, 1, -1, 0]],
      // new words skipped, repeated or past the end
      [[1, 2, 0, 2]],
      [[0, 0, 0, 0], [0, 2, 1, 2]],
      [[0, 3, 0, 3]],
      // old words skipped, going back, past the end, not all covered
      [[0, 0, 0, 0], [1, 2, 2, 3]],
      [[0, 0, 1, 1], [1, 2, 0, 0]],
      [[0, 2, 0, 3]],
      [[0, 0, 0, 0], [1, 2, 1, 1]],
      [[0, 2, 0, 1]],
      [[0, 0, 0, 2], [1, 1, 1, 1], [2, 2, 2, 2]],
      [[0, 0, 0, 1], [1, 2, 3, 3]],
      [[2, 0, 0, 2]],
      [[0, 0, 1, 0], [1, 2, 1, 2]]
    ]
    for (const raw of bad) {
      expect(wordRanges(raw, 3, 3), JSON.stringify(raw)).toBeNull()
      expect(readTextMap(raw, 3, 3), JSON.stringify(raw)).toBeUndefined()
    }
    // More runs than words, and texts without words.
    expect(wordRanges([[0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]], 3, 4)).toBeNull()
    expect(wordRanges([[0, 0, 0, 0]], 0, 1)).toBeNull()
    expect(wordRanges([[0, 0, 0, 0]], 1, 0)).toBeNull()
    expect(wordRanges([[0, 0, 0, 0]], NaN, 1)).toBeNull()
  })

  it('a map read back is a copy of the same runs', () => {
    const raw = [[0, 0, 0, 0], [1, 1, 1, 3], [2, 4, 4, 6]]
    const read = readTextMap(raw, 5, 7)!
    expect(read).toEqual(raw)
    expect(read).not.toBe(raw)
    expect(read[0]).not.toBe(raw[0])
    expect(readTextMap(JSON.parse(JSON.stringify(read)), 5, 7)).toEqual(read)
  })
})

describe('textMapRuns', () => {
  it('writes the fewest runs: word for word, and shared words', () => {
    expect(textMapRuns(oneToOne(6))).toEqual([[0, 5, 0, 5]])
    expect(textMapRuns([[0, 0], [1, 3], [4, 4], [5, 5]])).toEqual([[0, 0, 0, 0], [1, 1, 1, 3], [2, 3, 4, 5]])
    // Two new words sharing two old ones are a run each: [0, 1, 0, 1] would pair them.
    expect(textMapRuns([[0, 1], [0, 1]])).toEqual([[0, 0, 0, 1], [1, 1, 0, 1]])
    expect(textMapRuns([[0, 1], [0, 1], [0, 1]])).toEqual([[0, 2, 0, 1]])
    expect(textMapRuns([[0, 0], [0, 0], [1, 1]])).toEqual([[0, 1, 0, 0], [2, 2, 1, 1]])
  })

  it('reads back as the ranges it was written from (random maps)', () => {
    const r = rng(7)
    for (let k = 0; k < 2000; k++) {
      const { ranges, old } = randomRanges(r, 1 + Math.floor(r() * 8))
      const runs = textMapRuns(ranges)
      expect(wordRanges(runs, ranges.length, old)).toEqual(ranges)
      expect(runs.length).toBeLessThanOrEqual(ranges.length)
    }
  })
})

describe('composing and moving words', () => {
  it('two tidies compose onto the text before the first', () => {
    // "two hundred and fifty google dogs" → "250 google dogs" → "250 Google Docs."
    const first: [number, number][] = [[0, 3], [4, 4], [5, 5]]
    const second: [number, number][] = [[0, 0], [1, 2], [1, 2]]
    expect(composeRanges(second, first)).toEqual([[0, 3], [4, 5], [4, 5]])
    expect(composeRanges(oneToOne(3), first)).toEqual(first)
    expect(composeRanges(first, oneToOne(6))).toEqual(first)
  })

  it('Remove takes words back to the words they came from; a tidy takes words to every word made from them', () => {
    const ranges: [number, number][] = [[0, 0], [1, 3], [4, 4], [5, 6], [5, 6]]
    expect(oldWordsOf(ranges, 1, 1)).toEqual([1, 3])
    expect(oldWordsOf(ranges, 3, 3)).toEqual([5, 6])
    expect(oldWordsOf(ranges, 0, 4)).toEqual([0, 6])
    expect(newWordsOf(ranges, 2, 2)).toEqual([1, 1])
    expect(newWordsOf(ranges, 1, 3)).toEqual([1, 1])
    expect(newWordsOf(ranges, 4, 4)).toEqual([2, 2])
    expect(newWordsOf(ranges, 6, 6)).toEqual([3, 4])
    expect(newWordsOf(ranges, 0, 6)).toEqual([0, 4])
    // Every group of old words goes there and back to itself (random maps).
    const r = rng(11)
    for (let k = 0; k < 500; k++) {
      const { ranges: map } = randomRanges(r, 1 + Math.floor(r() * 8))
      for (let j = 0; j < map.length; j++) {
        const [a, b] = map[j]
        const [x, y] = newWordsOf(map, a, b)
        expect(oldWordsOf(map, x, y)).toEqual([a, b])
      }
    }
  })
})

describe('pieceRanges', () => {
  it('a piece written as a whole: each word from all; same letters: by the letters; as many words: one for one', () => {
    expect(pieceRanges(['google', 'dogs'], ['Google', 'Docs'], true)).toEqual([[0, 1], [0, 1]])
    expect(pieceRanges(['flown'], ['Flow', 'In'], true)).toEqual([[0, 0], [0, 0]])
    expect(pieceRanges(['word', ','], ['word,'], false)).toEqual([[0, 1]])
    // A Japanese sentence and its full stop joined: the stop goes with the last word.
    expect(pieceRanges(['今日', 'は', 'いい', '天気', 'です', '。'], ['今日', 'は', 'いい', '天気', 'です。'], false)).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 5]])
    expect(pieceRanges(['so'], ['So'], false)).toEqual([[0, 0]])
    expect(pieceRanges(['বলব'], ['বলব।'], false)).toEqual([[0, 0]])
    expect(pieceRanges(['a', 'b', 'c'], ['x', 'y'], false)).toEqual([[0, 2], [0, 2]])
  })

  it('a term the piece already had, in any capitals: each word from its own, with a full stop or a comma joined too', () => {
    for (const was of [['visual', 'studio'], ['Visual', 'Studio'], ['VISUAL', 'studio']]) expect(pieceRanges(was, ['Visual', 'Studio'], true)).toEqual([[0, 0], [1, 1]])
    expect(pieceRanges(['visual', 'studio'], ['Visual', 'Studio.'], true)).toEqual([[0, 0], [1, 1]])
    expect(pieceRanges(['visual', 'studio,'], ['Visual', 'Studio.'], true)).toEqual([[0, 0], [1, 1]])
    expect(pieceRanges(['visual', 'studio', ','], ['Visual', 'Studio.'], true)).toEqual([[0, 0], [1, 2]])
    expect(pieceRanges(['Google', 'Docs', ','], ['Google', 'Docs,'], true)).toEqual([[0, 0], [1, 2]])
    // Letters written apart or together: by the letters.
    expect(pieceRanges(['vscode'], ['VS', 'Code'], true)).toEqual([[0, 0], [0, 0]])
    expect(pieceRanges(['face', 'book'], ['Facebook'], true)).toEqual([[0, 1]])
  })

  it('a term written as a whole after which a comma was written apart: the comma goes with its last word only', () => {
    expect(pieceRanges(['google', 'dogs', ','], ['Google', 'Docs,'], true)).toEqual([[0, 1], [0, 2]])
    expect(pieceRanges(['vscode', ','], ['VS', 'Code,'], true)).toEqual([[0, 0], [0, 1]])
    expect(pieceRanges(['two', 'hundred', ','], ['200,'], true)).toEqual([[0, 2]])
  })
})

describe('alignedRanges (the AI fix)', () => {
  it('words found again come from themselves; changed words from the words they replace', () => {
    expect(alignedRanges(['helo', 'world'], ['hello', 'world'])).toEqual([[0, 0], [1, 1]])
    expect(alignedRanges(['i', 'm', 'gonna', 'go'], ["I'm", 'going', 'to', 'go'])).toEqual([[0, 2], [0, 2], [0, 2], [3, 3]])
    expect(alignedRanges(['so', 'we', 'can', 'start'], ['So', 'we', 'can', 'start.'])).toEqual(oneToOne(4))
  })

  it('a word added comes from the word before it (or the first); a word taken out goes with the word before it (or the next)', () => {
    expect(alignedRanges(['i', 'think'], ['I', 'do', 'think'])).toEqual([[0, 0], [0, 0], [1, 1]])
    expect(alignedRanges(['think', 'so'], ['I', 'think', 'so'])).toEqual([[0, 0], [0, 0], [1, 1]])
    expect(alignedRanges(['so', 'um', 'we', 'start'], ['so', 'we', 'start'])).toEqual([[0, 1], [2, 2], [3, 3]])
    expect(alignedRanges(['um', 'so', 'we', 'start'], ['so', 'we', 'start'])).toEqual([[0, 1], [2, 2], [3, 3]])
    expect(alignedRanges(['we', 'start', 'um'], ['we', 'start'])).toEqual([[0, 0], [1, 2]])
    expect(alignedRanges(['a', 'b'], ['x', 'y', 'z'])).toEqual([[0, 1], [0, 1], [0, 1]])
  })

  it('repeated words: the words a change spans stay together', () => {
    // "and" is said twice; the change is the number.
    expect(alignedRanges(['two', 'and', 'three', 'and', 'four'], ['two', 'and', '3', 'and', 'four'])).toEqual(oneToOne(5))
    expect(alignedRanges(['the', 'the', 'end'], ['the', 'end'])).toEqual([[0, 1], [2, 2]])
  })

  it('always gives a valid map (random edits)', () => {
    const r = rng(3)
    const vocab = ['a', 'and', 'the', 'x', 'y', 'z', 'q']
    for (let k = 0; k < 1500; k++) {
      const was = Array.from({ length: 1 + Math.floor(r() * 8) }, () => vocab[Math.floor(r() * vocab.length)])
      const next = Array.from({ length: 1 + Math.floor(r() * 8) }, () => vocab[Math.floor(r() * vocab.length)])
      const ranges = alignedRanges(was, next)
      expect(wordRanges(textMapRuns(ranges), next.length, was.length), `${was.join(' ')} → ${next.join(' ')}`).toEqual(ranges)
    }
  })
})
