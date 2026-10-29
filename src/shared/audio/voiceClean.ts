/**
 * Clean voice (docs/design/clean-voice.md): which recorded sound is cleaned of noise, how hard,
 * and the names of the cleaned files. The cleaned file ("the stem") is made once by the main
 * process with ffmpeg's arnndn (an RNNoise network) and then played by the preview and mixed by
 * the export in place of the sound it was made from. Pure.
 */
import type { AudioSettings, Project, VoiceSettings, VoiceStrength } from '../types'
import { audioLook, recordingMix, stemsOf, type RecordingMix, type StemKind } from './settings'

export const VOICE_STRENGTHS: readonly VoiceStrength[] = ['light', 'normal', 'strong']

/** What an older project (or a malformed field) reads as: off, at Normal. */
export const DEFAULT_VOICE: VoiceSettings = { on: false, strength: 'normal' }

export const isVoiceStrength = (v: unknown): v is VoiceStrength => typeof v === 'string' && (VOICE_STRENGTHS as readonly string[]).includes(v)

/** The project's Clean voice setting with defaults applied. */
export function voiceLook(audio: Pick<AudioSettings, 'voice'>): VoiceSettings {
  const v = audio.voice
  if (!v || typeof v !== 'object') return DEFAULT_VOICE
  return { on: v.on === true, strength: isVoiceStrength(v.strength) ? v.strength : DEFAULT_VOICE.strength }
}

/** The recorded sound a stem is made from: the microphone stem, or the mixed track of a recording without stems. */
export type VoiceSource = 'mic' | 'mix'
export const VOICE_SOURCES: readonly VoiceSource[] = ['mic', 'mix']

/** Why there is nothing to clean although the switch could be on (the panel says so). */
export type VoiceUnavailable = 'silent' | 'noMic'

/**
 * Where a voice to clean is (§4.1), whether or not the switch is on: the microphone stem when
 * the recording kept stems and the microphone is heard, the mixed track when it kept none.
 */
export function voiceSourceOf(project: Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>): VoiceSource | VoiceUnavailable {
  if (recordingMix(project).kind === 'none') return 'silent'
  const stems = stemsOf(project)
  if (stems.length === 0) return 'mix'
  const mic = audioLook(project.audio).mic
  return stems.includes('mic') && !mic.muted && mic.volume > 0 ? 'mic' : 'noMic'
}

/** The sound Clean voice replaces in `project`, or null when it is off or there is nothing to clean. */
export function voiceTarget(project: Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>): VoiceSource | null {
  if (!voiceLook(project.audio).on) return null
  const source = voiceSourceOf(project)
  return source === 'mic' || source === 'mix' ? source : null
}

/**
 * `mix` (recordingMix of `project`) as played with a cleaned microphone: the stems, also when
 * their gains would let the mixed track stand in for them (the mixed track holds the original
 * microphone). Anything else is unchanged.
 */
export function withCleanVoice(mix: RecordingMix, project: Pick<Project, 'hasAudio' | 'audioStems' | 'audio'>): RecordingMix {
  if (mix.kind !== 'mix' || voiceTarget(project) !== 'mic') return mix
  const look = audioLook(project.audio)
  const stems: Partial<Record<StemKind, number>> = {}
  for (const k of stemsOf(project)) {
    const gain = look[k].muted ? 0 : look[k].volume
    if (gain > 0) stems[k] = gain
  }
  return { kind: 'stems', volume: mix.volume, stems }
}

/** An RNNoise model file the cleaning uses, pinned by size and SHA-256. */
export interface VoiceModel {
  file: string
  bytes: number
  sha256: string
}

/**
 * The engine: ffmpeg's arnndn with two RNNoise models from rnnoise-models: `somnolent-hogwash`
 * (speech in recording noise: fans, AC, computers) and, for Strong only, `conjoined-burgers`
 * (any sound in recording noise; gentler on speech it does not recognise, so a second pass with it
 * never removes a voice). `version` changes whenever the graph below does, so older stems are made again.
 */
export const VOICE_ENGINE = {
  version: 1,
  models: {
    speech: { file: 'sh.rnnn', bytes: 297646, sha256: '70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0' },
    general: { file: 'cb.rnnn', bytes: 299741, sha256: 'f1357c4e5be9dee8467bead486dfced2d75b640c26ad0b594fa7f102322371d9' }
  }
} as const satisfies { version: number; models: Record<string, VoiceModel> }

