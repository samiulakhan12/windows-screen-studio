/**
 * Listening to one source (docs/design/sound-finder.md §4.2): 16 kHz mono samples arrive in chunks
 * of any size; every window of SCAN.window samples, SCAN.hop apart, is classified once, unless it is
 * quiet or speech, and kept as one byte per score column. The classifier is a callback (YAMNet in
 * the worker, a fake in tests), so this is pure and the chunking never changes the result.
 */
import { mergeRanges, type Range } from './activity'
import { SCAN, SCORE_COLUMNS, SOUND_KINDS, SOUND_KIND_ORDER, SPEECH_CLASSES } from './sounds'

/** All of YAMNet's class scores for one window (index = class). */
export type ClassScores = ArrayLike<number>

/** One byte per score column (SCORE_COLUMNS) from a window's class scores: the highest of each column's classes. */
export function kindBytes(scores: ClassScores, out: Uint8Array = new Uint8Array(SCORE_COLUMNS.length), at = 0): Uint8Array {
  const byte = (classes: readonly number[]): number => {
    let best = 0
    for (const c of classes) {
      const v = scores[c]
      if (v > best) best = v
    }
    return Math.round(Math.min(1, best) * 255)
  }
  out[at] = byte(SPEECH_CLASSES)
  SOUND_KIND_ORDER.forEach((k, i) => (out[at + i + 1] = byte(SOUND_KINDS[k].classes)))
  return out
}

/** Whether `w` is quiet: its loudest SCAN.quietBlock samples are below SCAN.quietDb (RMS, dBFS). */
export function quietWindow(w: Float32Array): boolean {
  const limit = SCAN.quietBlock * 10 ** (SCAN.quietDb / 10)
  for (let a = 0; a < w.length; a += SCAN.quietBlock) {
    const b = Math.min(w.length, a + SCAN.quietBlock)
    let sum = 0
    for (let i = a; i < b; i++) sum += w[i] * w[i]
    // Same threshold for a short last block, scaled to its length.
    if (sum >= (limit * (b - a)) / SCAN.quietBlock) return false
  }
  return true
}

/** Share (0..1) of [start, end) inside the sorted, separate `ranges`, from index `from` on. */
export function speechCover(ranges: readonly Range[], start: number, end: number, from = 0): number {
  let inside = 0
  for (let i = from; i < ranges.length; i++) {
    const r = ranges[i]
    if (r.end <= start) continue
    if (r.start >= end) break
    inside += Math.min(end, r.end) - Math.max(start, r.start)
  }
  return end > start ? inside / (end - start) : 0
}

/** A short hash (FNV-1a, 8 hex digits) of the speech ranges used to skip windows, to the millisecond. */
export function skipKey(ranges: readonly Range[] | null): string {
  if (!ranges || ranges.length === 0) return 'none'
  let h = 0x811c9dc5
  const text = ranges.map((r) => `${Math.round(r.start * 1000)}-${Math.round(r.end * 1000)}`).join(',')
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export interface ScanStats {
  windows: number
  classified: number
  quiet: number
  speech: number
}

/** Windows of one source, classified as the samples arrive. */
export class SoundScanner {
  private buf = new Float32Array(SCAN.window * 4)
  /** Samples in `buf`, and the stream position of buf[0]. */
  private len = 0
  private base = 0
  /** Stream position of the next window's start. */
  private next = 0
  private bytes: Uint8Array = new Uint8Array(1024 * SCORE_COLUMNS.length)
  private n = 0
  private readonly speech: Range[]
  /** The first speech range that ends after the next window's start (windows only move forward). */
  private speechAt = 0
  readonly stats: ScanStats = { windows: 0, classified: 0, quiet: 0, speech: 0 }

  /** `classify` gets a window of exactly SCAN.window samples (a view: copy it to keep it). `skip`: the speech detector's ranges, source seconds. */
  constructor(
    private readonly classify: (window: Float32Array) => ClassScores,
    skip: readonly Range[] | null = null
  ) {
    this.speech = skip ? mergeRanges(skip) : []
  }

  /** Seconds of sound received. */
  get seconds(): number {
    return (this.base + this.len) / SCAN.rate
  }

  /** Adds samples and scores every window they complete. */
  push(samples: Float32Array): void {
    if (this.len + samples.length > this.buf.length) {
      // Drop what no window needs any more, then grow if a large chunk still does not fit.
      const drop = Math.min(this.len, this.next - this.base)
      if (drop > 0) {
        this.buf.copyWithin(0, drop, this.len)
        this.len -= drop
        this.base += drop
      }
      if (this.len + samples.length > this.buf.length) {
        const grown = new Float32Array(Math.max(this.buf.length * 2, this.len + samples.length))
        grown.set(this.buf.subarray(0, this.len))
        this.buf = grown
      }
    }
    this.buf.set(samples, this.len)
    this.len += samples.length
    while (this.next + SCAN.window <= this.base + this.len) this.score(this.buf.subarray(this.next - this.base, this.next - this.base + SCAN.window))
  }

  /** The end of the sound: a last, padded window when enough is left for it. Returns the scores (n × SCORE_COLUMNS bytes). */
  finish(): { n: number; scores: Uint8Array } {
    const total = this.base + this.len
    // Sound after the end of the last window classified (all of it when none was).
    const uncovered = this.n > 0 ? total - (this.next - SCAN.hop + SCAN.window) : total
    if (uncovered >= SCAN.minTail && total - this.next < SCAN.window) {
      const w = new Float32Array(SCAN.window)
      w.set(this.buf.subarray(this.next - this.base, this.len))
      this.score(w)
    }
    return { n: this.n, scores: this.bytes.slice(0, this.n * SCORE_COLUMNS.length) }
  }

  private score(w: Float32Array): void {
    const cols = SCORE_COLUMNS.length
    if ((this.n + 1) * cols > this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2)
      grown.set(this.bytes)
      this.bytes = grown
    }
    const start = this.next / SCAN.rate
    this.stats.windows++
    while (this.speechAt < this.speech.length && this.speech[this.speechAt].end <= start) this.speechAt++
    if (quietWindow(w)) this.stats.quiet++
    else if (this.speechAt < this.speech.length && speechCover(this.speech, start, start + SCAN.window / SCAN.rate, this.speechAt) >= SCAN.speechCover) this.stats.speech++
    else {
      this.stats.classified++
      kindBytes(this.classify(w), this.bytes, this.n * cols)
    }
    this.n++
    this.next += SCAN.hop
  }
}
