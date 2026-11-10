/**
 * Sound stems (docs/design/output-and-languages.md §7): which WAV files an export writes, their
 * English file words, their exact length, and the one ffmpeg graph that writes them all. Pure.
 *
 * Each stem is a branch of today's soundtrack, built by today's functions from the same inputs
 * (soundtrackParts), so every filter the video's sound applies is applied the same way: Voice and
 * System sound are the recording's graph with that one file, Recording the graph of the mixed track,
 * Music the music's branch, Effects the click, pop, tone and library tracks joined as the mix joins
 * them. Each gets the channel step its branch gets when the mix joins it (STEREO), the soundtrack's
 * own fades, 32-bit float stereo, and exactly the video's length in samples from sample 0. Where the
 * video normalises with loudnorm, the stems carry one fixed gain instead, the one the preview plays
 * (§7.4), so at 1× speed they add up to the preview's mix.
 */
import type { ExportJob, SoundStem, StemJob } from '../api/export'
import { audioLook, STEM_KINDS, stemsOf, type StemKind } from '../audio/settings'
import { previewNormalizeGain, type AudioAnalysis } from '../audio/soundtrack'
import type { Project } from '../types'
import {
  AUDIO_RATE,
  clickPositions,
  EFFECT_JOIN,
  effectTracks,
  fadeFilters,
  musicBranch,
  recordingGraph,
  soundtrackParts,
  STEREO,
  toneTrackGraph,
  type RecordingPart,
  type SoundFiles,
  type StemPart
} from './audioPlan'
import { cursorLook } from './cursorFx'
import type { ExportOptions } from './exportPresets'
import { popJob, toneJob } from './popSound'
import { hasLibrarySounds } from './sfxJob'

/** The word each stem's file is named with, in English in every UI language (§0 decision 10). */
export const STEM_FILE_WORDS: Readonly<Record<SoundStem, string>> = {
  voice: 'Voice',
  system: 'System sound',
  recording: 'Recording',
  music: 'Music',
  effects: 'Effects'
}

/** Every stem, in the order they are listed and written (StemJob.stems). */
export const STEM_ORDER: readonly SoundStem[] = ['voice', 'system', 'recording', 'music', 'effects']

/** The stem a separately recorded file gives. */
const STEM_OF: Readonly<Record<StemKind, SoundStem>> = { mic: 'voice', system: 'system' }

/** The largest fixed gain the stems carry, dB (the preview's own limit, MAX_NORMALIZE_DB). */
export const STEM_GAIN_LIMIT_DB = 30

/** Whether `stem` is cut from the recording (and so carries the fixed gain). */
export const isRecordingStem = (stem: SoundStem): boolean => stem === 'voice' || stem === 'system' || stem === 'recording'

/**
 * The fixed gain of the recording's stems when the video evens out loudness (§7.4):
 * 20·log10(previewNormalizeGain), clamped to ±30 dB. 0 dB when the levels are not known (the preview
 * then plays the recording unchanged too).
 */
export function stemGainDb(project: Parameters<typeof previewNormalizeGain>[0], analysis: AudioAnalysis | null): number {
  const db = 20 * Math.log10(previewNormalizeGain(project, analysis ?? {}))
  return Number.isFinite(db) ? Math.min(STEM_GAIN_LIMIT_DB, Math.max(-STEM_GAIN_LIMIT_DB, db)) : 0
}

/**
 * Whether the project has effects that may sound: click sounds turned on, a graphic's pop or ding,
 * a bleep tone, or a library effect. Clicks need the cursor track, which the project does not hold:
 * main leaves the Effects stem out when nothing sounds in the job (stemsOfJob).
 */
function mayHaveEffects(project: Project): boolean {
  const cursor = cursorLook(project.cursor)
  if (cursor.clickSound && cursor.clickSoundVolume > 0 && project.clips.length > 0) return true
  return popJob(project).length > 0 || toneJob(project).length > 0 || hasLibrarySounds(project)
}

