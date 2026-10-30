/**
 * Puts the transcripts of a recording's parts (see transcriptPlan) together: times moved from
 * each part's own clock to source seconds, and each word taken from the one part whose kept
 * window holds its middle (a sentence across a fixed cut is split there: its start from one
 * part, its end from the other). The two parts time the words at a fixed cut a little
 * differently, so the earlier part's timing decides there: the later part keeps a word both
 * heard only if the earlier did not, and any other word only if it is after the last word the
 * earlier part kept. Segments without word times are taken whole by their middle, and those
 * both overlapping parts heard near a fixed cut are kept once.
 */
import type { CaptionSegment, CaptionWord } from '../types'
import type { RawSegment, RawTranscript, RawWord } from './transcriptParse'
import type { TranscriptPart } from './transcriptPlan'

/** Shortest segment kept, seconds. */
const MIN_LENGTH = 0.05

interface Placed {
  seg: RawSegment
  /** How far the segment's middle is from the edges of the sound its part sent: more is safer. */
  margin: number
}

/** How a part that starts at a fixed cut keeps the words there (see startAfter). */
interface Start {
  /** Other words are kept if their middle is here or later. */
  from: number
  /** Words the part before also heard: whether this part keeps them. */
  settled: Map<RawWord, boolean>
}

const round = (t: number): number => Math.round(t * 1000) / 1000

/** How far apart, seconds, two parts may time the same word at a fixed cut and still be paired. */
const PAIR_SLACK = 0.5

/** The same word whatever its case and punctuation ("" for none). */
const wordKey = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** Segments of one part in source seconds, clamped to what it sent and to the recording (words to their segment). */
function shiftPart(part: TranscriptPart, transcript: RawTranscript, duration: number): RawSegment[] {
  const lo = Math.max(0, part.start)
  const hi = Math.min(duration, part.end)
  return transcript.segments.map((s) => {
    const start = Math.min(Math.max(s.start + part.start, lo), hi)
    const end = Math.min(Math.max(s.end + part.start, lo), hi)
    const words = s.words?.map((w) => ({ text: w.text, start: Math.min(Math.max(w.start + part.start, start), end), end: Math.min(Math.max(w.end + part.start, start), end), ...(w.estimated ? { estimated: w.estimated } : {}) }))
    return { start, end, text: s.text, ...(words ? { words } : {}), ...(s.speaker ? { speaker: s.speaker } : {}) }
  })
}

/** Of one part's segments (see shiftPart), those it keeps; `begin` settles the words at a fixed cut it starts at. */
export function placePart(part: TranscriptPart, segments: readonly RawSegment[], duration: number, last: boolean, begin?: Start): Placed[] {
  const lo = Math.max(0, part.start)
  const hi = Math.min(duration, part.end)
  // A part cut in a pause sent nothing past keepEnd, so a word clamped onto it was heard here only.
  const closedEnd = last || part.end <= part.keepEnd
  const kept = (a: number, b: number, from: number, settled?: boolean): boolean => {
    const mid = (a + b) / 2
    return (settled ?? mid >= from) && (mid < part.keepEnd || (closedEnd && mid === part.keepEnd))
  }
  const out: Placed[] = []
  for (const s of segments) {
    let seg: RawSegment
    if (s.words?.length) {
      const mine = s.words.filter((w) => kept(w.start, w.end, begin?.from ?? part.keepStart, begin?.settled.get(w)))
      if (!mine.length) continue
      // All its words: as heard (with its punctuation); some: only those, across a fixed cut.
      seg = mine.length === s.words.length ? s : { start: mine[0].start, end: mine[mine.length - 1].end, text: mine.map((w) => w.text).join(' '), words: mine, ...(s.speaker ? { speaker: s.speaker } : {}) }
    } else {
      if (!kept(s.start, s.end, part.keepStart)) continue
      seg = { start: s.start, end: s.end, text: s.text, ...(s.speaker ? { speaker: s.speaker } : {}) }
    }
    const mid = (seg.start + seg.end) / 2
    out.push({ seg, margin: Math.min(mid - lo, hi - mid) })
  }
  return out
}

