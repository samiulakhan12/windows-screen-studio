/**
 * The speaker notes' words on screen (docs/design/teleprompter.md, "UX and copy"), in one place
 * so Home, the Notes dialog, the notes window, the recording bar and the editor say the same
 * things, and the tests check them. Pure.
 */
import type { NotesHotkeyAction } from '../recording/hotkeys'
import type { NotesMode, NotesRecordingState } from '../api/notes'
import { readingSeconds } from './blocks'
import { SCRIPT_DRAFT_MAX_NOTES } from '../api/ai'
import { fmt } from '../i18n/fmt'
import { t } from '../i18n/t'

/**
 * The notes' words, read where they are shown: each is a getter that makes its message in the UI
 * language (docs/design/output-and-languages.md §9.1), so the panels that read NOTES_COPY.<word>
 * keep doing so.
 */
export const NOTES_COPY = {
  get groupLabel(): string {
    return t('review.notes.groupLabel')
  },
  get emptyHint(): string {
    return t('review.notes.emptyHint')
  },
  get add(): string {
    return t('review.notes.add')
  },
  get edit(): string {
    return t('review.notes.edit')
  },
  get rehearse(): string {
    return t('review.notes.rehearse')
  },
  get stopRehearsing(): string {
    return t('review.notes.stopRehearsing')
  },
  get showWhileRecording(): string {
    return t('review.notes.showWhileRecording')
  },
  get olderWindows(): string {
    return t('review.notes.olderWindows')
  },
  saveFailed: (message: string): string => t('review.notes.saveFailed', { error: message }),

  get dialogTitle(): string {
    return t('review.notes.dialogTitle')
  },
  get textLabel(): string {
    return t('review.notes.textLabel')
  },
  get placeholder(): string {
    return t('review.notes.placeholder')
  },
  get saved(): string {
    return t('common.state.saved')
  },
  couldNotSave: (message: string): string => t('review.notes.couldNotSave', { error: message }),
  get whileRecording(): string {
    return t('review.notes.whileRecording')
  },
  get showMyNotes(): string {
    return t('review.notes.showMyNotes')
  },
  get autoStart(): string {
    return t('review.notes.autoStart')
  },
  get autoStartHint(): string {
    return t('review.notes.autoStartHint')
  },
  get keep(): string {
    return t('review.notes.keep')
  },
  get keepHint(): string {
    return t('review.notes.keepHint')
  },
  get speed(): string {
    return t('common.label.speed')
  },
  get textSize(): string {
    return t('review.notes.textSize')
  },
  get width(): string {
    return t('review.notes.width')
  },
  get height(): string {
    return t('review.notes.height')
  },
  get sizeHint(): string {
    return t('review.notes.sizeHint')
  },
  get position(): string {
    return t('common.label.position')
  },
  get positionDefault(): string {
    return t('review.notes.positionDefault')
  },
  get positionSaved(): string {
    return t('review.notes.positionSaved')
  },
  get resetPosition(): string {
    return t('review.notes.resetPosition')
  },
  get hotkeysLabel(): string {
    return t('review.notes.hotkeysLabel')
  },
  get hotkeysHint(): string {
    return t('review.notes.hotkeysHint')
  },
  get done(): string {
    return t('common.action.done')
  },

  get draft(): string {
    return t('review.notes.draft')
  },
  get drafting(): string {
    return t('review.notes.drafting')
  },
  get cancel(): string {
    return t('common.action.cancel')
  },
  draftHint: (provider: string): string => t('review.notes.draftHint', { provider }),
  /** With AI on this PC (smart-tools.md §2.5): nothing leaves the PC. */
  get draftHintLocal(): string {
    return t('review.notes.draftHintLocal')
  },
  get noProvider(): string {
    return t('review.notes.noProvider')
  },
  get addProvider(): string {
    return t('common.action.addAiProvider')
  },
  get draftEmpty(): string {
    return t('review.notes.draftEmpty')
  },
  get draftTooLong(): string {
    return t('review.notes.draftTooLong', { n: fmt.count(SCRIPT_DRAFT_MAX_NOTES, { grouping: true }) })
  },
  get drafted(): string {
    return t('review.notes.drafted')
  },
  get restore(): string {
    return t('review.notes.restore')
  },
  get stale(): string {
    return t('review.notes.stale')
  },
  get tryAgain(): string {
    return t('common.action.tryAgain')
  },

  get windowLabel(): string {
    return t('review.notes.windowLabel')
  },
  get emptyRehearsal(): string {
    return t('review.notes.emptyRehearsal')
  },
  get hotkeyProblem(): string {
    return t('review.notes.hotkeyProblem')
  },
  get locked(): string {
    return t('review.notes.locked')
  },
  get backToStart(): string {
    return t('review.notes.backToStart')
  },
  get resize(): string {
    return t('review.notes.resize')
  },

  get barShow(): string {
    return t('review.notes.barShow')
  },
  get barHide(): string {
    return t('review.notes.barHide')
  },
  get barShowTitle(): string {
    return t('review.notes.barShowTitle')
  },
  get barHideTitle(): string {
    return t('review.notes.barHideTitle')
  },

  get scriptSection(): string {
    return t('review.notes.scriptSection')
  },
  get scriptIntro(): string {
    return t('review.notes.scriptIntro')
  },
  get copyScript(): string {
    return t('review.notes.copyScript')
  },
  get useAgain(): string {
    return t('review.notes.useAgain')
  },
  get replaceQuestion(): string {
    return t('review.notes.replaceQuestion')
  },
  get replace(): string {
    return t('review.notes.replace')
  }
}