/** The stems an export of `project` with `options` writes, or undefined when it writes none (§7.1, §7.4). */
export function stemJobOf(project: Project, options: ExportOptions, analysis: AudioAnalysis | null): StemJob | undefined {
  if (options.format === 'gif') return undefined
  const look = audioLook(project.audio)
  const stems: SoundStem[] = []
  const gains: Partial<Record<StemKind, number>> = {}
  // The recording, as recordingMix hears it: nothing when it is silent, muted or turned all the way down.
  if (project.hasAudio && !look.muted && look.volume > 0 && project.clips.length > 0) {
    const recorded = stemsOf(project)
    // Without separate files, one stem of screen.mp4's mixed track.
    if (recorded.length === 0) stems.push('recording')
    for (const k of recorded) {
      const gain = look[k].muted ? 0 : look[k].volume
      if (!(gain > 0)) continue
      stems.push(STEM_OF[k])
      if (Math.abs(gain - 1) > 1e-9) gains[k] = gain
    }
  }
  if (look.music && look.music.volume > 0) stems.push('music')
  if (mayHaveEffects(project)) stems.push('effects')
  if (stems.length === 0) return undefined
  const job: StemJob = { stems: STEM_ORDER.filter((s) => stems.includes(s)) }
  if (look.normalize && stems.some(isRecordingStem)) job.gainDb = stemGainDb(project, analysis)
  if (Object.keys(gains).length > 0) job.gains = gains
  return job
}

/** Whether any effect of `job` sounds within `duration` with the files main resolved. */
function effectsSound(job: ExportJob, files: SoundFiles, duration: number): boolean {
  if (job.clicks && job.clicks.volume > 0 && clickPositions(job.clicks.times, duration).length > 0) return true
  if ((job.pops ?? []).some((p) => clickPositions(p.times, duration).length > 0)) return true
  if (job.tones?.length && toneTrackGraph(job.tones, duration, 'tone') !== null) return true
  return (job.effects ?? []).some((e) => e.gain > 0 && !!files.effects?.[e.id] && clickPositions(e.times, duration).length > 0)
}

/**
 * The stems of `job` that have sound with the files main resolved (§7.1), in STEM_ORDER: of the ones
 * `job.stems` asks for, Voice and System sound when the job mixes that separate file at a gain above
 * 0, Recording when it mixes screen.mp4's track (also in place of Voice and System sound whose files
 * went missing: resolveSoundInputs then plays the mixed track, which holds both), Music when it plays,
 * Effects when any of them sounds. A stem that would be silent is not written.
 */
export function stemsOfJob(job: ExportJob, files: SoundFiles): SoundStem[] {
  const asked = new Set(job.stems?.stems ?? [])
  const duration = job.fps > 0 ? job.frames / job.fps : 0
  if (asked.size === 0 || !(duration > 0)) return []
  const out = new Set<SoundStem>()
  const a = job.audio
  if (a && a.clips.length > 0 && a.volume > 0) {
    const separate = a.stems && Object.keys(a.stems).length > 0 ? a.stems : null
    if (separate) {
      for (const k of STEM_KINDS) if (asked.has(STEM_OF[k]) && (separate[k] ?? 0) > 0 && files.stems?.[k]) out.add(STEM_OF[k])
    } else if (files.mix && (asked.has('recording') || asked.has('voice') || asked.has('system'))) out.add('recording')
  }
  if (asked.has('music') && job.music && files.music && job.music.volume > 0) out.add('music')
  if (asked.has('effects') && effectsSound(job, files, duration)) out.add('effects')
  return STEM_ORDER.filter((s) => out.has(s))
}

/** A stem's length in samples at 48 kHz: round(frames / fps × 48000) (§7.3). */
export function stemSamples(frames: number, fps: number): number {
  return Math.round((frames * AUDIO_RATE) / fps)
}

/**
 * The job the stems' sound is resolved from (§7.6), for the stems `only`: `audio.stems` holds the
 * separate files' gains for Voice and System sound (StemJob.gains, absent: 1), also where the video
 * itself mixed screen.mp4's track because the gains were the default; for Recording, the mixed
 * track. Sounds no stem in `only` needs are left out, so their files are not asked for.
 */
export function stemSoundJob(job: ExportJob, only: readonly SoundStem[]): ExportJob {
  const kinds = STEM_KINDS.filter((k) => only.includes(STEM_OF[k]))
  const gainOf = (k: StemKind): number => (job.stems ? (job.stems.gains?.[k] ?? 1) : (job.audio?.stems?.[k] ?? 1))
  let audio = job.audio
  if (audio && kinds.length > 0) audio = { ...audio, stems: Object.fromEntries(kinds.map((k) => [k, gainOf(k)])) }
  else if (audio && only.includes('recording')) {
    const { stems: _separate, ...mixed } = audio
    void _separate
    audio = mixed
  } else audio = undefined
  const effects = only.includes('effects')
  const { audio: _a, music: _m, clicks: _c, pops: _p, tones: _t, effects: _e, ...rest } = job
  void [_a, _m, _c, _p, _t, _e]
  return {
    ...rest,
    ...(audio ? { audio } : {}),
    ...(only.includes('music') && job.music ? { music: job.music } : {}),
    ...(effects && job.clicks ? { clicks: job.clicks } : {}),
    ...(effects && job.pops ? { pops: job.pops } : {}),
    ...(effects && job.tones ? { tones: job.tones } : {}),
    ...(effects && job.effects ? { effects: job.effects } : {}),
    stems: { ...(job.stems ?? {}), stems: STEM_ORDER.filter((s) => only.includes(s)) }
  }
}

