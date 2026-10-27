/**
 * What counts as sound once the speech detector has run (docs/design/offline-captions.md §3.6):
 * the voice source (the microphone stem, or the mixed track of a recording without stems)
 * counts where someone speaks, with short tails into the sound around it; the system stem keeps
 * counting any sound; a recording without stems never counts less than before. Used by
 * soundtrack.ts sourceActivity (remove silences, smart speed, music ducking). Source seconds.
 * Pure. Constants and signatures frozen; bodies by workstream C.
 */
import { ACTIVITY, detectActivity, mergeRanges, type Range } from './activity'
import { activitySources } from './settings'
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
  const sound = mergeRanges(energy)
  const out: Range[] = []
  for (const r of mergeRanges(speech)) {
    let start = r.start
    let end = r.end
    // Only the level-based sound that overlaps or touches this speech, and never past its own
    // edge: energy ranges are separate, so a tail stops at the first gap.
    for (const e of sound) {
      if (e.start > r.end + 1e-9) break
      if (e.end < r.start - 1e-9) continue
      if (e.end > end) end = Math.max(end, Math.min(e.end, r.end + VOICE.tail))
      if (e.start < start) start = Math.min(start, Math.max(e.start, r.start - VOICE.lead))
    }
    out.push({ start: Math.max(0, start), end })
  }
  return mergeRanges(out)
}

/** Sound of a voice source: withTails, joined across ACTIVITY.hold, at least ACTIVITY.minLength long. */
export function speechActivity(speech: readonly Range[], energy: readonly Range[]): Range[] {
  return mergeRanges(withTails(speech, energy), ACTIVITY.hold).filter((r) => r.end - r.start >= ACTIVITY.minLength)
}

const total = (ranges: readonly Range[]): number => ranges.reduce((s, r) => s + Math.max(0, r.end - r.start), 0)

/** False when the trust guard applies (VAD_TRUST). */
export function trustSpeech(speech: readonly Range[], energy: readonly Range[]): boolean {
  return !(total(speech) < VAD_TRUST.minSpeech && total(energy) >= VAD_TRUST.minSound)
}

/** The detector sourceActivity used for `project` with `analysis`; null while levels are missing or without sound. */
export function soundDetector(project: Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>, analysis: AudioAnalysis): SoundDetector | null {
  const sources = activitySources(project)
  if (sources.length === 0) return null
  const levels = sources.map((s) => analysis[s])
  if (levels.some((l) => !l)) return null
  const voiced = sources.map((s, i) => ({ source: s, levels: levels[i]! })).filter((v) => v.levels.speech)
  if (voiced.length === 0) return 'level'
  if (voiced.some((v) => !trustSpeech(v.levels.speech!, detectActivity(v.levels)))) return 'guard'
  return voiced.some((v) => v.source === 'mix') ? 'mixed' : 'speech'
}
