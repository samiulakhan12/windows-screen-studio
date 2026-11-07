/**
 * Effects tab: the "Progress bar…" row that opens the bar's settings in the Text tab
 * (docs/design/editing-polish.md §2.4), with the focus on its switch.
 */
import { Section } from '../controls'
import { useGroup } from '../groupContext'
import { requestProgressBarFocus } from './ChapterBarSection'
import './magnifier.css'

export function ProgressBarLink(): JSX.Element {
  const group = useGroup()
  return (
    <Section title="Progress bar">
      <div className="progress-bar-link">
        <span className="hint">A thin bar that fills as the video plays, split at your chapters.</span>
        <button
          type="button"
          className="btn small"
          data-testid="progress-bar-link"
          onClick={() => {
            requestProgressBarFocus()
            group.command('showText')
          }}
        >
          Progress bar…
        </button>
      </div>
    </Section>
  )
}
