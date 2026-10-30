/**
 * Every sentence of the unwanted-sound finder (docs/design/sound-finder.md §5), kept together so the
 * panel, the controller and the tests agree.
 */
import { formatTime } from '../engine/project'
import type { SoundKind } from './sounds'

export const SOUND_LABELS: Readonly<Record<SoundKind, string>> = {
  cough: 'Cough',
  sneeze: 'Sneeze',
  typing: 'Typing',
  ping: 'Notification sound',
  phone: 'Phone',
  dog: 'Dog',
  door: 'Knock or door',
  music: 'Background music'
}

export const SOUNDS_COPY = {
  title: 'Unwanted sounds',
  intro: 'Finds coughs, sneezes, typing, notification sounds, phones, dogs, knocks and background music, on this PC. Speech is never listed.',
  noSound: 'This recording has no sound.',
  find: 'Find unwanted sounds',
  checking: 'Looking for sounds found before…',
  cancel: 'Cancel',
  tryAgain: 'Try again',
  failed: 'Could not listen to the recording:',
  workerFailed: 'The sound finder could not run:',
  none: 'No unwanted sounds found.',
  muteAll: 'Mute all',
  muteTitle: 'Silence it, with short fades',
  duckTitle: 'Make it much quieter',
  cutTitle: 'Cut it out of the video',
  ignoreTitle: 'Keep it and take it off the list',
  restoreTitle: 'Hear it as recorded again',
  bringBackTitle: 'Put it back on the list',
  wholeVideo: 'That would cut the whole video',
  restoreCutFailed: 'Use Undo to bring this back',
  states: { muted: 'Muted', ducked: 'Lowered', cut: 'Cut', ignored: 'Ignored' }
} as const

/** "Listening to the recording… 42%". */
export const listeningText = (progress: number): string => `Listening to the recording… ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`

/** "3 found. Nothing changes until you choose." */
export const foundText = (n: number): string => `${n} found. Nothing changes until you choose.`

/** "Show ignored (2)". */
export const showIgnoredText = (n: number): string => `Show ignored (${n})`

/** "0.4 s" (a tenth of a second at least). */
export const lengthText = (seconds: number): string => `${Math.max(0.1, Math.round(seconds * 10) / 10).toFixed(1)} s`

/** The row's name in sentences: "the cough at 0:12.4". */
export const rowName = (kind: SoundKind, outputTime: number): string => `the ${SOUND_LABELS[kind].toLowerCase()} at ${formatTime(outputTime)}`

/** What the live region says after an action. */
export const actionText = {
  mute: (name: string): string => `Muted ${name}`,
  duck: (name: string): string => `Lowered ${name}`,
  cut: (seconds: number): string => `Cut ${lengthText(seconds)}`,
  ignore: (name: string): string => `Ignored ${name}`,
  restore: (name: string): string => `Restored ${name}`,
  bringBack: (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)} is back on the list`,
  muteAll: (n: number): string => `Muted ${n} sound${n === 1 ? '' : 's'}`
}
