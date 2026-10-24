/**
 * When the recording has sound (someone speaks, the app plays something): found from the
 * level envelope (loudness.ts) with a threshold, a hold and a minimum length, then mapped
 * through the edit's clips onto the output timeline. Background music ducks under these
 * ranges, in the preview and in the export alike.
 */
import { outputDuration } from '../engine/timeline'
import type { Clip } from '../types'
import { powerDb, type AudioLevels } from './loudness'

/** A time range in seconds. */
export interface Range {
  start: number
  end: number
}

export interface ActivityOptions {
  /** Quietest level (dBFS, K-weighted) that ever counts as sound. */
  floorDb: number
  /** The threshold never goes above this, so a recording that is all speech still has activity. */
  ceilingDb: number
  /** The threshold sits this far above the noise floor (the 10th percentile of the levels). */
  marginDb: number
  /** Quieter stretches shorter than this (breaths, pauses between words) keep the sound going, seconds. */
  hold: number
  /** Sounds shorter than this (a click, a pop) are ignored, seconds. */
  minLength: number
}

export const ACTIVITY: ActivityOptions = { floorDb: -50, ceilingDb: -32, marginDb: 12, hold: 0.5, minLength: 0.12 }

/** Sum of several envelopes of the same window size (the sources play together). */
export function combineLevels(levels: readonly AudioLevels[]): AudioLevels | null {
  if (levels.length === 0) return null
  if (levels.length === 1) return levels[0]
  const n = Math.max(...levels.map((l) => l.power.length))
  const power = new Float32Array(n)
  for (const l of levels) for (let i = 0; i < l.power.length; i++) power[i] += l.power[i]
  return { window: levels[0].window, power }
}

/** Level (dB) above which a window counts as sound: just above the noise floor, within limits. */
export function activityThreshold(levels: AudioLevels, opts: ActivityOptions = ACTIVITY): number {
  // Digital silence (below -100 dB: paused or missing audio) says nothing about the noise
  // floor. Powers order like their levels, so the floor is a selection among the powers.
  const heard = new Float64Array(levels.power.length)
  let n = 0
  for (const p of levels.power) if (p > 1e-10) heard[n++] = p
  const floor = n > 0 ? powerDb(kthSmallest(heard.subarray(0, n), Math.floor(n * 0.1))) : -Infinity
  return Math.min(opts.ceilingDb, Math.max(opts.floorDb, floor + opts.marginDb))
}

/**
 * The `k`-th smallest value (0-based) of `values`, which it reorders: a quickselect, linear on
 * average, so an hours-long envelope is not sorted just for one percentile.
 */
export function kthSmallest(values: Float64Array, k: number): number {
  let lo = 0
  let hi = values.length - 1
  while (lo < hi) {
    // Median of three as the pivot keeps sorted and constant input linear.
    const mid = (lo + hi) >> 1
    const pivot = Math.max(Math.min(values[lo], values[mid]), Math.min(Math.max(values[lo], values[mid]), values[hi]))
    let i = lo
    let j = hi
    while (i <= j) {
      while (values[i] < pivot) i++
      while (values[j] > pivot) j--
      if (i <= j) {
        const v = values[i]
        values[i] = values[j]
        values[j] = v
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return values[k]
  }
  return values[k]
}

/** Ranges (source seconds) where the recording has sound. */
export function detectActivity(levels: AudioLevels, opts: ActivityOptions = ACTIVITY): Range[] {
  const threshold = activityThreshold(levels, opts)
  const w = levels.window
  const raw: Range[] = []
  let start = -1
  for (let i = 0; i <= levels.power.length; i++) {
    const on = i < levels.power.length && powerDb(levels.power[i]) >= threshold
    if (on && start < 0) start = i
    else if (!on && start >= 0) {
      raw.push({ start: start * w, end: i * w })
      start = -1
    }
  }
  return mergeRanges(raw, opts.hold).filter((r) => r.end - r.start >= opts.minLength)
}

/** Sorted ranges with those closer than `gap` joined. */
export function mergeRanges(ranges: readonly Range[], gap = 0): Range[] {
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start - last.end <= gap + 1e-9) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

/**
 * `ranges` (source seconds) on the output timeline: only the parts inside kept clips, each
 * shortened or stretched by its clip's speed. Pieces that touch across a cut are joined.
 */
export function rangesToOutput(ranges: readonly Range[], clips: readonly Clip[]): Range[] {
  const sorted = mergeRanges(ranges)
  const out: Range[] = []
  let acc = 0
  for (const c of clips) {
    // Only the ranges that reach into the clip: from the first one ending after its start.
    for (let i = firstEndingAfter(sorted, c.start); i < sorted.length && sorted[i].start < c.end; i++) {
      const r = sorted[i]
      const s = Math.max(r.start, c.start)
      const e = Math.min(r.end, c.end)
      if (e > s) out.push({ start: acc + (s - c.start) / c.speed, end: acc + (e - c.start) / c.speed })
    }
    acc += (c.end - c.start) / c.speed
  }
  const total = outputDuration([...clips])
  return mergeRanges(out, 1e-6).map((r) => ({ start: Math.max(0, r.start), end: Math.min(total, r.end) }))
}

/** Index of the first of sorted, separate `ranges` that ends after `t` (binary search). */
function firstEndingAfter(ranges: readonly Range[], t: number): number {
  let lo = 0
  let hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ranges[mid].end > t) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * At most `max` ranges: when there are more, the closest neighbours are joined (the shortest
 * gaps first, the earlier one of equal gaps first), so the result is the same wherever it is
 * computed and as few pauses as possible are lost.
 */
export function limitRanges(ranges: readonly Range[], max: number): Range[] {
  const sorted = mergeRanges(ranges)
  const keep = Math.max(1, Math.floor(max))
  if (sorted.length <= keep) return sorted
  // Gap i lies before range i + 1.
  const order = Array.from({ length: sorted.length - 1 }, (_, i) => i)
  const gap = (i: number): number => sorted[i + 1].start - sorted[i].end
  order.sort((x, y) => gap(x) - gap(y) || x - y)
  const join = new Uint8Array(sorted.length - 1)
  for (let k = 0; k < sorted.length - keep; k++) join[order[k]] = 1
  const out: Range[] = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    if (join[i - 1]) out[out.length - 1].end = sorted[i].end
    else out.push({ ...sorted[i] })
  }
  return out
}
