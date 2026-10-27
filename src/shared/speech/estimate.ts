/**
 * How long captions on this PC take, and the words the UI uses for times and sizes
 * (docs/design/offline-captions.md §3.3, §7). Pure. Constants and signatures frozen;
 * threadFactor and estimateSeconds are real code (the main process limits a part's run time
 * with them); the other bodies are workstream C's.
 */
import type { SpeechModelSpec } from './catalog'

/**
 * Processing time with n threads relative to 4 threads, measured with Whisper base on the
 * reference PC (1 thread RTF 0.247, 2 threads 0.137, 4 threads 0.077; 3 interpolated). Above 4,
 * (4 / n) ^ 0.7, never below 0.6.
 */
export const THREAD_SPEED: Readonly<Record<1 | 2 | 3 | 4, number>> = { 1: 3.21, 2: 1.78, 3: 1.27, 4: 1.0 }

/** Windows (measured under wine: Whisper base RTF 0.105 against 0.079 on Linux) until this PC has measured itself. */
export const WINDOWS_FACTOR = 1.3

/**
 * The compatible build (no AVX2, FMA or F16C: every SIMD extension off) until this PC has
 * measured itself: expected about 4.3 times slower (the unforced cross build measured 25.7 s
 * against 6.0 s for tiny.en under wine).
 */
export const COMPAT_FACTOR = 4.3

/** A time left is shown once this share is done or this many seconds have passed. */
export const TIME_LEFT = { minFraction: 0.1, minSeconds: 15, smoothing: 0.3, minRise: 30 } as const

/** threadFactor(n): processing time with n threads relative to 4 (THREAD_SPEED); n is floored and at least 1. */
export function threadFactor(threads: number): number {
  const n = Number.isFinite(threads) ? Math.max(1, Math.floor(threads)) : 1
  if (n <= 4) return THREAD_SPEED[n as 1 | 2 | 3 | 4]
  return Math.max(0.6, (4 / n) ** 0.7)
}

/**
 * Seconds to transcribe `audioSeconds` with `spec` on `threads` threads. With `measured` (this
 * PC's RTF at its thread count, which already includes its build and Windows): audio × measured
 * RTF, scaled from its thread count to `threads`. Without: audio × the catalog's rtf4 × thread
 * factor × WINDOWS_FACTOR, × COMPAT_FACTOR when `build` is 'compatible'.
 */
export function estimateSeconds(
  spec: Pick<SpeechModelSpec, 'rtf4'>,
  audioSeconds: number,
  threads: number,
  measured?: { rtf: number; threads: number } | null,
  build?: 'standard' | 'compatible' | 'host' | null
): number {
  const audio = Number.isFinite(audioSeconds) ? Math.max(0, audioSeconds) : 0
  if (measured && Number.isFinite(measured.rtf) && measured.rtf > 0) return (audio * measured.rtf * threadFactor(threads)) / threadFactor(measured.threads)
  return audio * spec.rtf4 * threadFactor(threads) * WINDOWS_FACTOR * (build === 'compatible' ? COMPAT_FACTOR : 1)
}

/**
 * The time left of a running job, smoothed: null before TIME_LEFT.minFraction is done and
 * TIME_LEFT.minSeconds have passed; elapsed × (1 − f) / f blended with `prev`
 * (TIME_LEFT.smoothing); it never goes up by less than TIME_LEFT.minRise seconds (no jitter).
 */
export function nextTimeLeft(prev: number | null, elapsedSeconds: number, fraction: number): number | null {
  void prev
  void elapsedSeconds
  void fraction
  throw new Error('nextTimeLeft: not implemented yet (workstream C)')
}

/** "under 1 min", "about 1½ min" (half minutes up to 3 min), "about 38 min", "about 1 h 10 min" (whole minutes, rounded up). */
export function durationWords(seconds: number): string {
  void seconds
  throw new Error('durationWords: not implemented yet (workstream C)')
}

/** Decimal megabytes as Flown shows sizes: "44 MB", "574 MB", "1.2 GB". */
export function sizeWords(bytes: number): string {
  void bytes
  throw new Error('sizeWords: not implemented yet (workstream C)')
}
