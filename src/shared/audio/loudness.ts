/**
 * Sound levels of the recording, measured the way EBU R128 / ITU-R BS.1770 does it: the
 * signal is K-weighted (a gentle treble boost and a rumble filter, roughly how loud we hear
 * it), squared, and averaged over short windows. One pass over a recording gives a level
 * per window (an "envelope"); everything else (sound activity for ducking, the integrated
 * loudness for the preview's normalisation) is computed from that envelope.
 */

import type { Range } from './activity'

/** Loudness the export normalises to (ffmpeg loudnorm): integrated, true peak and range. */
export const LOUDNESS_TARGET = { integrated: -16, truePeak: -1.5, range: 11 } as const

/** Seconds per envelope value. */
export const LEVEL_WINDOW = 0.05

/** Levels of one audio source: K-weighted power (mean square, channels summed) per window. */
export interface AudioLevels {
  /** Seconds per value (LEVEL_WINDOW). */
  window: number
  /** Window i covers [i * window, (i + 1) * window) of the source. */
  power: Float32Array
  /**
   * Where someone speaks, found by the bundled speech detector (vad.ts; source seconds, sorted,
   * separate). Only on the voice source (the microphone stem, or the mixed track of a recording
   * without stems) and only when the detector ran; absent: the level decides (activity.ts).
   */
  speech?: Range[]
}

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/**
 * The two K-weighting stages of BS.1770 for any sample rate (the standard tabulates them at
 * 48 kHz only): a high shelf (+4 dB above ~1.7 kHz) and a high pass at ~38 Hz, with the
 * analog-prototype design libebur128 (and so ffmpeg's loudnorm) uses; at 48 kHz it gives
 * the standard's coefficients.
 */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  const shelf = (() => {
    const f0 = 1681.974450955533
    const G = 3.999843853973347
    const Q = 0.7071752369554196
    const K = Math.tan((Math.PI * f0) / sampleRate)
    const Vh = 10 ** (G / 20)
    const Vb = Vh ** 0.4996667741545416
    const a0 = 1 + K / Q + K * K
    return {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0
    }
  })()
  const highPass = (() => {
    const f0 = 38.13547087602444
    const Q = 0.5003270373238773
    const K = Math.tan((Math.PI * f0) / sampleRate)
    const a0 = 1 + K / Q + K * K
    return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }
  })()
  return [shelf, highPass]
}

/**
 * Builds an envelope from interleaved float samples pushed in any chunk sizes (a decoder's
 * output as it streams in), so a recording of any length is measured in constant memory.
 */
export class LevelMeter {
  private readonly filters: [Biquad, Biquad]
  /** Filter state per channel: [x1, x2, y1, y2] of stage 1, then of stage 2. */
  private readonly state: Float64Array
  private readonly perWindow: number
  private readonly out: number[] = []
  private sum = 0
  private count = 0
  private channel = 0

  constructor(
    readonly sampleRate: number,
    readonly channels: number,
    readonly window = LEVEL_WINDOW
  ) {
    this.filters = kWeighting(sampleRate)
    this.state = new Float64Array(channels * 8)
    this.perWindow = Math.max(1, Math.round(window * sampleRate))
  }

  push(samples: ArrayLike<number>): void {
    const [f1, f2] = this.filters
    const st = this.state
    for (let i = 0; i < samples.length; i++) {
      const o = this.channel * 8
      const x = samples[i]
      const y1 = f1.b0 * x + f1.b1 * st[o] + f1.b2 * st[o + 1] - f1.a1 * st[o + 2] - f1.a2 * st[o + 3]
      st[o + 1] = st[o]
      st[o] = x
      st[o + 3] = st[o + 2]
      st[o + 2] = y1
      const y2 = f2.b0 * y1 + f2.b1 * st[o + 4] + f2.b2 * st[o + 5] - f2.a1 * st[o + 6] - f2.a2 * st[o + 7]
      st[o + 5] = st[o + 4]
      st[o + 4] = y1
      st[o + 7] = st[o + 6]
      st[o + 6] = y2
      this.sum += y2 * y2
      if (++this.channel === this.channels) {
        this.channel = 0
        if (++this.count === this.perWindow) this.flushWindow()
      }
    }
  }

