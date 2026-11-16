/**
 * Clean voice's failure sentence and the reasons the main process gives (docs/design/clean-voice.md
 * §5), shared by main (voiceClean, voiceIpc), the editor's stems, the export and the tests. Main
 * imports this file, so its words are errors messages, made where they are shown
 * (docs/design/output-and-languages.md §9.1, test 86); the Audio panel's own words are the
 * renderer's (editor/panels/voiceWords.ts).
 */
import { VOICE_CANCELLED, VOICE_REPLACED } from '../api/voice'
import { t } from '../i18n/t'

export const VOICE_COPY = {
  get failed(): string {
    return t('errors.voice.failed')
  },
  /** Reasons the main process gives. */
  get missingMic(): string {
    return t('errors.voice.missingMic')
  },
  get missingMix(): string {
    return t('errors.voice.missingMix')
  },
  get tooLong(): string {
    return t('errors.voice.tooLong')
  },
  get locked(): string {
    return t('errors.voice.locked')
  },
  /** The editor's own reason: the cleaned file is there but will not play. */
  get unplayable(): string {
    return t('errors.voice.unplayable')
  },
  get engine(): string {
    return t('errors.voice.engine')
  },
  get damagedModel(): string {
    return t('errors.voice.damagedModel')
  }
}

/**
 * A reason a clean rejected with, as the UI says it: the two stop tokens of api/voice.ts
 * (VOICE_CANCELLED, VOICE_REPLACED, compared as they are between main and the editor) in the UI
 * language, anything else unchanged. English gives the tokens' own words.
 */
export function voiceReason(message: string): string {
  if (message === VOICE_CANCELLED) return t('errors.voice.cancelled')
  if (message === VOICE_REPLACED) return t('errors.voice.replaced')
  return message
}
