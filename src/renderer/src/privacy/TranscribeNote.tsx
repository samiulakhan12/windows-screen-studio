import { isPrivateBleep } from '../../../shared/privacy/coverData'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { t } from '../../../shared/i18n/t'
import type { Project } from '../../../shared/types'

/**
 * Transcribing with a service (docs/design/auto-blur.md §2.13, decision 7): once Find listened for
 * secrets said aloud, or the project has private bleeps, the service hears everything said, secrets
 * too; bleeps apply only to what Flown makes from it. Nothing on this PC's own captions.
 */
export function TranscribeNote(props: { project: Project; place: 'service' | 'local' }): JSX.Element | null {
  if (props.place !== 'service') return null
  const { project } = props
  if (!project.privacy?.find?.listened && !project.bleeps?.some(isPrivateBleep)) return null
  return (
    <p className="hint warn" data-testid="privacy-transcribe-hears">
      {t(PRIVACY_COPY.transcribe.hears)}
    </p>
  )
}
