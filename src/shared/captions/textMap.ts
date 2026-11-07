/**
 * Word maps of text records (docs/design/captions-studio.md §4.1, §11.1 rule 1, §11.7): which
 * words of the text before a tidy each word of the tidied text came from, written by the tidy
 * itself, so Review's Remove puts marks and anchors back on exactly the words they came from.
 * Words are counted as marks count them (studioWords, in the transcript's language). Pure.
 *
 * A map is stored as runs [newFrom, newTo, oldFrom, oldTo] (inclusive), in order, covering every
 * word of both texts: a run whose sides have as many words pairs them word for word ("so" →
 * "So"); any other run gives each of its new words all of its old words ("two hundred and fifty"
 * → "250", "flow in" → "Flown"). Two new words that share old words they do not split ("google
 * dogs" → "Google Docs") are written as one run each.
 */
import type { TextMapRun } from '../types'
import { studioWordTexts } from './words'

/** For each word of the new text, the first and last words of the old text it came from. */
export type WordRanges = readonly (readonly [number, number])[]

/** A word as compared: NFKC, lower case, without punctuation, symbols or spaces at its ends. */
export const wordKey = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')

/** The number of words of `text` as marks count them. */
export const wordCount = (text: string, language: string | undefined): number => studioWordTexts(text, language).length

/**
 * The words of a stored map (`raw`) for a new text of `newCount` words and an old one of
 * `oldCount`, or null when it is not a map of them: runs of four integers, the new words in order
 * with no gap, each new word's old words never before the previous word's (first and last alike),
 * no old word skipped, every word of both texts covered.
 */
export function wordRanges(raw: unknown, newCount: number, oldCount: number): [number, number][] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > newCount || !(newCount >= 1) || !(oldCount >= 1)) return null
  const out: [number, number][] = []
  for (const run of raw) {
    if (!Array.isArray(run) || run.length !== 4 || !run.every((x) => Number.isInteger(x))) return null
    const [nf, nt, of, ot] = run as number[]
    if (nf !== out.length || nt < nf || nt >= newCount || of < 0 || of > ot || ot >= oldCount) return null
    const pair = nt - nf === ot - of
    for (let j = nf; j <= nt; j++) {
      const from = pair ? of + j - nf : of
      const to = pair ? from : ot
      const prev = out[out.length - 1]
      if (prev ? from < prev[0] || to < prev[1] || from > prev[1] + 1 : from !== 0) return null
      out.push([from, to])
    }
  }
  return out.length === newCount && out[out.length - 1][1] === oldCount - 1 ? out : null
}

/** A stored map read for these texts: a copy of its runs when it is one (wordRanges), else undefined. */
export function readTextMap(raw: unknown, newCount: number, oldCount: number): TextMapRun[] | undefined {
  return wordRanges(raw, newCount, oldCount) ? (raw as number[][]).map((r) => [r[0], r[1], r[2], r[3]]) : undefined
}

/** `ranges` as the fewest runs that read back as them. */
export function textMapRuns(ranges: WordRanges): TextMapRun[] {
  const runs: TextMapRun[] = []
  for (let j = 0; j < ranges.length; ) {
    const [from, to] = ranges[j]
    // g new words from the same old words.
    let g = 1
    while (j + g < ranges.length && ranges[j + g][0] === from && ranges[j + g][1] === to) g++
    const old = to - from + 1
    const last = runs[runs.length - 1]
    if (g === 1 && old === 1 && last && last[1] - last[0] === last[3] - last[2] && last[3] + 1 === from) {
      // One more word of a run that pairs words one for one.
      last[1] = j
      last[3] = to
    } else if (g === old && g > 1) {
      // As many new words as old ones would read as paired: the last one gets a run of its own.
      runs.push([j, j + g - 2, from, to], [j + g - 1, j + g - 1, from, to])
    } else runs.push([j, j + g - 1, from, to])
    j += g
  }
  return runs
}

/** Each word of n, from the same word. */
export const oneToOne = (n: number): [number, number][] => Array.from({ length: n }, (_, i) => [i, i] as [number, number])

/** `outer` (new → middle) then `inner` (middle → old): new → old. */
export function composeRanges(outer: WordRanges, inner: WordRanges): [number, number][] {
  return outer.map(([a, b]) => [inner[a][0], inner[b][1]] as [number, number])
}

/** Words from..to of the new text as words of the old one (Remove puts the old text back). */
export function oldWordsOf(ranges: WordRanges, from: number, to: number): [number, number] {
  return [ranges[from][0], ranges[to][1]]
}

