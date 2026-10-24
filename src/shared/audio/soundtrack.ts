/**
 * What the preview and the export compute from the recording's measured levels: when it has
 * sound (for ducking the music) and how loud it is (for the preview's normalisation gain).
 * Both call these functions with the same levels, so the music ducks at the same moments.
 */
import type { Project } from '../types'
import { combineLevels, detectActivity, rangesToOutput, type Range } from './activity'
import { DUCK_TIMING, duckRanges, type DuckShape } from './automation'
import { integratedLoudness, normalizeGain, type AudioLevels, type WeightedWindow } from './loudness'
import { activitySources, audioLook, recordingMix, type AudioSource } from './settings'

/** Measured levels per recorded source (only the ones asked for). */
export type AudioAnalysis = Partial<Record<AudioSource, AudioLevels>>

type SoundProject = Pick<Project, 'hasAudio' | 'audioStems' | 'audio' | 'clips'>

/** Sources whose levels these functions need for `project` right now. */
export function analysisSources(project: SoundProject): AudioSource[] {
  const look = audioLook(project.audio)
  const sources = new Set<AudioSource>()
  if (look.music && look.music.volume > 0 && look.music.ducking > 0) for (const s of activitySources(project)) sources.add(s)
  if (look.normalize) {
    const mix = recordingMix(project)
    if (mix.kind === 'mix') sources.add('mix')
    else if (mix.kind === 'stems') for (const k of Object.keys(mix.stems) as AudioSource[]) sources.add(k)
  }
  return [...sources]
}

/**
 * Ranges (OUTPUT seconds) where the recording has sound, or null while the levels of a
 * needed source are not known. Empty when the recording is silent or muted.
 */
export function soundActivity(project: SoundProject, analysis: AudioAnalysis): Range[] | null {
  const sources = activitySources(project)
  if (sources.length === 0) return []
  const levels = sources.map((s) => analysis[s])
  if (levels.some((l) => !l)) return null
  const combined = combineLevels(levels as AudioLevels[])
  return combined ? rangesToOutput(detectActivity(combined), project.clips) : []
}

/** How the music ducks: its shape and the joined ranges, or null when it does not duck. */
export function musicDucking(project: SoundProject, activity: readonly Range[] | null): { shape: DuckShape; ranges: Range[] } | null {
  const music = audioLook(project.audio).music
  if (!music || music.ducking <= 0 || !activity || activity.length === 0) return null
  const shape: DuckShape = { depth: music.ducking, ...DUCK_TIMING }
  return { shape, ranges: duckRanges(activity, shape) }
}

/**
 * Integrated loudness (LUFS) of the recording as it is heard in the edit: the sources mixed
 * with their gains (before the master volume), kept clips only, each window counted for as
 * long as it lasts in the output. Null when silent or when levels are missing.
 */
export function recordingLoudness(project: SoundProject, analysis: AudioAnalysis): number | null {
  const mix = recordingMix(project)
  if (mix.kind === 'none') return null
  const parts: { levels: AudioLevels; gain: number }[] = []
  if (mix.kind === 'mix') {
    if (!analysis.mix) return null
    parts.push({ levels: analysis.mix, gain: 1 })
  } else {
    for (const [k, g] of Object.entries(mix.stems) as [AudioSource, number][]) {
      const levels = analysis[k]
      if (!levels) return null
      parts.push({ levels, gain: g })
    }
  }
  const w = parts[0].levels.window
  const windows: WeightedWindow[] = []
  for (const c of project.clips) {
    const from = Math.max(0, Math.floor(c.start / w))
    const to = Math.ceil(c.end / w)
    for (let i = from; i < to; i++) {
      let power = 0
      // Independent sources add up in power.
      for (const p of parts) power += (p.levels.power[i] ?? 0) * p.gain * p.gain
      windows.push({ power, weight: 1 / c.speed })
    }
  }
  return integratedLoudness(windows, w)
}

/** The preview's stand-in for the export's loudness normalisation: one gain to about -16 LUFS. */
export function previewNormalizeGain(project: SoundProject, analysis: AudioAnalysis): number {
  return normalizeGain(recordingLoudness(project, analysis))
}
