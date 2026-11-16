/**
 * Effects tab: the "Progress bar…" row that opens the bar's settings in the Text tab
 * (docs/design/editing-polish.md §2.4), with the focus on its switch.
 */
import { Section } from '../controls'
import { useGroup } from '../groupContext'
import { requestProgressBarFocus } from './ChapterBarSection'
import './magnifier.css'
import { t } from '../../../../shared/i18n/t'

export function ProgressBarLink(): JSX.Element {
  const group = useGroup()
  return (
    <Section title={t('text.progressBarLink.progressBar')}>
      <div className="progress-bar-link">
        <span className="hint">{t('text.progressBarLink.aThinBarThat')}</span>
        <button
          type="button"
          className="btn small"
          data-testid="progress-bar-link"
          onClick={() => {
            requestProgressBarFocus()
            group.command('showText')
          }}
        >{t('text.progressBarLink.progressBar2')}</button>
      </div>
    </Section>
  )
}
