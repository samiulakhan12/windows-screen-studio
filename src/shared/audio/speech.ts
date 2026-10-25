/**
 * When the person talks, for the camera director (docs/design/camera-director.md, step 4): from
 * the level envelope of the microphone stem (or the mixed track when the recording kept no stem),
 * with keyboard and mouse noise removed, sentence pauses joined and blips dropped; optionally
 * refined by the transcript's word timings. Source seconds throughout. Pure.
 *
 * CONTRACT (workstream B): signatures and constants are frozen; bodies are to be written.
 */
import type { CursorTrack, Project, Transcript } from '../types'
import type { Range } from './activity'
import type { AudioLevels } from './loudness'

/**
 * Speech from levels: sound found by detectActivity (ACTIVITY unchanged); a range at least
 * `noiseShare` inside recorded input (typing bursts padded by `typingPad`, clicks by `clickPad`,
 * keys by `keyPad`) is keyboard or mouse noise and dropped; ranges closer than `join` s are one;
 * shorter than `minUtterance` s are dropped. Transcript words closer than `transcriptGap` s are
 * one range; sound with no word within `transcriptPad` s is not speech. Less than `minTotal` s of
 * speech in all is no talking.
 */
export const SPEECH = {
  noiseShare: 0.8,
  typingPad: 0.3,
  clickPad: 0.15,
  keyPad: 0.15,
  join: 1.0,
  minUtterance: 0.6,
  transcriptGap: 0.3,
  transcriptPad: 0.5,
  minTotal: 2.0
} as const

/** Where the speech ranges came from: the microphone stem, the mixed track, or the transcript alone. */
export type SpeechSource = 'mic' | 'mix' | 'transcript'

/** When the person talks, as the director uses it. */
export interface DirectorSpeech {
  /** Source seconds, sorted, separate. */
  ranges: Range[]
  source: SpeechSource
  /** True when the transcript's words removed sound of the mixed track that was not speech. */
  refined: boolean
}

/**
 * The recorded sound the director listens to: the microphone stem when the recording kept one
 * (stemsOf), else the mixed track when it has sound, else none. The edit's mute and volume are
 * ignored on purpose: a muted microphone still tells when the person talks.
 */
export function speechLevelSource(project: Pick<Project, 'hasAudio' | 'audioStems'>): 'mic' | 'mix' | null {
  return notImplemented(project)
}

/**
 * Speech ranges (source seconds) from a level envelope: activity, minus keyboard and mouse noise
 * (`track`'s typing bursts, clicks and keys; none when `track` is null or not valid), joined
 * and filtered (SPEECH).
 */
export function speechFromLevels(levels: AudioLevels, track: CursorTrack | null): Range[] {
  return notImplemented(levels, track)
}

/**
 * Speech ranges (source seconds) from a transcript: its words (a caption without word timings
 * counts whole), joined across SPEECH.transcriptGap; null without a transcript or captions.
 */
export function transcriptSpeech(transcript: Pick<Transcript, 'segments'> | undefined): Range[] | null {
  return notImplemented(transcript)
}

/**
 * The speech the director uses. With levels of the mixed track and a transcript: the sound near
 * words only (levels within SPEECH.transcriptPad of a word), `refined`. With the microphone
 * stem the levels are used as they are (a clean source; a transcript edited by hand could only
 * remove real speech). Without levels: the transcript alone, joined across SPEECH.join. Null
 * when neither is known.
 */
export function refineSpeech(levels: { source: 'mic' | 'mix'; ranges: readonly Range[] } | null, transcript: Pick<Transcript, 'segments'> | undefined): DirectorSpeech | null {
  return notImplemented(levels, transcript)
}

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
