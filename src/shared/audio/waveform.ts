/**
 * The audio waveform on the timeline's clip track (E-04, docs/design/timeline-waveform.md): which
 * sources are drawn and how, the shared reference level, column heights from the measured levels
 * (loudness.ts, 50 ms windows) and the pauses shaded between them. Pure; source time, like every
 * track.
 *
 * Contracts commit: types and constants are final; the functions return "nothing to draw" until
 * E-04 lands (TODO(E-04) below). Nothing calls them yet.
 */
import { SILENCE_LENGTH } from '../editor/smartSpeed'
import type { Project } from '../types'
import type { Range } from './activity'
import type { AudioLevels } from './loudness'
import type { AudioSource } from './settings'

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

/** The lanes drawn for a project: none without sound; the two stems up and down; else one mirrored lane. */
export function waveformLanes(project: Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>): WaveformLane[] {
  // TODO(E-04): stemsOf / audioLook (design §4.1).
  void project
  return []
}

/** The reference level (dB) shared by all lanes, or null when nothing is heard. */
export function waveformRef(levels: readonly AudioLevels[]): number | null {
  // TODO(E-04): the WAVEFORM.percentile power of the loudest source (design §4.2).
  void levels
  return null
}

/** Height 0..1 of a level `db` below the reference `ref` (linear over WAVEFORM.rangeDb). */
export function waveformHeight(db: number, ref: number): number {
  // TODO(E-04): clamp((db − (ref − rangeDb)) / rangeDb, 0, 1).
  void db
  void ref
  return 0
}

/** Heights 0..1 of `columns` columns covering source [from, to). */
export function waveformColumns(levels: AudioLevels, ref: number, from: number, to: number, columns: number): Float32Array {
  // TODO(E-04): the peak per column, interpolated when a column is under half a window (design §4.4).
  void levels
  void ref
  void from
  void to
  return new Float32Array(Math.max(0, Math.floor(columns)))
}

/** The pauses shaded: gaps of the heard activity inside [0, duration], at least `minLength` long. */
export function pauseRanges(activity: readonly Range[], duration: number, minLength: number = WAVEFORM.minPause): Range[] {
  // TODO(E-04): the gaps of mergeRanges(activity) (design §4.5).
  void activity
  void duration
  void minLength
  return []
}