  private flushWindow(): void {
    this.out.push(this.count > 0 ? this.sum / this.count : 0)
    this.sum = 0
    this.count = 0
  }

  /** The envelope; a last, partly filled window counts when at least half full. */
  finish(): AudioLevels {
    if (this.count >= this.perWindow / 2) this.flushWindow()
    return { window: this.window, power: Float32Array.from(this.out) }
  }
}

/** dB of a power value (-Infinity for silence). */
export const powerDb = (p: number): number => (p > 0 ? 10 * Math.log10(p) : -Infinity)

/** BS.1770 loudness (LUFS) of a K-weighted, channel-summed mean square. */
export const loudnessOf = (power: number): number => -0.691 + powerDb(power)

/**
 * A sequence of windows as heard: the power of each, and how long each lasts in the output
 * (1/speed; all 1 when left out). Typed arrays keep an hours-long edit cheap to measure.
 */
export interface WeightedWindows {
  power: ArrayLike<number>
  weight?: ArrayLike<number>
}

/**
 * Integrated loudness (LUFS) of a sequence of windows, gated like BS.1770-4: 400 ms blocks
 * overlapping by 75%, an absolute gate at -70 LUFS and a relative gate 10 LU below the
 * loudness of the blocks above it, each window weighted by how long it lasts in the
 * output. Null when nothing is above the absolute gate (silence).
 */
export function integratedLoudness({ power, weight }: WeightedWindows, window = LEVEL_WINDOW): number | null {
  const n = power.length
  const per = Math.max(1, Math.round(0.4 / window))
  const step = Math.max(1, Math.round(0.1 / window))
  const size = n < per ? 1 : Math.floor((n - per) / step) + 1
  // Each block's mean power, and how long it lasts in the output (a block of a part played
  // at 2x counts half as much, as if the output itself had been measured).
  const blocks = new Float64Array(size)
  const lasts = new Float64Array(size)
  let count = 0
  const block = (from: number, to: number): void => {
    let p = 0
    let w = 0
    for (let i = from; i < to; i++) {
      const wi = weight ? weight[i] : 1
      p += power[i] * wi
      w += wi
    }
    if (w > 0) {
      blocks[count] = p / w
      lasts[count++] = w
    }
  }
  if (n < per) block(0, n)
  else for (let i = 0; i + per <= n; i += step) block(i, i + per)
  // Mean power of the blocks louder than `min` (LUFS), and how many there are.
  const gated = (min: number): { mean: number; count: number } => {
    const above = 10 ** ((min + 0.691) / 10)
    let sum = 0
    let total = 0
    let k = 0
    for (let i = 0; i < count; i++) {
      if (blocks[i] > above) {
        sum += blocks[i] * lasts[i]
        total += lasts[i]
        k++
      }
    }
    return { mean: total > 0 ? sum / total : 0, count: k }
  }
  const absolute = gated(-70)
  if (absolute.count === 0) return null
  const relative = gated(loudnessOf(absolute.mean) - 10)
  return loudnessOf(relative.count > 0 ? relative.mean : absolute.mean)
}

/** Largest change the preview's normalisation applies, dB (loudnorm's own range is similar). */
export const MAX_NORMALIZE_DB = 30

/** Linear gain that brings `loudness` (LUFS) to the export's target; 1 for silence. */
export function normalizeGain(loudness: number | null, target: number = LOUDNESS_TARGET.integrated): number {
  if (loudness === null || !Number.isFinite(loudness)) return 1
  const db = Math.max(-MAX_NORMALIZE_DB, Math.min(MAX_NORMALIZE_DB, target - loudness))
  return 10 ** (db / 20)
}
