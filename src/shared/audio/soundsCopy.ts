/**
 * Every sentence of the unwanted-sound finder (docs/design/sound-finder.md §5), kept together so the
 * panel, the controller and the tests agree. The words are messages in the sound namespace, made
 * when they are read (docs/design/output-and-languages.md §9.1), so the tables keep their shape.
 */
import type { SoundKind } from './sounds'
import { fmt } from '../i18n/fmt'
import { t } from '../i18n/t'

export const SOUND_LABELS: Readonly<Record<SoundKind, string>> = {
  get cough() {
    return t('sound.kind.cough')
  },
  get sneeze() {
    return t('sound.kind.sneeze')
  },
  get typing() {
    return t('sound.kind.typing')
  },
  get ping() {
    return t('sound.kind.ping')
  },
  get phone() {
    return t('sound.kind.phone')
  },
  get dog() {
    return t('sound.kind.dog')
  },
  get door() {
    return t('sound.kind.door')
  },
  get music() {
    return t('sound.kind.music')
  }
}

export const SOUNDS_COPY = {
  get title() {
    return t('sound.finder.title')
  },
  get intro() {
    return t('sound.finder.intro')
  },
  get noSound() {
    return t('sound.finder.noSound')
  },
  get find() {
    return t('sound.finder.find')
  },
  get checking() {
    return t('sound.finder.checking')
  },
  get preparing() {
    return t('sound.finder.preparing')
  },
  get cancel() {
    return t('common.action.cancel')
  },
  get tryAgain() {
    return t('common.action.tryAgain')
  },
  get none() {
    return t('sound.finder.none')
  },
  get muteAll() {
    return t('sound.finder.muteAll')
  },
  get muteTitle() {
    return t('sound.finder.muteTitle')
  },
  get duckTitle() {
    return t('sound.finder.duckTitle')
  },
  get cutTitle() {
    return t('sound.finder.cutTitle')
  },
  get ignoreTitle() {
    return t('sound.finder.ignoreTitle')
  },
  get restoreTitle() {
    return t('sound.finder.restoreTitle')
  },
  get bringBackTitle() {
    return t('sound.finder.bringBackTitle')
  },
  get wholeVideo() {
    return t('sound.finder.wholeVideo')
  },
  get restoreCutFailed() {
    return t('sound.finder.restoreCutFailed')
  },
  get playCut() {
    return t('sound.finder.playCut')
  },
  states: {
    get muted() {
      return t('sound.finder.state.muted')
    },
    get ducked() {
      return t('sound.finder.state.ducked')
    },
    get cut() {
      return t('sound.finder.state.cut')
    },
    get ignored() {
      return t('sound.finder.state.ignored')
    }
  }
}

/** "Could not listen to the recording: …", with the reason. */
export const failedText = (message: string): string => t('sound.finder.failed', { message })

/** "The sound finder could not run: …", with the reason the worker gave, in words (soundScan's workerReason). */
export const workerFailedText = (reason: string): string => t('sound.finder.workerFailed', { reason })

/** "Listening to the recording… 42%". */
export const listeningText = (progress: number): string => t('sound.finder.listening', { percent: fmt.percent(Math.min(1, Math.max(0, progress))) })

/** "3 found. Nothing changes until you choose." */
export const foundText = (n: number): string => t('sound.finder.found', { count: n, n: fmt.count(n) })

/** "Show ignored (2)". */
export const showIgnoredText = (n: number): string => t('sound.finder.showIgnored', { n: fmt.count(n) })

/** "0.4 s" (a tenth of a second at least). */
export const lengthText = (seconds: number): string => fmt.seconds(seconds)

/** The row's name in sentences: "the cough at 0:12.4". */
export const rowName = (kind: SoundKind, outputTime: number): string => t('sound.finder.rowName', { kind, time: fmt.clock(outputTime) })

/** What the live region says after an action. */
export const actionText = {
  mute: (name: string): string => t('sound.finder.said.muted', { name }),
  duck: (name: string): string => t('sound.finder.said.ducked', { name }),
  cut: (seconds: number): string => t('sound.finder.said.cut', { length: fmt.seconds(seconds) }),
  ignore: (name: string): string => t('sound.finder.said.ignored', { name }),
  restore: (name: string): string => t('sound.finder.said.restored', { name }),
  bringBack: (name: string): string => t('sound.finder.said.backOnList', { name: `${name.charAt(0).toUpperCase()}${name.slice(1)}` }),
  muteAll: (n: number): string => t('sound.finder.said.mutedAll', { count: n, n: fmt.count(n) })
}
