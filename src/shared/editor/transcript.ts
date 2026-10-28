/**
 * Edit by text (NW-04, docs/design/edit-by-text.md): the transcript as a list of timed words, and
 * word spans as cuts of the video. Cuts are ordinary clips (cutRange / restoreRange, the timeline's
 * own rules); whether a word is cut is derived from the clips, so a cut made anywhere shows here.
 * Everything is in source seconds.
 */
import { clamp } from '../engine/math'
import { cutRange, MIN_CLIP, normalizeClips } from '../engine/timeline'
import type { CaptionSegment, Clip, Transcript } from '../types'
import { restoreRange } from './clips'
import { rangeSaving, type TimeRange } from './smartSpeed'

export interface TranscriptWord {
  /** Position in the whole transcript. */
  index: number
  /** Id of the caption it belongs to. */
  caption: string
  /** As shown (the caption's text, split on spaces). */
  text: string
  start: number
  end: number
  /** Its times were shared out from its neighbours' (no timed word matched it). */
  estimated: boolean
}

type TimedText = Omit<TranscriptWord, 'index' | 'caption'>

/** A cut reaches at most this far (seconds) into the pause past a cut word. */
export const MAX_REACH = 0.5

const EPS = 1e-9

/** A word compared with another: lower case, NFKC, punctuation and symbols off both ends. */
export const normalizeWord = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')

/** Times shared out over `texts` between `from` and `to`, in proportion to their length. */
function spread(texts: string[], from: number, to: number): TimedText[] {
  const lengths = texts.map((t) => Math.max(1, [...t].length))
  const total = lengths.reduce((s, n) => s + n, 0)
  const span = Math.max(0, to - from)
  let at = from
  return texts.map((text, i) => {
    const start = at
    at += (span * lengths[i]) / total
    return { text, start, end: i === texts.length - 1 ? Math.max(start, to) : at, estimated: true }
  })
}

/** Longest common subsequence of two lists, as matched index pairs in order. */
export function lcsPairs<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean = Object.is): [number, number][] {
  const n = a.length
  const m = b.length
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = same(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (same(a[i], b[j])) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }
  return pairs
}

/**
 * The words of a caption as shown (its text split on spaces), timed by its word timings: the
 * shown words are matched to the timed words (longest common subsequence of their normalised
 * forms, so a fixed typo or an added word keeps the rest exact); unmatched words share the time
 * between their matched neighbours by length and are `estimated`. Times stay inside the caption.
 */
export function alignCaptionWords(seg: CaptionSegment): TimedText[] {
  const texts = seg.text.split(' ').filter(Boolean)
  if (texts.length === 0) return []
  const timed = (seg.words ?? []).filter((w) => w.text.trim())
  if (timed.length === 0) return spread(texts, seg.start, seg.end)
  const keyA = texts.map(normalizeWord)
  const keyB = timed.map((w) => normalizeWord(w.text))
  // Word timings may split a shown word or join two, but most match one to one.
  const pairs = lcsPairs(keyA, keyB, (x, y) => x === y && x !== '')
  const out: TimedText[] = new Array(texts.length)
  const inside = (t: number): number => clamp(t, seg.start, seg.end)
  for (const [i, j] of pairs) {
    const start = inside(timed[j].start)
    out[i] = { text: texts[i], start, end: Math.max(start, inside(timed[j].end)), estimated: false }
  }
  // Runs of unmatched words between matched ones (or the caption's ends).
  let i = 0
  while (i < texts.length) {
    if (out[i]) {
      i++
      continue
    }
    let k = i
    while (k < texts.length && !out[k]) k++
    const from = i > 0 ? out[i - 1].end : seg.start
    const to = k < texts.length ? out[k].start : seg.end
    spread(texts.slice(i, k), from, Math.max(from, to)).forEach((w, n) => (out[i + n] = w))
    i = k
  }
  return out
}

/** Every word of the transcript in order (captions are sorted and never overlap: captionData.ts). */
export function transcriptWords(transcript: Transcript | undefined): TranscriptWord[] {
  const out: TranscriptWord[] = []
  for (const seg of transcript?.segments ?? []) {
    for (const w of alignCaptionWords(seg)) out.push({ ...w, index: out.length, caption: seg.id })
  }
  return out
}