/** Words from..to of the old text as words of the new one: every new word made from any of them (a tidy writes the new text). */
export function newWordsOf(ranges: WordRanges, from: number, to: number): [number, number] {
  let a = 0
  while (a < ranges.length - 1 && ranges[a][1] < from) a++
  let b = ranges.length - 1
  while (b > 0 && ranges[b][0] > to) b--
  return [a, Math.max(a, b)]
}

/**
 * Words from..to of one text as words of another, each end narrowed within the words the map
 * gives it (`one`: the words of the other text for one word) to the one word there that is the
 * same word (`fromKeys`, `toKeys`: the texts' words as compared, wordKey), when there is exactly
 * one. A map gives a word taken out to the word before it and an added word the word before it
 * as its source ("So" from "so um", "we" made into "we really" by the AI fix), and punctuation
 * written apart to the word it joined ("app," from "app ,"): a record on the word stays on it.
 * Words that are not found the same (a term, a number) keep all the words the map gives them.
 */
export function narrowedWords(one: (i: number) => readonly [number, number], fromKeys: readonly string[], toKeys: readonly string[]): (from: number, to: number) => [number, number] {
  const same = (i: number): number | undefined => {
    const [a, b] = one(i)
    let found: number | undefined
    for (let k = a; k <= b; k++) {
      if (toKeys[k] !== fromKeys[i]) continue
      if (found !== undefined) return undefined
      found = k
    }
    return found
  }
  return (from, to) => {
    const a0 = one(from)[0]
    const b0 = one(to)[1]
    const a = same(from) ?? a0
    const b = same(to) ?? b0
    return a <= b ? [a, b] : [a0, b0]
  }
}

/**
 * For each word of `next`, the words of `was` holding its characters (`keep` gives the characters
 * that count, the same in both), or null when they are not the same characters. A word with none
 * comes from the last word the word before it came from (at the start, the words before the first
 * word's), and a word of `was` with none goes with the new word before it (the first at the start).
 */
function byCharacters(was: readonly string[], next: readonly string[], keep: (s: string) => string): [number, number][] | null {
  const kept = was.map(keep)
  const joined = kept.join('')
  if (!joined || joined !== next.map(keep).join('')) return null
  // owner[k]: the old word holding character k of the joined text.
  const owner: number[] = []
  kept.forEach((w, i) => {
    for (let k = 0; k < w.length; k++) owner.push(i)
  })
  let at = 0
  const out = next.map((w): [number, number] | null => {
    const n = keep(w).length
    if (!n) return null
    at += n
    return [owner[at - n], owner[at - 1]]
  })
  const first = out.find((r) => r)!
  for (let j = 0; j < out.length; j++) {
    const r = out[j] ?? (j ? [out[j - 1]![1], out[j - 1]![1]] : [0, Math.max(0, first[0] - 1)])
    if (j === 0) r[0] = 0
    // Old words between this word's and the one before go with the one before.
    else if (r[0] > out[j - 1]![1] + 1) out[j - 1]![1] = r[0] - 1
    out[j] = r
  }
  out[out.length - 1]![1] = was.length - 1
  return out as [number, number][]
}

/**
 * For each word of a tidied piece (`next`, its words), the words of the piece before (`was`) it
 * came from. With the same characters, case aside, by the characters: punctuation joined to the
 * word before it ("word ," → "word,"), and a word-list term the caption already had, or had in
 * other capitals ("visual studio" → "Visual Studio": each word from its own). Else, with the same
 * letters and digits once punctuation is set aside, by them: a term the caption had that a full
 * stop then ends ("visual studio" → "Visual Studio."). Else, written in place of them as a whole
 * (`whole`: a word-list term, a number), each word from all of them but punctuation written apart
 * after them, which joined the last word ("google dogs ," → "Google Docs,": "Google" from
 * "google dogs", "Docs," from "google dogs ,"); with as many words (capitals, a full stop), word
 * for word; else each word from all of them.
 */
export function pieceRanges(was: readonly string[], next: readonly string[], whole: boolean): [number, number][] {
  const letters = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '')
  const same = byCharacters(was, next, (s) => s.replace(/\s+/g, '').toLowerCase()) ?? byCharacters(was, next, letters)
  if (same) return same
  if (!whole && was.length === next.length) return oneToOne(next.length)
  let head = was.length
  if (whole) while (head > 1 && !letters(was[head - 1])) head--
  return next.map((_, j) => [0, j === next.length - 1 ? was.length - 1 : head - 1] as [number, number])
}

/**
 * Longest common subsequence pairs of `a` and `b` that leave the fewest runs of unpaired words.
 * Words a text fix puts back stay one run: "250 and then" against "two hundred and fifty and then"
 * pairs the second "and", not the one inside the number. Of those, the one pairing the most words
 * at the same times (`sameTime`); then the one whose words sit nearest where the words found once
 * in each put them, so "110 and 120" against "a hundred and ten and a hundred and twenty" pairs
 * the middle "and"; last, the earliest.
 */
