/**
 * Edit by text (NW-04, docs/design/edit-by-text.md): the transcript as a list of timed words, and
 * word spans as cuts of the video. Cuts are ordinary clips (cutRange / restoreRange, the timeline's
 * own rules); whether a word is cut is derived from the clips, so a cut made anywhere shows here
 * (a word whose time is a guess only when it is surely cut, or was deleted here: cutFlags).
 * Everything is in source seconds.
 */
import { clamp } from '../engine/math'
import { clipIndexAt, cutRange, MIN_CLIP, normalizeClips } from '../engine/timeline'
import type { CaptionSegment, CaptionWord, Clip, Project, Transcript } from '../types'
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
  /** Deleted in the Transcript tab: cut by its middle, a guess too (cutFlags), and timed as stored even outside its caption (alignCaptionWords). */
  deleted?: true
  /** Its caption's own time (captionsWords gives it; else taken as its caption's words' time): what is left of the caption (cutFlags). */
  captionTime?: TimeRange
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

/**
 * Longest common subsequence of two lists, as matched index pairs in order: of the longest ones,
 * the one with the fewest pairs `avoid` gives, then the one matching earliest.
 */
export function lcsPairs<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean = Object.is, avoid: (i: number, j: number) => boolean = () => false): [number, number][] {
  const n = a.length
  const m = b.length
  // A pair scores more than all the pairs avoided can take off, so length comes first.
  const unit = Math.min(n, m) + 1
  const score = (i: number, j: number): number => (avoid(i, j) ? unit - 1 : unit)
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skip = Math.max(table[i + 1][j], table[i][j + 1])
      table[i][j] = same(a[i], b[j]) ? Math.max(skip, table[i + 1][j + 1] + score(i, j)) : skip
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (same(a[i], b[j]) && table[i][j] === table[i + 1][j + 1] + score(i, j)) {
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
 * forms, so a fixed typo or an added word keeps the rest exact; a word with nothing left once
 * normalised, such as a dash, matches only the same text); unmatched words share the time between
 * their matched neighbours by length and are `estimated`, as are words matched to a stored guess
 * (anchorCutWords). A `deleted` mark comes with its stored word, and of the longest matchings the
 * one pairing the fewest shown words with deleted ones is taken: when the text loses one of two
 * equal words, the one left is the take still in the video. Times stay inside the caption, but a
 * deleted word keeps its own (in the cut, where a trim of the caption left it: retimeWords).
 */
export function alignCaptionWords(seg: CaptionSegment): TimedText[] {
  const texts = seg.text.split(' ').filter(Boolean)
  if (texts.length === 0) return []
  const timed = (seg.words ?? []).filter((w) => w.text.trim())
  if (timed.length === 0) return spread(texts, seg.start, seg.end)
  const keyOf = (text: string): string => normalizeWord(text) || `\u0000${text.trim()}`
  const keyA = texts.map(keyOf)
  const keyB = timed.map((w) => keyOf(w.text))
  // Word timings may split a shown word or join two, but most match one to one.
  const pairs = lcsPairs(keyA, keyB, (x, y) => x === y, (_, j) => timed[j].deleted === true)
  const out: TimedText[] = new Array(texts.length)
  const inside = (t: number): number => clamp(t, seg.start, seg.end)
  const matched = new Map(pairs)
  for (const [i, j] of pairs) {
    const w = timed[j]
    const own = (t: number): number => (w.deleted === true ? t : inside(t))
    const start = own(w.start)
    const word: TimedText = { text: texts[i], start, end: Math.max(start, own(w.end)), estimated: w.estimated === true }
    if (w.deleted === true) word.deleted = true
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
    const from = i > 0 ? inside(out[i - 1].end) : jNext > 0 ? inside(timed[0].start) : seg.start
    const to = k < texts.length ? inside(out[k].start) : jPrev < timed.length - 1 ? inside(timed[timed.length - 1].end) : seg.end
    spread(texts.slice(i, k), from, Math.max(from, to)).forEach((w, n) => (out[i + n] = w))
    i = k
  }
  return out
}

/** Every word of the transcript in order (captions are sorted and never overlap: captionData.ts). */
export function transcriptWords(transcript: Transcript | undefined): TranscriptWord[] {
  return captionsWords(transcript?.segments ?? [])
}

/** Every word of these captions in order, as transcriptWords gives them. */
export function captionsWords(segments: readonly CaptionSegment[]): TranscriptWord[] {
  const out: TranscriptWord[] = []
  for (const seg of segments) {
    const captionTime = { start: seg.start, end: seg.end }
    for (const w of alignCaptionWords(seg)) out.push({ ...w, index: out.length, caption: seg.id, captionTime })
  }
  return out
}

/**
 * For each word, whether its middle is in no clip (end-exclusive, like clipIndexAt), whether its time
 * is heard or a guess (cutFlags is what the tab shows). One sweep.
 */
export function middlesCut(words: readonly TranscriptWord[], clips: readonly Clip[]): boolean[] {
  const flags = new Array<boolean>(words.length)
  let c = 0
  let last = -Infinity
  for (let i = 0; i < words.length; i++) {
    const mid = (words[i].start + words[i].end) / 2
    // A deleted word left outside its trimmed caption can come before the words ahead of it.
    if (mid < last) c = clipFrom(clips, mid)
    last = mid
    while (c < clips.length && clips[c].end <= mid) c++
    flags[i] = !(c < clips.length && clips[c].start <= mid)
  }
  return flags
}

/** The first clip that ends after `t` (clips sorted, end-exclusive), or clips.length. Binary search. */
function clipFrom(clips: readonly Clip[], t: number): number {
  let lo = 0
  let hi = clips.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (clips[mid].end <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Whether a clip keeps any of the time between `from` and `to` (one that only touches it keeps none). */
function keepsAny(clips: readonly Clip[], from: number, to: number): boolean {
  const c = clipFrom(clips, from)
  return c < clips.length && clips[c].start < to
}

/** Output seconds the clips keep of the time between `from` and `to`. */
function keptOutput(clips: readonly Clip[], from: number, to: number): number {
  let out = 0
  for (let c = clipFrom(clips, from); c < clips.length && clips[c].start < to; c++) out += (Math.min(to, clips[c].end) - Math.max(from, clips[c].start)) / clips[c].speed
  return out
}

/** Shortest cue the subtitle files keep, output seconds: what is left of a caption mostly cut away is left out (cutFlags, outputCues). */
export const MIN_CUE = 0.05

/**
 * For each word, whether it is cut (docs/design/edit-by-text.md §4.2), the one rule of the Transcript
 * tab and the subtitle files (outputCues). A word with a heard time (not `estimated`), or a word
 * `deleted` in the tab, is cut when its middle is in no clip. Any other guess is cut only when it is
 * surely cut: its middle is in no clip and no clip keeps any of the time between the middles of the
 * nearest heard words before and after it in its caption (the caption's first start or last end
 * where there is none), so a guess never takes out a word that may still be heard. Every word of a
 * caption that a cut has reached (a middle cut) and whose own time (`captionTime`) the clips keep
 * less than MIN_CUE of is cut: the subtitle files leave out such a sliver.
 */
export function cutFlags(words: readonly TranscriptWord[], clips: readonly Clip[]): boolean[] {
  const middles = middlesCut(words, clips)
  const flags = middles.slice()
  const mid = (w: TranscriptWord): number => (w.start + w.end) / 2
  const heard = (w: TranscriptWord): boolean => !w.estimated
  const before = new Array<number>(words.length)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const prev = words[i - 1]
    before[i] = !prev || prev.caption !== w.caption ? w.start : heard(prev) ? mid(prev) : before[i - 1]
  }
  let after = 0
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]
    const next = words[i + 1]
    after = !next || next.caption !== w.caption ? w.end : heard(next) ? mid(next) : after
    if (flags[i] && w.estimated && !w.deleted) flags[i] = !keepsAny(clips, Math.min(before[i], after), Math.max(before[i], after))
  }
  // The words of each caption are words[a..b).
  for (let a = 0, b = 0; a < words.length; a = b) {
    let from = words[a].start
    let to = words[a].end
    let reached = middles[a]
    for (b = a + 1; b < words.length && words[b].caption === words[a].caption; b++) {
      from = Math.min(from, words[b].start)
      to = Math.max(to, words[b].end)
      reached ||= middles[b]
    }
    const time = words[a].captionTime ?? { start: from, end: to }
    if (reached && keptOutput(clips, time.start, time.end) < MIN_CUE) flags.fill(true, a, b)
  }
  return flags
}