export type VoiceModelId = keyof typeof VOICE_ENGINE.models
export const VOICE_MODEL_IDS = Object.keys(VOICE_ENGINE.models) as VoiceModelId[]

/** Sample rate the cleaning works at (RNNoise is trained at 48 kHz). */
export const VOICE_RATE = 48000

/** Samples each arnndn pass delays its output by (one 10 ms frame at 48 kHz), measured. */
export const VOICE_PASS_DELAY = 480

/**
 * The arnndn passes of each strength: the model, and how much of the cleaned sound it keeps (the
 * rest is what it was given). Two passes of the speech model would remove a voice it hears badly
 * (a band-limited or noisy recording), so Strong's second pass uses the general model.
 */
const PASSES: Record<VoiceStrength, { model: VoiceModelId; mix: number }[]> = {
  light: [{ model: 'speech', mix: 0.75 }],
  normal: [{ model: 'speech', mix: 1 }],
  strong: [
    { model: 'speech', mix: 1 },
    { model: 'general', mix: 1 }
  ]
}

export const voicePasses = (strength: VoiceStrength): number => PASSES[strength].length

/**
 * The ffmpeg filter graph that cleans input 0's audio (any channel layout, every channel apart)
 * into [voice]. The sound is padded by the passes' delay first and that much is dropped from the
 * start after, so the cleaned sound lies on the source's own samples and nothing is lost at the
 * end. The sound is placed on its timestamps from 0 (a track that starts late gets silence first),
 * as the export reads the recording (audioPlan recordingGraph). arnndn works in whole 10 ms frames and returns a little more than it was given: mixing the
 * result with the source at weight 0 until the shorter ends cuts it to exactly the source's
 * samples (the weighted sum is the cleaned sound, unchanged).
 */
export function voiceGraph(strength: VoiceStrength): string {
  const passes = PASSES[strength]
  const delay = passes.length * VOICE_PASS_DELAY
  const filters = passes.map((p) => `arnndn=m=${VOICE_ENGINE.models[p.model].file}${p.mix < 1 ? `:mix=${p.mix}` : ''}`)
  const clean = [`apad=pad_len=${delay}`, ...filters, `atrim=start_sample=${delay}`, 'asetpts=PTS-STARTPTS'].join(',')
  return `[0:a:0]aresample=${VOICE_RATE}:async=1:first_pts=0,asplit[src][ref];[src]${clean}[clean];[clean][ref]amix=inputs=2:duration=shortest:normalize=0:weights=1 0[voice]`
}

/** Cleaned files in a project folder: voice-<16 hex digits of their key>.m4a. */
export const VOICE_FILE_RE = /^voice-[0-9a-f]{16}\.m4a$/
const KEY_RE = /^[0-9a-f]{16}$/

/** The cleaned file of `key`. */
export function voiceFileName(key: string): string {
  if (!KEY_RE.test(key)) throw new Error('Invalid voice key')
  return `voice-${key}.m4a`
}

/** Where the cleaned file of `key` is written before it is complete (never served, never kept). */
export const voicePartName = (key: string): string => `${voiceFileName(key).slice(0, -4)}.part.m4a`

/** A part file left behind by a render that was stopped. */
export const VOICE_PART_RE = /^voice-[0-9a-f]{16}\.part\.m4a$/

/**
 * What a stem's key is the hash of: the engine, the strength and the source file as it is now.
 * Any change gives another key, so a stale file is never used.
 */
export function voiceKeyInput(source: VoiceSource, strength: VoiceStrength, file: { size: number; mtimeMs: number }): string {
  const models = VOICE_MODEL_IDS.map((m) => VOICE_ENGINE.models[m].sha256)
  return JSON.stringify({ engine: VOICE_ENGINE.version, models, strength, source, size: file.size, mtime: Math.floor(file.mtimeMs) })
}

/** How many cleaned files a project folder keeps (switching strength and undo then need no new render). */
export const VOICE_KEEP = 3

/** Cleaned files that can go: all but the newest VOICE_KEEP (by modification time), never `current`. */
export function staleVoiceFiles(files: readonly { name: string; mtimeMs: number }[], current: string): string[] {
  const voice = files.filter((f) => VOICE_FILE_RE.test(f.name) && f.name !== current).sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
  return voice.slice(VOICE_KEEP - 1).map((f) => f.name)
}
