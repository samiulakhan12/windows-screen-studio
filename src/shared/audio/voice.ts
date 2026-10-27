/**
 * What counts as sound once the speech detector has run (docs/design/offline-captions.md §3.6):
 * the voice source (the microphone stem, or the mixed track of a recording without stems)
 * counts where someone speaks, with short tails into the sound around it; the system stem keeps
 * counting any sound; a recording without stems never counts less than before. Used by
 * soundtrack.ts sourceActivity (remove silences, smart speed, music ducking). Source seconds.
 * Pure. Constants and signatures frozen; bodies by workstream C.
 */
import type { Range } from './activity'
import type { AudioAnalysis } from './soundtrack'
import type { Project } from '../types'

/**
 * A speech range is extended into the level-based sound touching it by at most `tail` s after
 * it and `lead` s before it (soft word endings and breaths), never across a gap.
 */
export const VOICE = { tail: 0.3, lead: 0.1 } as const

/**
 * The trust guard: a source whose speech totals less than `minSpeech` s while its level-based
 * sound totals at least `minSound` s is judged by its level instead (a tutorial with typing and
 * no narration is never planned as all silence).
 */
export const VAD_TRUST = { minSpeech: 2.0, minSound: 10.0 } as const

/**
 * Which detector decided what counts as sound, for the hint in the Clip tab:
 * 'speech' every voice source used the speech detector; 'mixed' a recording without stems
 * (speech joined with any sound of the mixed track); 'guard' the trust guard used the level of
 * a source; 'level' the speech detector did not run (today's detector).
 */
export type SoundDetector = 'speech' | 'mixed' | 'guard' | 'level'

/** `speech` extended by VOICE into the `energy` ranges that touch it. */
export function withTails(speech: readonly Range[], energy: readonly Range[]): Range[] {
  void speech
  void energy
  throw new Error('withTails: not implemented yet (workstream C)')
}

/** Sound of a voice source: withTails, joined across ACTIVITY.hold, at least ACTIVITY.minLength long. */
export function speechActivity(speech: readonly Range[], energy: readonly Range[]): Range[] {
  void speech
  void energy
  throw new Error('speechActivity: not implemented yet (workstream C)')
}

/** False when the trust guard applies (VAD_TRUST). */
export function trustSpeech(speech: readonly Range[], energy: readonly Range[]): boolean {
  void speech
  void energy
  throw new Error('trustSpeech: not implemented yet (workstream C)')
}

/** The detector sourceActivity used for `project` with `analysis`; null while levels are missing or without sound. */
export function soundDetector(project: Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>, analysis: AudioAnalysis): SoundDetector | null {
  void project
  void analysis
  throw new Error('soundDetector: not implemented yet (workstream C)')
}
