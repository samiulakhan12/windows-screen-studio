/**
 * The title bar's Review button (docs/design/review-mode.md §5): opens Review mode, with the count
 * of automatic changes still to review.
 */
import { forwardRef, useMemo } from 'react'
import { withShortcut } from '../../../shared/editor/shortcuts'
import { fmt } from '../../../shared/i18n/fmt'
import { t } from '../../../shared/i18n/t'
import { buttonLabel, reviewTitle } from '../../../shared/review/copy'
import { pendingCount } from '../../../shared/review/review'
import type { Project } from '../../../shared/types'
import './review.css'

export const ReviewButton = forwardRef<HTMLButtonElement, { project: Project; shortcuts: readonly string[] | undefined; open: boolean; onToggle: () => void }>(
  function ReviewButton({ project, shortcuts, open, onToggle }, ref) {
    const count = useMemo(() => pendingCount(project), [project])
    return (
      <button
        ref={ref}
        className={`btn review-open${open ? ' on' : ''}`}
        data-testid="review-open"
        aria-expanded={open}
        aria-label={buttonLabel(count)}
        title={withShortcut(reviewTitle(), shortcuts)}
        onClick={onToggle}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6h11M9 12h11M9 18h11M3.5 6l1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2" />
        </svg>
        <span className="tb-label">{t('review.button.label')}</span>
        {count > 0 && (
          <span className="review-count" aria-hidden="true" data-testid="review-count">
            {count > 99 ? `${fmt.count(99)}+` : fmt.count(count)}
          </span>
        )}
      </button>
    )
  }
)
