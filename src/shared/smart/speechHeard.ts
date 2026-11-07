/**
 * Whether a recording holds words to work from (docs/design/smart-tools.md §7.8 rule 1): Find
 * chapters (part P2), the Guide panel (P1) and Short clips (P3) ask for captions first when speech
 * is heard and there are none, and say "No speech was found" only when there is none. Pure.
 */
import type { AudioLevels } from '../audio/loudness'
import type { AudioSource } from '../audio/settings'
import { speechFromLevels, speechLevelSource } from '../audio/speech'
import type { CursorTrack, Project } from '../types'

/** Seconds of speech heard from which a recording without captions holds speech. */
export const SPEECH_HEARD_S = 10

/**
 * 'captions': the project has captions with words. 'speech': none, but the speech detector's
 * ranges, or without them the activity speechFromLevels finds (keyboard and mouse noise of `track`
 * taken out), add up to 10 s or more. 'none': less, or no sound (no levels, or no sound source).
 */
export function speechHeard(project: Project, levels: Partial<Record<AudioSource, AudioLevels>> | null, track: CursorTrack | null): 'captions' | 'speech' | 'none' {
  if (project.transcript?.segments.some((s) => s.text.trim())) return 'captions'
  if (!levels) return 'none'
  const source = speechLevelSource(project)
  const heard = (source && levels[source]) || levels.mic || levels.mix
  if (!heard) return 'none'
  const total = speechFromLevels(heard, track).reduce((n, r) => n + (r.end - r.start), 0)
  return total >= SPEECH_HEARD_S - 1e-9 ? 'speech' : 'none'
}
