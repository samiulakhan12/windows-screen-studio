import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { maskPrivate, spokenForms } from '../../../shared/privacy/spoken'
import { t } from '../../../shared/i18n/t'
import type { Project } from '../../../shared/types'

/**
 * The publishing pack (docs/design/auto-blur.md §2.13, §7.5): the dialog shows the text the user
 * edits as they wrote it; when a secret said aloud is in it, the note says it shows as •••• wherever
 * the text leaves Flown (copied, saved beside the video, shared).
 */
export function PublishMaskedNote(props: { project: Project; text: string }): JSX.Element | null {
  const forms = spokenForms(props.project)
  if (!forms || !props.text || maskPrivate(props.text, forms) === props.text) return null
  return (
    <p className="hint" data-testid="privacy-publish-masked">
      {t(PRIVACY_COPY.publish.masked)}
    </p>
  )
}
