/**
 * The audio waveform on the timeline's clip track (E-04, docs/design/timeline-waveform.md): which
 * sources are drawn and how, the shared reference level, column heights from the measured levels
 * (loudness.ts, 50 ms windows) and the pauses shaded between them. Pure; source time, like every
 * track.
 */
import { SILENCE_LENGTH } from '../editor/smartSpeed'
import type { Project } from '../types'
import { kthSmallest, mergeRanges, type Range } from './activity'
import { powerDb, type AudioLevels } from './loudness'
import { audioLook, stemsOf, type AudioSource, type StemKind } from './settings'

/** How one recorded source is drawn on the clip track. */
export interface WaveformLane {
  /** 'mix' | 'mic' | 'system' */
  source: AudioSource
  /** 'both': mirrored around the centre line; 'up' (microphone) / 'down' (system) when both stems exist. */
  side: 'both' | 'up' | 'down'
  /** Not heard (its gain or the master gain is 0): drawn grey. */
  muted: boolean
}

export const WAVEFORM = {
  /** dB shown below the reference; quieter is drawn as a hairline. */
  rangeDb: 45,
  /** Reference level: this percentile of the heard windows of the loudest source. */
  percentile: 0.99,
  /** Shortest pause shaded, source seconds (the Silences slider's minimum). */
  minPause: SILENCE_LENGTH.min,
  /** Opacity the waveform keeps inside cuts and trims. */
  gapAlpha: 0.3,
  /** Half-height of the line drawn for silence and while loading, px. */
  hairline: 0.5
} as const

/** Powers at or below this are digital silence (paused or missing audio), as in activityThreshold. */
const SILENT_POWER = 1e-10
/** Slack for times a hair off a boundary in floating point (1.5 / 0.05 is 30.000000000000004). */
const EPS = 1e-9

/** The lanes drawn for a project: none without sound; the two stems up and down; else one mirrored lane. */
export function waveformLanes(project: Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>): WaveformLane[] {
  if (!project.hasAudio) return []
  const look = audioLook(project.audio)
  // Not heard at gain 0, the rule recordingMix and activitySources follow.
  const master = look.muted || look.volume <= 0
  const stems = stemsOf(project)
  if (stems.length === 0) return [{ source: 'mix', side: 'both', muted: master }]
  const lane = (k: StemKind, side: WaveformLane['side']): WaveformLane => ({ source: k, side, muted: master || look[k].muted || look[k].volume <= 0 })
  return stems.length === 2 ? [lane('mic', 'up'), lane('system', 'down')] : [lane(stems[0], 'both')]
}

/** The reference level (dB) shared by all lanes, or null when nothing is heard. */
export function waveformRef(levels: readonly AudioLevels[]): number | null {
  let top = 0
  for (const l of levels) {
    // A copy, since the selection reorders it.
    const heard = new Float64Array(l.power.length)
    let n = 0
    for (const p of l.power) if (p > SILENT_POWER) heard[n++] = p
    if (n > 0) top = Math.max(top, kthSmallest(heard.subarray(0, n), Math.min(n - 1, Math.floor(n * WAVEFORM.percentile))))
  }
  return top > 0 ? powerDb(top) : null
}

/** Height 0..1 of a level `db` below the reference `ref` (linear over WAVEFORM.rangeDb). */
export function waveformHeight(db: number, ref: number): number {
  return Math.min(1, Math.max(0, (db - (ref - WAVEFORM.rangeDb)) / WAVEFORM.rangeDb))
}

/**
 * Heights 0..1 of `columns` columns covering source [from, to). A column at least half a window
 * wide shows the loudest window it covers, so a short word never disappears when zoomed out;
 * narrower ones are interpolated between window centres, so zooming in shows no staircase.
 * Times before 0 and past the measured sound are silent.
 */
export function waveformColumns(levels: AudioLevels, ref: number, from: number, to: number, columns: number): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(columns)))
  const { power, window: w } = levels
  const n = power.length
  if (out.length === 0 || n === 0 || !(w > 0) || !(to > from)) return out
  const d = (to - from) / out.length
  const heightOf = (p: number): number => waveformHeight(powerDb(p), ref)
  if (d >= w / 2) {
    for (let k = 0; k < out.length; k++) {
      const i0 = Math.floor((from + k * d) / w + EPS)
      const i1 = Math.max(i0 + 1, Math.ceil((from + (k + 1) * d) / w - EPS))
      let peak = 0
      for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) if (power[i] > peak) peak = power[i]
      out[k] = heightOf(peak)
    }
    return out
  }
  // Each window's height, worked out once (several columns fall between the same two centres).
  const heights = new Float32Array(n).fill(-1)
  const at = (i: number): number => (heights[i] >= 0 ? heights[i] : (heights[i] = heightOf(power[i])))
  for (let k = 0; k < out.length; k++) {
    const t = from + (k + 0.5) * d
    if (t < 0 || t >= n * w) continue
    // Window i's centre is at (i + 0.5) * w, so t lies between the centres of windows i and i + 1.
    const x = t / w - 0.5
    const i = Math.floor(x)
    out[k] = i < 0 ? at(0) : i >= n - 1 ? at(n - 1) : at(i) + (at(i + 1) - at(i)) * (x - i)
  }
  return out
}

/** The pauses shaded: gaps of the heard activity inside [0, duration], at least `minLength` long. */
export function pauseRanges(activity: readonly Range[], duration: number, minLength: number = WAVEFORM.minPause): Range[] {
  const heard = mergeRanges(activity)
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
    .filter((r) => r.end > r.start)
  // Nothing heard at all (silent or muted): no sound to tell the pauses from, as in findSilences.
  if (heard.length === 0) return []
  const out: Range[] = []
  let at = 0
  for (const r of [...heard, { start: duration, end: duration }]) {
    if (r.start - at >= minLength - EPS) out.push({ start: at, end: r.start })
    at = r.end
  }
  return out
}
