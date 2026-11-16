/**
 * What the Captions and Transcript tabs say about estimated word times (docs/design/captions-studio.md
 * §3.5), in the UI language. transcriptTiming.ts, which main imports, keeps only the timing
 * (docs/design/output-and-languages.md §9.1, test 86).
 */
import { t } from '../../../../shared/i18n/t'

export const TIMING_COPY = {
  formHint: (model: string): string => t('captions.timing.formHint', { model }),
  get useLocal(): string {
    return t('captions.timing.useLocal')
  },
  get summary(): string {
    return t('captions.timing.summary')
  },
  get transcriptAll(): string {
    return t('captions.timing.transcriptAll')
  },
  get wordTitle(): string {
    return t('captions.timing.wordTitle')
  }
}
