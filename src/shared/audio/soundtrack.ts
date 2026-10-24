/**
 * What the preview and the export compute from the recording's measured levels: when it has
 * sound (for ducking the music) and how loud it is (for the preview's normalisation gain).
 * Both call these functions with the same levels, so the music ducks at the same moments.
 */
import type { Clip, Project } from '../types'
import { combineLevels, detectActivity, limitRanges, rangesToOutput, type Range } from './activity'
import { DUCK_TIMING, duckRanges, MAX_DUCK_RANGES, type DuckShape } from './automation'
import { integratedLoudness, normalizeGain, type AudioLevels } from './loudness'
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
 * Ranges (SOURCE seconds) where the recording has sound, or null while the levels of a
 * needed source are not known. Empty when the recording is silent or muted. Independent of
 * the edit's clips, so the preview finds them once per measurement, not on every trim.
 */
export function sourceActivity(project: Omit<SoundProject, 'clips'>, analysis: AudioAnalysis): Range[] | null {
  const sources = activitySources(project)
  if (sources.length === 0) return []
  const levels = sources.map((s) => analysis[s])
  if (levels.some((l) => !l)) return null
  const combined = combineLevels(levels as AudioLevels[])
  return combined ? detectActivity(combined) : []
}

/** sourceActivity on the OUTPUT timeline (through the clips): what the music ducks under. */
export function soundActivity(project: SoundProject, analysis: AudioAnalysis): Range[] | null {
  const ranges = sourceActivity(project, analysis)
  return ranges && rangesToOutput(ranges, project.clips)
}

/**
 * How the music ducks: its shape and the joined ranges (at most MAX_DUCK_RANGES), or null
 * when it does not duck.
 */
export function musicDucking(project: SoundProject, activity: readonly Range[] | null): { shape: DuckShape; ranges: Range[] } | null {
  const music = audioLook(project.audio).music
  if (!music || music.ducking <= 0 || !activity || activity.length === 0) return null
  const shape: DuckShape = { depth: music.ducking, ...DUCK_TIMING }
  return { shape, ranges: limitRanges(duckRanges(activity, shape), MAX_DUCK_RANGES) }
}

/**
 * The recording's levels as heard, before the master volume: the playing sources mixed with
 * their gains (independent sources add up in power). Null when silent or when the levels of
 * a source are missing. Independent of the clips, so the preview mixes them once per
 * measurement and per gain change, not on every trim.
 */
export function heardLevels(project: Omit<SoundProject, 'clips'>, analysis: AudioAnalysis): AudioLevels | null {
  const mix = recordingMix(project)
  if (mix.kind === 'none') return null
  if (mix.kind === 'mix') return analysis.mix ?? null
  const parts: { levels: AudioLevels; gain: number }[] = []
  for (const [k, g] of Object.entries(mix.stems) as [AudioSource, number][]) {
    const levels = analysis[k]
    if (!levels) return null
    parts.push({ levels, gain: g })
  }
  const power = new Float32Array(Math.max(...parts.map((p) => p.levels.power.length)))
  for (const { levels, gain } of parts) for (let i = 0; i < levels.power.length; i++) power[i] += levels.power[i] * gain * gain
  return { window: parts[0].levels.window, power }
}

/**
 * Integrated loudness (LUFS) of `levels` in the edit: kept clips only, each window counted
 * for as long as it lasts in the output. Null when that is silent.
 */
export function editLoudness(levels: AudioLevels, clips: readonly Clip[]): number | null {
  const w = levels.window
  const span = (c: Clip): [number, number] => [Math.max(0, Math.floor(c.start / w)), Math.max(0, Math.ceil(c.end / w))]
  let n = 0
  for (const c of clips) {
    const [from, to] = span(c)
    n += Math.max(0, to - from)
  }
  const power = new Float64Array(n)
  const weight = new Float64Array(n)
  let j = 0
  for (const c of clips) {
    const [from, to] = span(c)
    for (let i = from; i < to; i++, j++) {
      power[j] = levels.power[i] ?? 0
      weight[j] = 1 / c.speed
    }
  }
  return integratedLoudness({ power, weight }, w)
}

/**
 * Integrated loudness (LUFS) of the recording as it is heard in the edit (heardLevels over
 * the kept clips). Null when silent or when levels are missing.
 */
export function recordingLoudness(project: SoundProject, analysis: AudioAnalysis): number | null {
  const levels = heardLevels(project, analysis)
  return levels && editLoudness(levels, project.clips)
}

/** The preview's stand-in for the export's loudness normalisation: one gain to about -16 LUFS. */
export function previewNormalizeGain(project: SoundProject, analysis: AudioAnalysis): number {
  return normalizeGain(recordingLoudness(project, analysis))
}