export function lcsFewestRuns(a: readonly string[], b: readonly string[], sameTime: (i: number, j: number) => boolean = () => false): [number, number][] {
  const n = a.length
  const m = b.length
  const w = m + 1
  // Where each word of `a` is expected in `b`: words found once in each, in order, stay as they
  // are; the words between two of them spread evenly over the words between those in `b`.
  const count = (xs: readonly string[]): Map<string, number> => {
    const c = new Map<string, number>()
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1)
    return c
  }
  const inA = count(a)
  const inB = count(b)
  const at = new Map(b.map((x, j) => [x, j]))
  const fixed: [number, number][] = [[-1, -1]]
  a.forEach((x, i) => {
    const j = at.get(x)
    if (j !== undefined && inA.get(x) === 1 && inB.get(x) === 1 && j > fixed[fixed.length - 1][1]) fixed.push([i, j])
  })
  fixed.push([n, m])
  const expected = new Float64Array(n)
  for (let i = 0, f = 0; i < n; i++) {
    while (fixed[f + 1][0] <= i) f++
    const [i0, j0] = fixed[f]
    const [i1, j1] = fixed[f + 1]
    expected[i] = j0 + ((i - i0) * (j1 - j0)) / (i1 - i0)
  }
  // A pair scores more than all the runs can take off, so length comes first; a run more than all
  // the same times can add; a same time more than all the places. A place scores more the nearer
  // it is to where its word is expected, by half words. `paired`: the best from (i, j) right after
  // a pair (or at the start), where skipping a word starts a run; `open`: inside a run, where
  // skipping more words is free.
  const near = 2 * (m + 1)
  const time = (Math.min(n, m) + 1) * near
  const run = (Math.min(n, m) + 1) * (time + near)
  const unit = (n + m + 2) * run
  const score = (i: number, j: number): number => unit + (sameTime(i, j) ? time : 0) + near - Math.min(near, Math.round(2 * Math.abs(j - expected[i])))
  const paired = new Float64Array((n + 1) * w)
  const open = new Float64Array((n + 1) * w)
  const pairAt = (k: number, i: number, j: number): number => (i < n && j < m && a[i] === b[j] ? score(i, j) + paired[k + w + 1] : -Infinity)
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n && j === m) continue
      const k = i * w + j
      const skip = Math.max(i < n ? open[k + w] : -Infinity, j < m ? open[k + 1] : -Infinity)
      const pair = pairAt(k, i, j)
      open[k] = Math.max(pair, skip)
      paired[k] = Math.max(pair, skip - run)
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  let inRun = false
  while (i < n && j < m) {
    const k = i * w + j
    const best = inRun ? open[k] : paired[k]
    const cost = inRun ? 0 : run
    if (pairAt(k, i, j) === best) {
      pairs.push([i, j])
      i++
      j++
      inRun = false
    } else {
      if (open[k + w] - cost === best) i++
      else j++
      inRun = true
    }
  }
  return pairs
}

/**
 * For each word of `next`, the words of `was` it came from, when nothing but the two texts is known
 * (the AI fix): words found again (lcsFewestRuns of wordKey) come from themselves; the words
 * between two found ones come from all the old words between them; a word added comes from the old
 * word before it (the first one at the start), and a word taken out goes with the new word before
 * it (the first one at the start).
 */
export function alignedRanges(was: readonly string[], next: readonly string[]): [number, number][] {
  const n = was.length
  const m = next.length
  const out: [number, number][] = new Array(m)
  if (!m) return out
  if (!n) return next.map(() => [0, 0])
  const pairs = lcsFewestRuns(was.map(wordKey), next.map(wordKey))
  let pi = -1
  let pj = -1
  for (const [qi, qj] of [...pairs, [n, m] as [number, number]]) {
    const oldGap = qi - pi - 1
    const newGap = qj - pj - 1
    if (newGap > 0) {
      for (let j = pj + 1; j < qj; j++) out[j] = oldGap > 0 ? [pi + 1, qi - 1] : pi >= 0 ? [pi, pi] : [qi, qi]
    } else if (oldGap > 0 && pj >= 0) out[pj] = [out[pj][0], qi - 1]
    // Words taken out at the start go with the first word found.
    if (qj < m) out[qj] = [newGap === 0 && pj < 0 ? 0 : qi, qi]
    pi = qi
    pj = qj
  }
  return out
}

/** For each word of `nextText`, the words of `wasText` it came from (alignedRanges of their words). */
export function alignedTextRanges(wasText: string, nextText: string, language: string | undefined): [number, number][] {
  return alignedRanges(studioWordTexts(wasText, language), studioWordTexts(nextText, language))
}
