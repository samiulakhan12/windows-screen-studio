/**
 * The project's sound settings with defaults applied (older projects lack the newer fields),
 * and the decisions the preview and the export share: which recorded files make the
 * recording's sound, with what gains, and what the music does.
 */
import { outputDuration } from '../engine/timeline'
import type { AudioSettings, AudioTrackSettings, MusicSettings, Project } from '../types'

/** The recorded sources: the screen proxy's mixed track, or the separately kept stems. */
export type AudioSource = 'mix' | 'mic' | 'system'
export type StemKind = 'mic' | 'system'
export const STEM_KINDS: readonly StemKind[] = ['mic', 'system']

/** File of each recorded source in the project folder. */
export const SOURCE_FILES: Record<AudioSource, string> = { mix: 'screen.mp4', mic: 'mic.m4a', system: 'system.m4a' }

/** Background music file names a project may hold (see the asset picker). */
export const MUSIC_FILE_RE = /^music\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i

export const DEFAULT_TRACK: AudioTrackSettings = { volume: 1, muted: false }

/** A newly chosen music track: quiet under speech, ducked, looped, faded. */
export const DEFAULT_MUSIC: Omit<MusicSettings, 'path'> = { volume: 0.35, ducking: 0.7, loop: true, fadeIn: 1, fadeOut: 2 }

/** Ranges of the panel's controls (also used to validate export jobs). */
export const AUDIO_LIMITS = {
  volume: { min: 0, max: 2 },
  fade: { min: 0, max: 5 },
  musicFade: { min: 0, max: 10 }
} as const

/** Every sound setting, with the defaults of fields an older project does not have. */
export interface AudioLook {
  volume: number
  muted: boolean
  mic: AudioTrackSettings
  system: AudioTrackSettings
  noiseReduction: number
  normalize: boolean
  fadeIn: number
  fadeOut: number
  music: MusicSettings | null
}

const finiteIn = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

const trackOf = (t: AudioTrackSettings | undefined): AudioTrackSettings => ({
  volume: finiteIn(t?.volume, 0, 2, 1),
  muted: t?.muted === true
})

function musicOf(m: MusicSettings | null | undefined): MusicSettings | null {
  if (!m || typeof m.path !== 'string' || !MUSIC_FILE_RE.test(m.path)) return null
  return {
    path: m.path,
    volume: finiteIn(m.volume, 0, 2, DEFAULT_MUSIC.volume),
    ducking: finiteIn(m.ducking, 0, 1, DEFAULT_MUSIC.ducking),
    loop: m.loop !== false,
    fadeIn: finiteIn(m.fadeIn, 0, AUDIO_LIMITS.musicFade.max, DEFAULT_MUSIC.fadeIn),
    fadeOut: finiteIn(m.fadeOut, 0, AUDIO_LIMITS.musicFade.max, DEFAULT_MUSIC.fadeOut)
  }
}

export function audioLook(audio: AudioSettings): AudioLook {
  return {
    volume: finiteIn(audio.volume, 0, 2, 1),
    muted: audio.muted === true,
    mic: trackOf(audio.mic),
    system: trackOf(audio.system),
    noiseReduction: finiteIn(audio.noiseReduction, 0, 1, 0),
    normalize: audio.normalize === true,
    fadeIn: finiteIn(audio.fadeIn, 0, AUDIO_LIMITS.fade.max, 0),
    fadeOut: finiteIn(audio.fadeOut, 0, AUDIO_LIMITS.fade.max, 0),
    music: musicOf(audio.music)
  }
}

/**
 * Stems the recording kept (none for older projects and recordings without sound). They are
 * only ever kept as a complete set, one per source mixed into the recording's sound, so a
 * source without a stem was not recorded at all: playing the stems loses nothing.
 */
export function stemsOf(project: Pick<Project, 'hasAudio' | 'audioStems'>): StemKind[] {
  if (!project.hasAudio || !project.audioStems) return []
  return STEM_KINDS.filter((k) => project.audioStems?.[k] === true)
}

const trackGain = (t: AudioTrackSettings): number => (t.muted ? 0 : t.volume)

/**
 * What makes the recording's sound:
 * - 'none': silent (no audio, muted, or every source off);
 * - 'mix': the screen proxy's track (mic and system mixed at record time) at `volume`;
 * - 'stems': the separately kept files with their own gains, mixed, then at `volume`.
 * Stems are only used when they change something: a source's own volume or mute, or (for
 * the export) noise reduction, which then cleans the microphone alone. Otherwise the mixed
 * track is exactly their sum, already in the video.
 */
export type RecordingMix =
  | { kind: 'none' }
  | { kind: 'mix'; volume: number }
  | { kind: 'stems'; volume: number; stems: Partial<Record<StemKind, number>> }

export function recordingMix(project: Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>, opts: { denoise?: boolean } = {}): RecordingMix {
  const look = audioLook(project.audio)
  if (!project.hasAudio || look.muted || look.volume <= 0) return { kind: 'none' }
  const stems = stemsOf(project)
  const custom = stems.some((k) => trackGain(look[k]) !== 1)
  const denoiseMic = !!opts.denoise && look.noiseReduction > 0 && stems.includes('mic')
  if (stems.length === 0 || (!custom && !denoiseMic)) return { kind: 'mix', volume: look.volume }
  const gains: Partial<Record<StemKind, number>> = {}
  for (const k of stems) if (trackGain(look[k]) > 0) gains[k] = trackGain(look[k])
  return Object.keys(gains).length > 0 ? { kind: 'stems', volume: look.volume, stems: gains } : { kind: 'none' }
}

/**
 * Sources whose sound counts as "the recording has sound" (music ducks under it): the stems
 * that are heard when the recording kept them, else the mixed track. The same in the preview
 * and the export, whichever files they play.
 */
export function activitySources(project: Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>): AudioSource[] {
  const look = audioLook(project.audio)
  if (!project.hasAudio || look.muted || look.volume <= 0) return []
  const stems = stemsOf(project)
  if (stems.length === 0) return ['mix']
  return stems.filter((k) => trackGain(look[k]) > 0)
}

/** Seconds of the output the music plays: from the start, to the end or until a non-looping track runs out. */
export function musicEnd(outputLength: number, musicLength: number | null, loop: boolean): number {
  if (loop || musicLength === null || !Number.isFinite(musicLength) || musicLength <= 0) return outputLength
  return Math.min(outputLength, musicLength)
}

/** Whether the export has a soundtrack at all (recording, music or click sounds). */
export function hasSoundtrack(project: Project, clickSounds: boolean): boolean {
  const look = audioLook(project.audio)
  return recordingMix(project).kind !== 'none' || (!!look.music && look.music.volume > 0) || clickSounds
}

/**
 * Whether the preview needs its Web Audio graph: per-source gains, music, fades, loudness
 * normalisation or a gain above 100%. Without it the video element plays its own track.
 */
export function needsAudioGraph(project: Project): boolean {
  const look = audioLook(project.audio)
  const mix = recordingMix(project)
  if (look.music && look.music.volume > 0) return true
  if (mix.kind === 'none') return false
  return mix.kind === 'stems' || mix.volume > 1 || look.normalize || look.fadeIn > 0 || look.fadeOut > 0
}

/** Output length of the edit (seconds). */
export const editLength = (project: Pick<Project, 'clips'>): number => outputDuration(project.clips)
