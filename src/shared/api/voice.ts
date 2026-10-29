/**
 * Clean voice (docs/design/clean-voice.md) between the editor and the main process. The editor
 * names a project, a source and a strength; the main process finds the files, makes the cleaned
 * stem and answers with its file name in the project folder (served by studio-media://). Every
 * channel accepts the app's own page only, and the main process checks every argument.
 */
import type { VoiceStrength } from '../types'
import type { VoiceSource } from '../audio/voiceClean'

export const VOICE_CHANNELS = {
  /** invoke (projectId, source, strength) → VoiceStemStatus */
  status: 'voice:status',
  /**
   * invoke (projectId, source, strength, remake) → the cleaned file's name once made; rejects with a
   * sentence, or VOICE_CANCELLED. `remake` true: the editor could not play the file there, so it is made again.
   */
  prepare: 'voice:prepare',
  /** invoke (projectId) → void, once the project's render has stopped and its part file is gone */
  cancel: 'voice:cancel',
  /** send main → app page: VoiceProgress, at most 4 a second while a stem is made */
  progress: 'voice:progress'
} as const

/** The message a render stopped by Cancel (or by the editor closing) rejects with. */
export const VOICE_CANCELLED = 'Cleaning stopped.'

/** The message a render stopped for a newer request of the same project (another strength) rejects with. */
export const VOICE_REPLACED = 'Cleaning was replaced by a newer request.'

/** Where the stem of a project, source and strength stands in the main process. */
export type VoiceStemStatus =
  | { state: 'ready'; file: string }
  | { state: 'missing' }
  /** Being made: `progress` 0..1. */
  | { state: 'working'; progress: number }

export interface VoiceProgress {
  projectId: string
  source: VoiceSource
  strength: VoiceStrength
  progress: number
}

export interface VoiceApi {
  voiceStatus(projectId: string, source: VoiceSource, strength: VoiceStrength): Promise<VoiceStemStatus>
  prepareVoice(projectId: string, source: VoiceSource, strength: VoiceStrength, remake?: boolean): Promise<string>
  cancelVoice(projectId: string): Promise<void>
  onVoiceProgress(listener: (p: VoiceProgress) => void): () => void
}