/** For each word, whether it is cut: its middle is in no clip (end-exclusive, like clipIndexAt). One sweep. */
export function cutFlags(words: readonly TranscriptWord[], clips: readonly Clip[]): boolean[] {
  const flags = new Array<boolean>(words.length)
  let c = 0
  for (let i = 0; i < words.length; i++) {
    const mid = (words[i].start + words[i].end) / 2
    while (c < clips.length && clips[c].end <= mid) c++
    flags[i] = !(c < clips.length && clips[c].start <= mid)
  }
  return flags
}

/**
 * The source range cutting words `first..last` removes: each end goes into the pause next to it,
 * to its middle, but at most MAX_REACH past the word (MAX_REACH when there is no neighbour), inside
 * [0, duration]. Spans next to each other meet exactly, so cutting words one by one or together is
 * the same cut, and restoring a span gives back what cutting it removed.
 */
export function wordsRange(words: readonly TranscriptWord[], first: number, last: number, duration: number): TimeRange {
  const a = words[Math.min(first, last)]
  const b = words[Math.max(first, last)]
  const prev = words[a.index - 1]
  const next = words[b.index + 1]
  const before = prev ? Math.min(MAX_REACH, Math.max(0, a.start - prev.end) / 2) : MAX_REACH
  const after = next ? Math.min(MAX_REACH, Math.max(0, next.start - b.end) / 2) : MAX_REACH
  return { start: clamp(a.start - before, 0, duration), end: clamp(b.end + after, 0, duration) }
}

export type WordSpan = readonly [first: number, last: number]

/** The clips with the ranges of these word spans cut (cutRange's rules: no slivers, never the whole video). */
export function cutWords(clips: Clip[], words: readonly TranscriptWord[], spans: readonly WordSpan[], duration: number): Clip[] {
  let out = clips
  for (const [first, last] of spans) {
    if (!words[first] || !words[last]) continue
    const r = wordsRange(words, first, last, duration)
    if (r.end - r.start > EPS) out = cutRange(out, r.start, r.end)
  }
  return out
}

/**
 * The clips with the range of words `first..last` put back (restoreRange: cut parts at 1x, kept
 * parts as they are). A range shorter than a clip may be (MIN_CLIP) grows around its middle, so
 * restoring one short word never leaves a sliver of a clip.
 */
export function restoreWords(clips: Clip[], words: readonly TranscriptWord[], first: number, last: number, duration: number): Clip[] {
  if (!words[first] || !words[last]) return clips
  const r = wordsRange(words, first, last, duration)
  const grow = Math.max(0, MIN_CLIP - (r.end - r.start)) / 2
  let start = r.start - grow
  let end = r.end + grow
  if (start < 0) [start, end] = [0, Math.min(duration, end - start)]
  if (end > duration) [start, end] = [Math.max(0, start - (end - duration)), duration]
  const out = restoreRange(clips, start, end, duration)
  return out === clips ? clips : normalizeClips(out, duration)
}

/** Output seconds cutting these spans saves now (parts already cut save nothing). */
export function spansSaving(clips: readonly Clip[], words: readonly TranscriptWord[], spans: readonly WordSpan[], duration: number): number {
  const ranges = spans.filter(([a, b]) => words[a] && words[b]).map(([a, b]) => wordsRange(words, a, b, duration))
  // Overlapping ranges count once.
  ranges.sort((x, y) => x.start - y.start)
  let saved = 0
  let at = -Infinity
  for (const r of ranges) {
    const start = Math.max(r.start, at)
    if (r.end > start) saved += rangeSaving({ start, end: r.end }, clips, 'cut')
    at = Math.max(at, r.end)
  }
  return saved
}

/** Index of the word being said at source time `t` (start <= t < end), or -1. Binary search. */
export function wordIndexAt(words: readonly TranscriptWord[], t: number): number {
  let lo = 0
  let hi = words.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].start <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  // Zero-length words are skipped back over to the one that holds `t`, if any.
  for (let i = found; i >= 0 && words[i].start <= t; i--) {
    if (t < words[i].end) return i
    if (words[i].end <= words[i].start + EPS) continue
    break
  }
  return -1
}
