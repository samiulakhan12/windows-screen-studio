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

/**
 * The probabilities of a `vad` line (base64 of one byte per frame, probability × 255): null when
 * the text is not valid base64 or decodes to more than `maxFrames` bytes.
 */
export function decodeProbs(b64: string, maxFrames: number): Uint8Array | null {
  void b64
  void maxFrames
  throw new Error('decodeProbs: not implemented yet (workstream B)')
}

/** Speech ranges (source seconds, sorted, separate) from per-frame probabilities (byte = p × 255). */
export function speechFromProbs(probs: Uint8Array, opts: Partial<VadOptions> = {}): Range[] {
  void probs
  void opts
  throw new Error('speechFromProbs: not implemented yet (workstream B)')
}
