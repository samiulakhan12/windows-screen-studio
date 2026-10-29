/**
 * Edit by text (NW-04, docs/design/edit-by-text.md): the transcript as a list of timed words, and
 * word spans as cuts of the video. Cuts are ordinary clips (cutRange / restoreRange, the timeline's
 * own rules); whether a word is cut is derived from the clips, so a cut made anywhere shows here.
 * Everything is in source seconds.
 */
import { clamp } from '../engine/math'
import { cutRange, MIN_CLIP, normalizeClips } from '../engine/timeline'
import type { CaptionSegment, CaptionWord, Clip, Transcript } from '../types'
import { restoreRange, timelineGaps } from './clips'
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
  /** Its times were shared out from its neighbours' (no timed word matched it), or are a stored guess. */
  estimated: boolean
  /** A guess deleted in the Transcript tab: cut by its middle like a heard word (cutFlags). */
  deleted?: true
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
 * between their matched neighbours by length and are `estimated`, as are words matched to a stored
 * guess (anchorCutWords), which keep its `deleted` mark. Times stay inside the caption.
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
  const matched = new Map(pairs)
  for (const [i, j] of pairs) {
    const start = inside(timed[j].start)
    const word: TimedText = { text: texts[i], start, end: Math.max(start, inside(timed[j].end)), estimated: timed[j].estimated === true }
    if (timed[j].deleted === true) word.deleted = true
    out[i] = word
  }
  // Runs of unmatched words between matched ones (or the caption's ends). At a caption end, a run
  // that took the place of timed words (retyped) shares their time, not the silence the caption
  // may hold past them; one with no timed words left there (added) reaches the caption's end.
  let i = 0
  while (i < texts.length) {
    if (out[i]) {
      i++
      continue
    }
    let k = i
    while (k < texts.length && !out[k]) k++
    const jPrev = i > 0 ? matched.get(i - 1)! : -1
    const jNext = k < texts.length ? matched.get(k)! : timed.length
    const from = i > 0 ? out[i - 1].end : jNext > 0 ? inside(timed[0].start) : seg.start
    const to = k < texts.length ? out[k].start : jPrev < timed.length - 1 ? inside(timed[timed.length - 1].end) : seg.end
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
 * A caption's words as alignCaptionWords times them, to store as its word timings (one per shown
 * word): a guessed time stays marked `estimated`, and also `deleted` when it was or `deleted(i)`
 * (the i-th word was deleted in the Transcript tab).
 */
export function captionWordTimes(seg: CaptionSegment, deleted: (i: number) => boolean = () => false): CaptionWord[] {
  return alignCaptionWords(seg).map((w, i) => {
    const { text, start, end } = w
    if (!w.estimated) return { text, start, end }
    return w.deleted || deleted(i) ? { text, start, end, estimated: true, deleted: true } : { text, start, end, estimated: true }
  })
}

/**
 * The transcript after a cut made in the Transcript tab (clips `before` to `after`, the word spans
 * `spans` being cut): every guess inside the spans, and every other guess the cut newly cuts (a
 * short word left between two cuts), whose middle is then cut is marked `deleted`, whether or not
 * an earlier cut had already cut its time; its caption's words get their times stored
 * (captionWordTimes, the other guesses still guesses). The deleted words then stay cut, in the tab
 * and out of the subtitle files, when the caption's text or times are edited later, and a later
 * timeline cut still never drops another guess from them. The same object when nothing is marked.
 */
export function anchorCutWords(transcript: Transcript | undefined, before: readonly Clip[], after: readonly Clip[], spans: readonly WordSpan[] = []): Transcript | undefined {
  if (!transcript) return transcript
  const words = transcriptWords(transcript)
  const was = cutFlags(words, before)
  const now = cutFlags(words, after)
  const inSpan = (i: number): boolean => spans.some(([a, b]) => i >= Math.min(a, b) && i <= Math.max(a, b))
  const fresh = (i: number): boolean => words[i].estimated && !words[i].deleted && now[i] && (!was[i] || inSpan(i))
  let changed = false
  let at = 0
  const segments = transcript.segments.map((seg) => {
    // The caption's words are words[from..at) (as many as alignCaptionWords gives it).
    const from = at
    at += seg.text.split(' ').filter(Boolean).length
    for (let i = from; i < at; i++) {
      if (!fresh(i)) continue
      changed = true
      return { ...seg, words: captionWordTimes(seg, (k) => fresh(from + k)) }
    }
    return seg
  })
  return changed ? { ...transcript, segments } : transcript
}

/** Whether two word lists are the same words of the same captions at the same times (stored estimates read back as they were). */
export function sameWords(a: readonly TranscriptWord[], b: readonly TranscriptWord[]): boolean {
  const near = (x: number, y: number): boolean => Math.abs(x - y) < 1e-6
  return a.length === b.length && a.every((w, i) => w.caption === b[i].caption && w.text === b[i].text && near(w.start, b[i].start) && near(w.end, b[i].end))
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
 * parts as they are). Cuts that lie inside the range come back whole first, on their own bounds, so
 * one shorter than MIN_CLIP (a short word between touching ones) joins its neighbours; then the part
 * of a cut inside the words' own range that meets a kept clip joins that clip (a short word at the
 * edge of a longer cut, or at the very start or end). A range shorter than a clip may be grows
 * around its middle, so restoring one short word never leaves a sliver of a clip.
 */
export function restoreWords(clips: Clip[], words: readonly TranscriptWord[], first: number, last: number, duration: number): Clip[] {
  if (!words[first] || !words[last]) return clips
  const r = wordsRange(words, first, last, duration)
  const grow = Math.max(0, MIN_CLIP - (r.end - r.start)) / 2
  let start = r.start - grow
  let end = r.end + grow
  if (start < 0) [start, end] = [0, Math.min(duration, end - start)]
  if (end > duration) [start, end] = [Math.max(0, start - (end - duration)), duration]
  let out = clips
  for (const g of timelineGaps(clips, duration)) {
    if (g.kind === 'cut' && g.start >= start - EPS && g.end <= end + EPS) out = restoreRange(out, g.start, g.end, duration)
  }
  // A part that meets no clip (inside a longer cut) is left to the grown range: alone it could be a sliver.
  for (const g of timelineGaps(out, duration)) {
    const a = Math.max(g.start, r.start)
    const b = Math.min(g.end, r.end)
    const meets = (a <= g.start + EPS && g.kind !== 'trim-start') || (b >= g.end - EPS && g.kind !== 'trim-end')
    if (b - a > EPS && meets) out = restoreRange(out, a, b, duration)
  }
  out = restoreRange(out, start, end, duration)
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
