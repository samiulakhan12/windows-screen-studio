/** The words of Clean voice (docs/design/clean-voice.md §5), shared by the Audio panel, the export and the tests. */
import type { VoiceStrength } from '../types'

export const VOICE_COPY = {
  section: 'Voice',
  toggle: 'Clean voice',
  intro: 'Removes fan hum, keyboard and mouse clicks and room noise from your voice, on this PC. The preview plays the result.',
  mixed: "This recording keeps your microphone and the PC's sound together, so both are cleaned.",
  silent: 'The recording is silent, so there is no voice to clean.',
  noMic: 'The microphone is muted or was not recorded, so there is no voice to clean.',
  strength: 'Strength',
  checking: 'Checking your voice…',
  cleaning: 'Cleaning your voice…',
  working: (percent: number): string => `Cleaning your voice… ${percent}%`,
  cancel: 'Cancel',
  ready: 'Your voice is clean. The preview and the export use it.',
  original: 'Hear the original',
  playingOriginal: 'Playing the original voice. The export stays clean.',
  stopped: 'Cleaning stopped. The preview plays the original voice, and the export cleans it first.',
  cleanNow: 'Clean now',
  failed: 'Your voice could not be cleaned.',
  tryAgain: 'Try again',
  /** Reasons the main process gives. */
  missingMic: 'The microphone file of this recording is missing.',
  missingMix: "The recording's sound file is missing.",
  tooLong: 'Cleaning took too long and was stopped.',
  engine: 'ffmpeg could not clean the sound.',
  damagedModel: 'The noise model of this app is damaged. Install Flown again.'
} as const

export const STRENGTH_NAMES: Record<VoiceStrength, string> = { light: 'Light', normal: 'Normal', strong: 'Strong' }

export const STRENGTH_HINTS: Record<VoiceStrength, string> = {
  light: 'Softens the noise and keeps some of the room.',
  normal: 'Removes most noise. Right for most recordings.',
  strong: 'Removes as much as it can. Quiet words can sound thin.'
}
