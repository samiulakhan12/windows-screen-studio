/**
 * The Publish dialog's words in the UI language (docs/design/output-and-languages.md §9.1, §10.3).
 * src/shared/publish/pack.ts is in main's import graph, so its tables (PUBLISH_LABELS, PUBLISH_TONES,
 * PUBLISH_LENGTHS, BLOCKER_TEXT) keep their English as data; the dialog shows these instead, and a
 * test holds their English to the tables (tests/i18nPublishWords.test.ts).
 */
import { t } from '../../../shared/i18n/t'
import type { PublishBlocker, PublishKind, PublishLength, PublishTone } from '../../../shared/publish/pack'

/** "YouTube description", "LinkedIn post", … */
export function publishLabel(kind: PublishKind): string {
  switch (kind) {
    case 'youtube':
      return t('review.publish.kind.youtube')
    case 'linkedin':
      return t('review.publish.kind.linkedin')
    case 'xpost':
      return t('review.publish.kind.xpost')
    case 'article':
      return t('review.publish.kind.article')
    case 'releaseNotes':
      return t('review.publish.kind.releaseNotes')
    case 'title':
      return t('review.publish.kind.title')
    case 'summary':
      return t('review.publish.kind.summary')
  }
}

/** The Tone chips. */
export const toneOptions = (): readonly { value: PublishTone; label: string }[] => [
  { value: 'friendly', label: t('review.publish.tone.friendly') },
  { value: 'professional', label: t('review.publish.tone.professional') },
  { value: 'casual', label: t('review.publish.tone.casual') }
]

/** The Length chips. */
export const lengthOptions = (): readonly { value: PublishLength; label: string }[] => [
  { value: 'short', label: t('review.publish.length.short') },
  { value: 'normal', label: t('review.publish.length.normal') }
]

/** Why nothing can be written yet. */
export function blockerText(blocker: Exclude<PublishBlocker, null>): string {
  switch (blocker) {
    case 'no-sound':
      return t('review.publish.blocker.noSound')
    case 'no-captions':
      return t('review.publish.blocker.noCaptions')
    case 'too-little':
      return t('review.publish.blocker.tooLittle')
  }
}
