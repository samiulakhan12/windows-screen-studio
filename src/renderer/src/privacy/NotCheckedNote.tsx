import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { unfinished } from '../../../shared/privacy/findState'
import { t } from '../../../shared/i18n/t'
import type { Project } from '../../../shared/types'
import { useGroup } from '../editor/groupContext'
import { useReaderState } from './readerState'

/**
 * The guide's lines about Find (docs/design/auto-blur.md §2.11): where the screenshots are sent
 * (`send`), *Find private info has not checked this video* when it never ran, or *did not finish*
 * when the last run stopped, failed reads or ended early; in the guide's save and copy area
 * (`save`), the same two lines with *Find…*, once the reader is downloaded (the user opted into the
 * feature), so the guide's outputs are not silent either.
 */
export function NotCheckedNote(props: { project: Project; place: 'send' | 'save' }): JSX.Element | null {
  const reader = useReaderState()
  const group = useGroup()
  const record = props.project.privacy?.find
  if (props.place === 'save' && reader?.status !== 'ready') return null
  const key = !record ? PRIVACY_COPY.guide.notChecked : unfinished(record) ? PRIVACY_COPY.guide.unfinished : null
  if (!key) return null
  return (
    <p className="hint warn privacy-guide-note" data-testid={`privacy-guide-${props.place}`} data-line={record ? 'unfinished' : 'notChecked'}>
      <span>{t(key)}</span>
      {props.place === 'save' && (
        <>
          {' '}
          <button type="button" className="link" onClick={() => group.command('findPrivate')} data-testid="privacy-guide-find">
            {t(PRIVACY_COPY.export.find)}
          </button>
        </>
      )}
    </p>
  )
}
