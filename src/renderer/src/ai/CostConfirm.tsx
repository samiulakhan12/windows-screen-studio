/**
 * The cost question as an alert dialog (docs/design/smart-tools.md §11.5): the question, then Cancel
 * (focused, as running costs money) and Run or Start. Esc cancels, Tab stays inside, and the focus
 * goes back to the button that asked.
 */
import { useEffect, useId, useRef } from 'react'
import { useModalFocus } from '../editor/modalFocus'
import './cost.css'

export function CostConfirm({ text, action, onDone }: { text: string; action: string; onDone(run: boolean): void }): JSX.Element {
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useModalFocus(box, () => onDone(false))
  useEffect(() => {
    cancel.current?.focus()
  }, [])
  return (
    <div className="overlay modal-backdrop cost-confirm-scrim">
      <div className="cost-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`} ref={box} data-testid="cost-confirm">
        <h2 id={`${id}-title`}>{action === 'Start' ? 'Start on this PC?' : 'Run it?'}</h2>
        <p id={`${id}-text`}>{text}</p>
        <div className="cost-confirm-actions">
          <button ref={cancel} type="button" className="btn primary" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button type="button" className="btn" data-testid="cost-confirm-run" onClick={() => onDone(true)}>
            {action}
          </button>
        </div>
      </div>
    </div>
  )
}
