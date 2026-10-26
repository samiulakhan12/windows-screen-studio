/**
 * The speaker notes' words on screen (docs/design/teleprompter.md, "UX and copy"), in one place
 * so Home, the Notes dialog, the notes window, the recording bar and the editor say the same
 * things, and the tests check them. Pure.
 */
import type { NotesHotkeyAction } from '../recording/hotkeys'
import type { NotesMode, NotesRecordingState } from '../api/notes'
import { readingLabel, readingSeconds } from './blocks'

export const NOTES_COPY = {
  groupLabel: 'Speaker notes',
  emptyHint: 'Add a script or bullet points to read while you record. Only you see them: they stay out of the video.',
  add: 'Add notes…',
  edit: 'Edit notes…',
  rehearse: 'Rehearse',
  stopRehearsing: 'Stop rehearsing',
  showWhileRecording: 'Show while recording',
  olderWindows:
    'On this version of Windows your notes would show in the video as a black box (the recording bar does too). They appear only when they are outside what you record, and never in a window recording. Windows 10 version 2004 or later keeps them out of the video.',
  saveFailed: (message: string): string => `Could not save your notes: ${message}`,

  dialogTitle: 'Speaker notes',
  textLabel: 'Your script or bullet points',
  placeholder: 'Paste your script or a few bullet points. Each line is a step; a blank line adds space. [Text in brackets] is a cue you do not read aloud.',
  saved: 'Saved',
  couldNotSave: (message: string): string => `Could not save: ${message}`,
  whileRecording: 'While recording',
  showMyNotes: 'Show my notes while recording',
  autoStart: 'Start scrolling when the recording starts',
  autoStartHint: 'Turn off for bullet notes you step through with Forward.',
  keep: 'Keep a copy with the recording',
  keepHint: 'You find it in the editor’s Captions tab.',
  speed: 'Speed',
  textSize: 'Text size',
  width: 'Width',
  height: 'Height',
  sizeHint: 'Narrow keeps your eyes near the camera. You can also drag the window’s corner.',
  position: 'Position',
  positionDefault: 'Top centre of the main screen, under the camera',
  positionSaved: 'Where you left it',
  resetPosition: 'Reset position',
  hotkeysLabel: 'Hotkeys',
  hotkeysHint: 'They work while your notes are open.',
  done: 'Done',

  draft: 'Draft script',
  drafting: 'Drafting…',
  cancel: 'Cancel',
  draftHint: (provider: string): string => `Turns your bullet points into sentences to read aloud. Only these notes are sent to ${provider}, with your key.`,
  noProvider: 'Draft script needs an AI provider with your own key: OpenAI, Gemini or Claude.',
  addProvider: 'Add an AI provider',
  draftEmpty: 'Write a few bullet points first.',
  draftTooLong: 'Draft script works on up to 20,000 characters of notes.',
  drafted: 'Script drafted from your notes. Read it through before you record.',
  restore: 'Restore my notes',
  stale: 'Your notes changed while the script was drafted, so the draft was not used. Try again.',
  tryAgain: 'Try again',

  windowLabel: 'Speaker notes',
  emptyRehearsal: 'No notes yet. Add them on the home screen.',
  hotkeyProblem: 'Hotkey problem',
  locked: 'Locked in place so it stays out of the recording on this version of Windows',
  backToStart: 'Back to start',
  resize: 'Drag to resize',

  barShow: 'Show notes',
  barHide: 'Hide notes',
  barShowTitle: 'Show your notes',
  barHideTitle: 'Hide your notes (they are never in the recording)',

  scriptSection: 'Your script',
  scriptIntro: 'You read from these notes while recording.',
  copyScript: 'Copy script',
  useAgain: 'Use as notes again',
  replaceQuestion: 'Replace your current notes?',
  replace: 'Replace'
} as const

/** "1 word", "312 words", "1,204 words". */
export function wordsLabel(words: number): string {
  const n = Math.max(0, Math.round(words))
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'word' : 'words'}`
}

/** The Notes dialog's live count: "312 words · about 2 min 24 s". */
export function countLine(words: number, wpm: number): string {
  return `${wordsLabel(words)} · ${readingLabel(readingSeconds(words, wpm))}`
}

/** Home's summary: "312 words · about 2 min 24 s at 130 words a minute". */
export function notesSummary(words: number, wpm: number): string {
  return `${countLine(words, wpm)} at ${speedWords(wpm)}`
}

/** "130 words a minute" (the dialog's slider). */
export const speedWords = (wpm: number): string => `${wpm} words a minute`

/** "130 wpm" (the notes window's strip). */
export const speedShort = (wpm: number): string => `${wpm} wpm`

export interface NotesStatusInput {
  mode: NotesMode
  recording: NotesRecordingState | null
  playing: boolean
  ended: boolean
  /** The presenter wants it to scroll (during the countdown: it starts with the recording). */
  want: boolean
}

/** The notes window's status text (announced politely when it changes). */
export function notesStatus(s: NotesStatusInput): string {
  if (s.mode === 'record') {
    if (s.recording === 'countdown') return s.want ? 'Starts with the recording' : 'Starts when you press play'
    if (s.recording === 'paused' && !s.playing) return 'Recording paused'
  }
  if (s.ended) return 'End of notes'
  if (s.playing) return 'Scrolling'
  return s.mode === 'rehearse' ? 'Rehearsing: not recording' : 'Paused'
}

/** "Back (Ctrl + Shift + F6)", or just "Back" without a hotkey. */
export const withHotkey = (label: string, hotkey: string | undefined): string => (hotkey ? `${label} (${hotkey})` : label)

export interface NotesButtonTitles {
  back: string
  toggle: string
  forward: string
  slower: string
  faster: string
  smaller: string
  larger: string
  close: string
}

/** Titles (tooltips) of the notes window's buttons, with the hotkeys that work now. */
export function notesButtonTitles(hotkeys: Partial<Record<NotesHotkeyAction, string>>, mode: NotesMode, playing: boolean): NotesButtonTitles {
  return {
    back: withHotkey('Back', hotkeys.notesBack),
    toggle: withHotkey(playing ? 'Pause scrolling' : 'Start scrolling', hotkeys.notesToggle),
    forward: withHotkey('Forward', hotkeys.notesForward),
    slower: 'Slower',
    faster: 'Faster',
    smaller: 'Smaller text',
    larger: 'Larger text',
    close: mode === 'record' ? 'Hide notes (they are never recorded)' : 'Close'
  }
}
