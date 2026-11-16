/**
 * What the Audio panel's Clean voice section says (docs/design/clean-voice.md §5), in the UI
 * language. The main process's reasons and the failure sentence are shared/audio/voiceCopy.ts's;
 * these are the panel's own words, made where they are shown
 * (docs/design/output-and-languages.md §9.1).
 */
import { fmt } from '../../../../shared/i18n/fmt'
import { t } from '../../../../shared/i18n/t'
import type { VoiceStrength } from '../../../../shared/types'

export const VOICE_WORDS = {
  get section(): string {
    return t('sound.voice.section')
  },
  get toggle(): string {
    return t('sound.voice.toggle')
  },
  get intro(): string {
    return t('sound.voice.intro')
  },
  get mixed(): string {
    return t('sound.voice.mixed')
  },
  get silent(): string {
    return t('sound.voice.silent')
  },
  get noMic(): string {
    return t('sound.voice.noMic')
  },
  get strength(): string {
    return t('sound.voice.strength')
  },
  get checking(): string {
    return t('sound.voice.checking')
  },
  get cleaning(): string {
    return t('sound.voice.cleaning')
  },
  working: (percent: number): string => t('sound.voice.working', { percent: fmt.count(percent) }),
  get cancel(): string {
    return t('common.action.cancel')
  },
  get ready(): string {
    return t('sound.voice.ready')
  },
  get original(): string {
    return t('sound.voice.original')
  },
  get playingOriginal(): string {
    return t('sound.voice.playingOriginal')
  },
  get stopped(): string {
    return t('sound.voice.stopped')
  },
  get cleanNow(): string {
    return t('sound.voice.cleanNow')
  },
  get tryAgain(): string {
    return t('common.action.tryAgain')
  }
}

const STRENGTH_KEYS = {
  light: { name: 'sound.voice.strength.light', hint: 'sound.voice.strength.lightHint' },
  normal: { name: 'sound.voice.strength.normal', hint: 'sound.voice.strength.normalHint' },
  strong: { name: 'sound.voice.strength.strong', hint: 'sound.voice.strength.strongHint' }
} as const satisfies Record<VoiceStrength, { name: string; hint: string }>

/** A strength's chip label ("Light"). */
export const strengthName = (s: VoiceStrength): string => t(STRENGTH_KEYS[s].name)
/** What a strength does, under the chips. */
export const strengthHint = (s: VoiceStrength): string => t(STRENGTH_KEYS[s].hint)
