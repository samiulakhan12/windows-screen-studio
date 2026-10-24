/**
 * Lines a separately recorded source (a stem) up with the recording's mixed sound, which
 * contains it. Timestamps get the stems close (they start with the mixed sound's recorder),
 * but a recorder's timeline can start at its first video frame rather than its first sound,
 * and mixing at record time adds a little latency; the sound itself says exactly how far
 * apart they are. Coarse search on the level envelopes (robust for tones and speech alike),
 * then a sample-exact search on the signals around it.
 */

export interface AlignOptions {
  /** Seconds of the stem compared (its loudest stretch). */
  window: number
  /** Largest offset searched, seconds either way. */
  maxLag: number
  /** Lowest normalised correlation trusted (the stem may be quiet next to another source in the mix). */
  minScore: number
}

export const ALIGN: AlignOptions = { window: 6, maxLag: 0.25, minScore: 0.3 }

/** Samples per envelope value in the coarse search. */
const BLOCK = 8

/** Mean absolute value per block, with the mean removed (an envelope that correlates like a signal). */
function envelope(s: Float32Array, from: number, to: number): Float32Array {
  const n = Math.max(0, Math.floor((to - from) / BLOCK))
  const env = new Float32Array(n)
  let mean = 0
  for (let b = 0; b < n; b++) {
    let sum = 0
    for (let i = from + b * BLOCK, end = i + BLOCK; i < end; i++) sum += Math.abs(s[i])
    env[b] = sum / BLOCK
    mean += env[b]
  }
  mean /= n || 1
  for (let b = 0; b < n; b++) env[b] -= mean
  return env
}

/** Normalised correlation of a[i] with b[i + lag] over a's whole length. */
function correlation(a: Float32Array, b: Float32Array, lag: number, offset: number): number {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[offset + i + lag]
    ab += x * y
    aa += x * x
    bb += y * y
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
}

/** Start (sample) of the loudest `length`-sample stretch of `s` within [lo, hi), in half-second steps. */
function loudest(s: Float32Array, length: number, lo: number, hi: number, step: number): number {
  let best = lo
  let bestEnergy = -1
  for (let from = lo; from + length <= hi; from += step) {
    let e = 0
    for (let i = from; i < from + length; i++) e += s[i] * s[i]
    if (e > bestEnergy) {
      bestEnergy = e
      best = from
    }
  }
  return best
}

/**
 * How many samples later the stem's sound comes in the mix (mix[i + lag] ~ stem[i]), and how
 * sure that is (normalised correlation), or null when they cannot be matched (silence,
 * too short, or no clear match). Delaying the stem by `lag` samples lines it up.
 */
export function stemLag(stem: Float32Array, mix: Float32Array, rate: number, opts: AlignOptions = ALIGN): { lag: number; score: number } | null {
  const max = Math.round(opts.maxLag * rate)
  const usable = Math.min(stem.length, mix.length) - 2 * max
  const length = Math.min(Math.round(opts.window * rate), usable)
  if (length < rate) return null
  const from = loudest(stem, length, max, Math.min(stem.length, mix.length) - max, Math.round(rate / 2))
  const part = stem.subarray(from, from + length)

  // Coarse: envelopes in blocks, lags in whole blocks.
  const ea = envelope(stem, from, from + length)
  const eb = envelope(mix, from - max, from + length + max)
  const blocks = Math.floor(max / BLOCK)
  let coarse = 0
  let coarseScore = -Infinity
  for (let l = -blocks; l <= blocks; l++) {
    const c = correlation(ea, eb, l, blocks)
    if (c > coarseScore) {
      coarseScore = c
      coarse = l * BLOCK
    }
  }
  // Fine: the signals themselves, within two blocks of the coarse lag.
  let lag = coarse
  let score = -Infinity
  for (let l = Math.max(-max, coarse - 2 * BLOCK); l <= Math.min(max, coarse + 2 * BLOCK); l++) {
    const c = correlation(part, mix, l, from)
    if (c > score) {
      score = c
      lag = l
    }
  }
  // A match at the edge of the search is not a match.
  if (score < opts.minScore || Math.abs(lag) >= max - BLOCK) return null
  return { lag, score }
}