/**
 * A caption's words as alignCaptionWords times them, to store as its word timings (one per shown
 * word): a guessed time stays marked `estimated`, and a word stays marked `deleted` when it was,
 * or gets the mark when `deleted(i)` (the i-th word was deleted in the Transcript tab).
 */
export function captionWordTimes(seg: CaptionSegment, deleted: (i: number) => boolean = () => false): CaptionWord[] {
  return alignCaptionWords(seg).map((w, i) => {
    const { text, start, end } = w
    const mark = w.deleted === true || deleted(i)
    if (!w.estimated) return mark ? { text, start, end, deleted: true } : { text, start, end }
    return mark ? { text, start, end, estimated: true, deleted: true } : { text, start, end, estimated: true }
  })
}

/**
 * The transcript after a cut made in the Transcript tab (clips `before` to `after`, the word spans
 * `spans` being cut): every word inside the spans, and every other word the cut newly cuts (a
 * short word left between two cuts), whose middle is then cut is marked `deleted`, heard or a
 * guess, whether or not an earlier cut had already cut its time; its caption's words get their
 * times stored (captionWordTimes, the other guesses still guesses). The deleted words then stay
 * cut, in the tab and out of the subtitle files (cutFlags), when the caption's text or times are
 * edited later (and the text keeps the take still in the video when it loses one of two equal
 * words: alignCaptionWords), and a later timeline cut still never drops another guess. The same
 * object when nothing is marked.
 */
