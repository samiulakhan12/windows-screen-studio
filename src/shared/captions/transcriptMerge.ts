/**
 * Puts the transcripts of a recording's parts (see transcriptPlan) together: times moved from
 * each part's own clock to source seconds, and each word taken from the one part whose kept
 * window holds its middle (a sentence across a fixed cut is split there: its start from one
 * part, its end from the other). Segments without word times are taken whole by their middle,
 * and those both overlapping parts heard near a fixed cut are kept once.
 */
import type { CaptionSegment, CaptionWord } from '../types'
import type { RawSegment, RawTranscript } from './transcriptParse'
import type { TranscriptPart } from './transcriptPlan'

/** Shortest segment kept, seconds. */
const MIN_LENGTH = 0.05

interface Placed {
  seg: RawSegment
  /** How far the segment's middle is from the edges of the sound its part sent: more is safer. */
  margin: number
}

const round = (t: number): number => Math.round(t * 1000) / 1000

/** Segments of one part in source seconds, those it keeps, clamped to what it sent and to the recording. */
export function placePart(part: TranscriptPart, transcript: RawTranscript, duration: number, last: boolean): Placed[] {
  const lo = Math.max(0, part.start)
  const hi = Math.min(duration, part.end)
  const kept = (a: number, b: number): boolean => {
    const mid = (a + b) / 2
    return mid >= part.keepStart && (mid < part.keepEnd || (last && mid === part.keepEnd))
  }
  const out: Placed[] = []
  for (const s of transcript.segments) {
    const start = Math.min(Math.max(s.start + part.start, lo), hi)
    const end = Math.min(Math.max(s.end + part.start, lo), hi)
    const words = s.words?.map((w) => ({ text: w.text, start: Math.min(Math.max(w.start + part.start, start), end), end: Math.min(Math.max(w.end + part.start, start), end) }))
    let seg: RawSegment
    if (words?.length) {
      const mine = words.filter((w) => kept(w.start, w.end))
      if (!mine.length) continue
      // All its words: as heard (with its punctuation); some: only those, across a fixed cut.
      seg = mine.length === words.length ? { start, end, text: s.text, words } : { start: mine[0].start, end: mine[mine.length - 1].end, text: mine.map((w) => w.text).join(' '), words: mine }
    } else {
      if (!kept(start, end)) continue
      seg = { start, end, text: s.text }
    }
    const mid = (seg.start + seg.end) / 2
    out.push({ seg, margin: Math.min(mid - lo, hi - mid) })
  }
  return out
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
  results.forEach((r, i) => placed.push(...placePart(r.part, r.transcript, duration, i === results.length - 1)))
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
      .map((w) => ({ text: w.text, start: round(w.start), end: round(Math.min(w.end, end)) }))
    segments.push({ id: '', start: round(s.start), end: round(end), text: s.text, ...(words?.length ? { words } : {}) })
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
