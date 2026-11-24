import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { trackText } from '../../../shared/privacy/spoken'
import { t } from '../../../shared/i18n/t'
import type { Project } from '../../../shared/types'

/**
 * A translation over secrets said aloud (docs/design/auto-blur.md §2.13, §7.4): while any of its
 * captions under a private bleep has not been translated again from the masked text, those captions
 * show as •••• in this language, and the line says so.
 */
export function TranslatedNote(props: { project: Project; language: string }): JSX.Element | null {
  const { project } = props
  const track = project.captionTracks?.find((tr) => tr.language === props.language)
  if (!track || !track.segments.some((s) => trackText(project, s) !== s.text)) return null
  return (
    <span className="hint" data-testid="privacy-translated-masked">
      {' · '}
      {t(PRIVACY_COPY.translated.masked)}
    </span>
  )
}