/** "1 word", "312 words", "1,204 words". */
export function wordsLabel(words: number): string {
  const n = Math.max(0, Math.round(words))
  return t('review.notes.words', { count: n, n: fmt.count(n, { grouping: true }) })
}

/** How long reading takes: "about 45 s", "about 2 min 24 s", "about 1 h 5 min" (seconds rounded to whole ones), as blocks.ts's readingLabel. */
export function readingText(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
  if (s < 60) return t('review.notes.reading.seconds', { s: fmt.count(s) })
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const rest = s % 60
    return rest ? t('review.notes.reading.minSec', { m: fmt.count(m), s: fmt.count(rest) }) : t('review.notes.reading.min', { m: fmt.count(m) })
  }
  const minutes = Math.round(s / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? t('review.notes.reading.hourMin', { h: fmt.count(h), m: fmt.count(m) }) : t('review.notes.reading.hour', { h: fmt.count(h) })
}

/** The Notes dialog's live count: "312 words · about 2 min 24 s". */
export function countLine(words: number, wpm: number): string {
  return `${wordsLabel(words)} · ${readingText(readingSeconds(words, wpm))}`
}

/** Home's summary: "312 words · about 2 min 24 s at 130 words a minute". */
export function notesSummary(words: number, wpm: number): string {
  return t('review.notes.summary', { reading: countLine(words, wpm), speed: speedWords(wpm) })
}

/** "130 words a minute" (the dialog's slider). */
export const speedWords = (wpm: number): string => t('review.notes.speedWords', { n: fmt.count(wpm) })

/** "130 wpm" (the notes window's strip). */
export const speedShort = (wpm: number): string => t('review.notes.speedShort', { n: fmt.count(wpm) })

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
    if (s.recording === 'countdown') return s.want ? t('review.notes.status.startsWithRecording') : t('review.notes.status.startsOnPlay')
    if (s.recording === 'paused' && !s.playing) return t('review.notes.status.recordingPaused')
  }
  if (s.ended) return t('review.notes.status.end')
  if (s.playing) return t('review.notes.status.scrolling')
  return s.mode === 'rehearse' ? t('review.notes.status.rehearsing') : t('review.notes.status.paused')
}

/** "Back (Ctrl + Shift + F6)", or just "Back" without a hotkey. */
export const withHotkey = (label: string, hotkey: string | undefined): string => (hotkey ? t('review.notes.withHotkey', { label, keys: hotkey }) : label)

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
    back: withHotkey(t('common.action.back'), hotkeys.notesBack),
    toggle: withHotkey(playing ? t('review.notes.button.pause') : t('review.notes.button.start'), hotkeys.notesToggle),
    forward: withHotkey(t('review.notes.button.forward'), hotkeys.notesForward),
    slower: t('review.notes.button.slower'),
    faster: t('review.notes.button.faster'),
    smaller: t('review.notes.button.smaller'),
    larger: t('review.notes.button.larger'),
    close: mode === 'record' ? t('review.notes.button.hideNeverRecorded') : t('common.action.close')
  }
}