/** What follows a stem's branch: the mix's channel step, the soundtrack's fades, float stereo, and exactly `samples` long. */
function stemTail(from: string, to: string, stereo: boolean, fades: string, samples: number): string {
  const chain = [stereo ? STEREO : '', fades, 'aformat=sample_fmts=flt:channel_layouts=stereo', `apad=whole_len=${samples}`, `atrim=end_sample=${samples}`]
  return `[${from}]${chain.filter(Boolean).join(',')}[${to}]`
}

/**
 * One ffmpeg run writing every stem (or only `only`): today's inputs from input `first` on, one
 * branch per stem built by today's functions, one output label each, the stem's own name (§7.2).
 * Inputs only the left-out stems need are not added.
 */
export function stemPlan(job: ExportJob, files: SoundFiles, first: number, only?: readonly SoundStem[]): { args: string[]; graph: string; outputs: { stem: SoundStem; label: string }[] } {
  const wanted = stemsOfJob(job, files).filter((s) => !only || only.includes(s))
  if (wanted.length === 0) return { args: [], graph: '', outputs: [] }
  const kinds = STEM_KINDS.filter((k) => wanted.includes(STEM_OF[k]))
  const recording = wanted.some(isRecordingStem)
  const effects = wanted.includes('effects')
  const separate = job.audio?.stems
  const audio = recording && job.audio ? (separate && kinds.length > 0 ? { ...job.audio, stems: Object.fromEntries(kinds.map((k) => [k, separate[k] ?? 1])) } : job.audio) : undefined
  const parts = soundtrackParts(
    {
      ...job,
      audio,
      music: wanted.includes('music') ? job.music : undefined,
      clicks: effects ? job.clicks : undefined,
      pops: effects ? job.pops : undefined,
      tones: effects ? job.tones : undefined,
      effects: effects ? job.effects : undefined
    },
    files,
    first
  )
  const duration = parts.duration
  const samples = stemSamples(job.frames, job.fps)
  const fades = fadeFilters(duration, job.fadeIn, job.fadeOut)
  const gainDb = job.stems?.gainDb
  // The recording's graph for one stem: the fixed gain where loudnorm sits (§7.4), never loudnorm itself.
  const recordingOf = (stems?: StemPart[]): RecordingPart => {
    const { normalize: _loudnorm, stems: _all, ...rest } = parts.audio!
    void [_loudnorm, _all]
    return { ...rest, ...(stems ? { stems, input: stems[0].input } : {}), ...(gainDb !== undefined ? { gainDb } : {}) }
  }
  const graphs: string[] = []
  for (const stem of wanted) {
    if (stem === 'voice' || stem === 'system') {
      const part = parts.audio!.stems![parts.kinds.indexOf(stem === 'voice' ? 'mic' : 'system')]
      graphs.push(recordingGraph(recordingOf([part]), duration, `${stem}0`), stemTail(`${stem}0`, stem, true, fades, samples))
    } else if (stem === 'recording') {
      graphs.push(recordingGraph(recordingOf(), duration, 'recording0'), stemTail('recording0', stem, true, fades, samples))
    } else if (stem === 'music') {
      // The music's branch makes itself stereo (musicGraph's STEREO, a bed's aformat), as in the mix.
      graphs.push(musicBranch(parts.music!, duration, 'music0'), stemTail('music0', stem, false, fades, samples))
    } else {
      const tracks = effectTracks(parts, duration)
      for (const t of tracks) graphs.push(`${t.track(`${t.label}0`)};[${t.label}0]${EFFECT_JOIN}[${t.label}]`)
      if (tracks.length > 1) {
        graphs.push(`${tracks.map((t) => `[${t.label}]`).join('')}amix=inputs=${tracks.length}:duration=first:dropout_transition=0:normalize=0[effects0]`)
        graphs.push(stemTail('effects0', stem, false, fades, samples))
      } else graphs.push(stemTail(tracks[0].label, stem, false, fades, samples))
    }
  }
  return { args: parts.args, graph: graphs.join(';'), outputs: wanted.map((stem) => ({ stem, label: stem })) }
}
