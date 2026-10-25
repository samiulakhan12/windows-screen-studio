/**
 * How a recording's sound is sent for transcription: in parts no longer than the provider takes
 * (by length and by upload size), cut in the middle of a quiet stretch when there is one near
 * the end of a part, so no word is cut in two. Where the sound never pauses, parts are cut at
 * fixed points and overlap a little: words cut at the edge of one part are heard whole in the
 * other, and the merge keeps each word from one part only (see transcriptMerge).
 */
import type { Range } from '../audio/activity'

/** One stretch of sound sent on its own (source seconds). */
export interface TranscriptPart {
  index: number
  /** What is sent. */
  start: number
  end: number
  /** What is kept of its result: segments whose middle is in [keepStart, keepEnd). */
  keepStart: number
  keepEnd: number
}

export interface PartOptions {
  /** Longest part, seconds. */
  maxSeconds: number
  /** Overlap of parts cut where there is no pause, seconds. */
  overlap: number
  /** Shortest quiet stretch to cut in, seconds. */
  minSilence: number
  /** A cut is looked for in the last `searchFraction` of a part. */
  searchFraction: number
}

export const PART_DEFAULTS: Omit<PartOptions, 'maxSeconds'> = { overlap: 2, minSilence: 0.3, searchFraction: 0.35 }

/** Quiet stretches of `duration` seconds: what lies between the `active` ranges (sorted). */
export function silencesBetween(active: readonly Range[], duration: number): Range[] {
  const out: Range[] = []
  let at = 0
  for (const r of [...active].sort((a, b) => a.start - b.start)) {
    if (r.start > at) out.push({ start: at, end: Math.min(r.start, duration) })
    at = Math.max(at, r.end)
    if (at >= duration) break
  }
  if (at < duration) out.push({ start: at, end: duration })
  return out.filter((r) => r.end > r.start)
}

/**
 * Seconds of sound that fit in `bytes` at `bitsPerSecond` (with a margin for the container),
 * for a provider's upload limit.
 */
export function secondsForBytes(bytes: number, bitsPerSecond: number): number {
  return Math.floor(((bytes * 0.95 - 4096) * 8) / bitsPerSecond)
}

/**
 * Parts covering [0, duration): cut in the middle of the longest quiet stretch (at least
 * `minSilence` long) in the last part of each window, else at the window's end with `overlap`.
 */
export function planParts(duration: number, silences: readonly Range[], options: Partial<PartOptions> & { maxSeconds: number }): TranscriptPart[] {
  const opts: PartOptions = { ...PART_DEFAULTS, ...options }
  if (!(duration > 0)) return []
  const max = Math.max(opts.maxSeconds, 4 * opts.overlap, 1)
  const quiet = silences.filter((s) => s.end - s.start >= opts.minSilence).sort((a, b) => a.start - b.start)
  // Cuts: [time, overlapped]. A part that starts in an overlap starts half an overlap early.
  const cuts: { t: number; overlapped: boolean }[] = []
  let from = 0
  for (;;) {
    // The part sent must fit, including the half overlap it may start with.
    const lead = cuts.length && cuts[cuts.length - 1].overlapped ? opts.overlap / 2 : 0
    if (duration - from + lead <= max) break
    const latest = from + max - lead
    const earliest = from + (max - lead) * (1 - opts.searchFraction)
    let best: Range | null = null
    for (const s of quiet) {
      const mid = (s.start + s.end) / 2
      if (mid <= earliest || mid >= latest) continue
      if (!best || s.end - s.start > best.end - best.start) best = s
    }
    if (best) cuts.push({ t: (best.start + best.end) / 2, overlapped: false })
    else cuts.push({ t: latest - opts.overlap / 2, overlapped: true })
    from = cuts[cuts.length - 1].t
  }
  const parts: TranscriptPart[] = []
  for (let i = 0; i <= cuts.length; i++) {
    const before = cuts[i - 1]
    const after = cuts[i]
    const keepStart = before ? before.t : 0
    const keepEnd = after ? after.t : duration
    parts.push({
      index: i,
      start: before?.overlapped ? Math.max(0, keepStart - opts.overlap / 2) : keepStart,
      end: after?.overlapped ? Math.min(duration, keepEnd + opts.overlap / 2) : keepEnd,
      keepStart,
      keepEnd
    })
  }
  return parts
}
