import { useEffect, useRef, useState } from 'react'
import { SPEECH_COPY } from '../../../shared/speech/speechCopy'
import { ipcMessage } from './providerText'
import './speech.css'

/**
 * About › Third-party notices (docs/design/offline-captions.md §7.5): a disclosure, not a second
 * dialog (Settings' own focus trap and Esc would fight one). The button reveals a read-only,
 * scrollable region below it, loaded on first open; focus moves into it, and Esc inside it
 * collapses it (Settings stays open) and returns focus to the button.
 */
export function NoticesPanel(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const regionRef = useRef<HTMLPreElement>(null)
  const asked = useRef(false)

  useEffect(() => {
    if (!open || asked.current) return
    asked.current = true
    window.api.getThirdPartyNotices().then(
      (t) => setText(typeof t === 'string' ? t : ''),
      (err: unknown) => {
        asked.current = false
        setError(ipcMessage(err))
      }
    )
  }, [open])
  useEffect(() => {
    if (open) regionRef.current?.focus()
  }, [open, text])

  return (
    <div className="notices-panel">
      <button
        ref={buttonRef}
        type="button"
        className="link"
        aria-expanded={open}
        aria-controls="third-party-notices"
        onClick={() => {
          setError(null)
          setOpen((o) => !o)
        }}
      >
        {SPEECH_COPY.notices}
      </button>
      {open &&
        (error ? (
          <p className="error" role="alert" id="third-party-notices">
            {SPEECH_COPY.noticesFailed(error)}
          </p>
        ) : (
          <pre
            ref={regionRef}
            id="third-party-notices"
            className="notices-region"
            role="document"
            tabIndex={0}
            aria-label={SPEECH_COPY.notices}
            aria-busy={text === null}
            data-testid="third-party-notices"
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              setOpen(false)
              buttonRef.current?.focus()
            }}
          >
            {text ?? SPEECH_COPY.noticesLoading}
          </pre>
        ))}
    </div>
  )
}