/**
 * How `part`, which starts at a fixed cut, keeps the words there, decided on the timing of the
 * part before it (`prev`, its segments `heard` and those it `kept`), as each part's own timing
 * could keep a word twice or not at all. A word both heard in the overlap (the same text at
 * times within PAIR_SLACK of each other, paired in order) is kept only if `prev` did not keep it, and any other
 * from a middle after the last word `prev` kept.
 */
function startAfter(prev: TranscriptPart, heard: readonly RawSegment[], kept: readonly Placed[], part: TranscriptPart, segments: readonly RawSegment[]): Start {
  const inOverlap = (segs: readonly RawSegment[]): RawWord[] =>
    segs
      .flatMap((s) => s.words ?? [])
      .filter((w) => w.end >= part.start && w.start <= prev.end)
      .sort((a, b) => a.start - b.start)
  const mine = inOverlap(segments)
  const theirs = new Set(kept.flatMap((p) => p.seg.words ?? []))
  const settled = new Map<RawWord, boolean>()
  let next = 0
  for (const w of inOverlap(heard)) {
    const key = wordKey(w.text)
    const i = key ? mine.findIndex((m, j) => j >= next && m.start <= w.end + PAIR_SLACK && w.start <= m.end + PAIR_SLACK && wordKey(m.text) === key) : -1
    if (i < 0) continue
    settled.set(mine[i], !theirs.has(w))
    next = i + 1
  }
  let lastEnd = -Infinity
  for (const w of theirs) lastEnd = Math.max(lastEnd, w.end)
  return { from: lastEnd >= part.start ? lastEnd : part.keepStart, settled }
}

/**
 * The whole transcript from the parts' results (in plan order). Overlapping segments without
 * word times from neighbouring parts (the same words heard twice around a fixed cut) are kept
 * once, from the part that heard them farther from its edge (segments with words were already
 * split by word); any remaining overlap is trimmed so segments follow one another. Ids are
 * "t1", "t2", ... in time order.
 */
export function mergeParts(results: readonly { part: TranscriptPart; transcript: RawTranscript }[], duration: number): { segments: CaptionSegment[]; language?: string } {
  const placed: Placed[] = []
  let prev: { part: TranscriptPart; heard: RawSegment[]; kept: Placed[] } | undefined
  for (let i = 0; i < results.length; i++) {
    const { part, transcript } = results[i]
    const heard = shiftPart(part, transcript, duration)
    const begin = prev && part.start < part.keepStart ? startAfter(prev.part, prev.heard, prev.kept, part, heard) : undefined
    const own = placePart(part, heard, duration, i === results.length - 1, begin)
    placed.push(...own)
    prev = { part, heard, kept: own }
  }
  placed.sort((a, b) => a.seg.start - b.seg.start || a.seg.end - b.seg.end)
  const kept: Placed[] = []
  for (const p of placed) {
    const prev = kept[kept.length - 1]
    if (prev) {
      const overlap = Math.min(prev.seg.end, p.seg.end) - Math.max(prev.seg.start, p.seg.start)
      const shorter = Math.min(prev.seg.end - prev.seg.start, p.seg.end - p.seg.start)
      if (overlap > 0 && overlap >= shorter / 2 && !(prev.seg.words && p.seg.words)) {
        if (p.margin > prev.margin) kept[kept.length - 1] = p
        continue
      }
    }
    kept.push(p)
  }
  const segments: CaptionSegment[] = []
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i].seg
    const next = kept[i + 1]?.seg
    const end = next ? Math.min(s.end, next.start) : s.end
    if (end - s.start < MIN_LENGTH) continue
    const words: CaptionWord[] | undefined = s.words
      ?.filter((w) => w.start < end)
      .map((w) => ({ text: w.text, start: round(w.start), end: round(Math.min(w.end, end)), ...(w.estimated ? { estimated: w.estimated } : {}) }))
    segments.push({ id: '', start: round(s.start), end: round(end), text: s.text, ...(words?.length ? { words } : {}), ...(s.speaker ? { speaker: s.speaker } : {}) })
  }
  segments.forEach((s, i) => (s.id = `t${i + 1}`))
  const languages = results.map((r) => r.transcript.language).filter((l): l is string => !!l)
  return { segments, ...(languages.length ? { language: mostCommon(languages) } : {}) }
}

function mostCommon(values: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}
