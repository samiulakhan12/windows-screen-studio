import { useEffect, useRef } from 'react'
import '../review/review.css'
import { t } from '../../../shared/i18n/t'

/**
 * The docked panel the contracts' stubs of smart tools' panels show until their part replaces them
 * (docs/design/smart-tools.md §20.0): Review mode's place and look, its heading and a line saying
 * the tool is not part of this build, Close, and Esc to close. Focus starts on Close.
 */
export function StubPanel({ title, testId, onClose }: { title: string; testId: string; onClose(): void }): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => closeRef.current?.focus(), [])
  return (
    <aside
      className="review-panel"
      role="region"
      aria-label={title}
      data-testid={testId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="review-head">
        <h2>{title}</h2>
        <button ref={closeRef} type="button" className="btn ghost" onClick={onClose}>
          {t('common.action.close')}
        </button>
      </div>
      <p className="hint">{t('smart.stub.notInBuild')}</p>
    </aside>
  )
}