export function anchorCutWords(transcript: Transcript | undefined, before: readonly Clip[], after: readonly Clip[], spans: readonly WordSpan[] = []): Transcript | undefined {
  if (!transcript) return transcript
  const words = transcriptWords(transcript)
  const was = middlesCut(words, before)
  const now = middlesCut(words, after)
  const inSpan = (i: number): boolean => spans.some(([a, b]) => i >= Math.min(a, b) && i <= Math.max(a, b))
  const fresh = (i: number): boolean => !words[i].deleted && now[i] && (!was[i] || inSpan(i))
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

/**
 * The project after an edit (`prev` before it) with the `deleted` mark taken off every stored word
 * whose middle is in a clip: a mark lives only while its word is cut (edit-by-text.md §4.2), so a
 * word brought back (Restore, Restore the whole recording, the timeline, a caption moved) is not
 * deleted any more, and a guess is a guess again, which a later cut over its guessed time cannot
 * take out. The editor store's `settle`: part of the edit's own undo step. The same object when
 * nothing changes.
 */
export function settleDeletedWords(next: Project, prev: Project): Project {
  if (!next.transcript || (next.clips === prev.clips && next.transcript === prev.transcript)) return next
  const clips = next.clips
  // The word's middle as alignCaptionWords times a deleted word (its own time).
  const restored = (w: CaptionWord): boolean => w.deleted === true && clipIndexAt(clips, (w.start + Math.max(w.start, w.end)) / 2) >= 0
  let changed = false
  const segments = next.transcript.segments.map((seg) => {
    if (!seg.words?.some(restored)) return seg
    changed = true
    return { ...seg, words: seg.words.map((w) => (restored(w) ? { text: w.text, start: w.start, end: w.end, ...(w.estimated ? { estimated: w.estimated } : {}) } : w)) }
  })
  return changed ? { ...next, transcript: { ...next.transcript, segments } } : next
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
