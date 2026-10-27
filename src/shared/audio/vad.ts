/**
 * Speech ranges from the speech detector's probabilities (docs/design/offline-captions.md §3.5):
 * the bundled Silero VAD gives one probability per 32 ms frame (ssw-speech vad), and Silero's
 * own hysteresis turns them into ranges here, so the rule can be tuned without rebuilding the
 * helper and a cached result can be re-read with new constants. Source seconds. Pure.
 * Constants and signatures frozen; bodies by workstream B.
 */
import type { Range } from './activity'

/**
 * Silero's defaults: a frame starts speech at `threshold` and keeps it while at least
 * `negThreshold`; speech shorter than `minSpeech` s is dropped; silences shorter than
 * `minSilence` s are bridged; each range is padded by `pad` s (clamped to the audio).
 */
export const VAD = { threshold: 0.5, negThreshold: 0.35, minSpeech: 0.25, minSilence: 0.1, pad: 0.03, frame: 0.032 } as const

/** Options of speechFromProbs. */
export type VadOptions = { [K in keyof typeof VAD]: number }

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * The probabilities of a `vad` line (base64 of one byte per frame, probability × 255): null when
 * the text is not valid base64 or decodes to more than `maxFrames` bytes.
 */
export function decodeProbs(b64: string, maxFrames: number): Uint8Array | null {
  if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return null
  // Checked before decoding, so a huge line never allocates its bytes.
  const bytes = (b64.length / 4) * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
  if (!(bytes <= maxFrames)) return null
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/** Speech ranges (source seconds, sorted, separate) from per-frame probabilities (byte = p × 255). */
export function speechFromProbs(probs: Uint8Array, opts: Partial<VadOptions> = {}): Range[] {
  const o: VadOptions = { ...VAD, ...opts }
  const total = probs.length * o.frame
  // Silero's hysteresis, frame by frame: [start frame, end frame) of each raw range.
  const raw: [number, number][] = []
  let open = -1
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i] / 255
    if (open < 0) {
      if (p >= o.threshold) open = i
    } else if (p < o.negThreshold) {
      raw.push([open, i])
      open = -1
    }
  }
  if (open >= 0) raw.push([open, probs.length])
  // Short silences are bridged first, then short speech is dropped (Silero's order).
  const joined: Range[] = []
  for (const [a, b] of raw) {
    const r = { start: a * o.frame, end: b * o.frame }
    const prev = joined[joined.length - 1]
    if (prev && r.start - prev.end < o.minSilence - 1e-9) prev.end = r.end
    else joined.push(r)
  }
  const out: Range[] = []
  for (const r of joined) {
    if (r.end - r.start < o.minSpeech - 1e-9) continue
    const start = Math.max(0, r.start - o.pad)
    const end = Math.min(total, r.end + o.pad)
    const prev = out[out.length - 1]
    // Padding can make neighbours touch: they stay separate ranges only when apart.
    if (prev && start <= prev.end) prev.end = Math.max(prev.end, end)
    else out.push({ start: round(start), end: round(end) })
  }
  return out.map((r) => ({ start: round(r.start), end: round(r.end) }))
}

const round = (t: number): number => Math.round(t * 1e4) / 1e4
