import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { countWords } from '../../../shared/notes/blocks'
import { hasNotesText } from '../../../shared/notes/notes'
import { NOTES_COPY, notesSummary } from '../../../shared/notes/notesCopy'
import { NotesDialog } from './NotesDialog'
import { useNotes } from './useNotes'
import './notes.css'

function NotesIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5" />
    </svg>
  )
}

/**
 * Home's "Speaker notes" group (docs/design/teleprompter.md, "Home"): what the notes hold, the
 * Notes dialog, "Show while recording" and Rehearse. Shown once the main process answered, so
 * nothing half-broken shows while it cannot.
 */
export function NotesCard({ disabled }: { disabled: boolean }): JSX.Element | null {
  const notes = useNotes()
  const [dialog, setDialog] = useState<HTMLElement | null | false>(false)
  const [error, setError] = useState<string | null>(null)
  const [rehearseError, setRehearseError] = useState<string | null>(null)
  const { state, text } = notes
  const words = useMemo(() => countWords(text), [text])
  const rehearsing = state?.window?.mode === 'rehearse'

  // Leaving Home ends a rehearsal (the window would have nothing to follow).
  const rehearsingRef = useRef(false)
  rehearsingRef.current = rehearsing
  const rehearse = useRef(notes.rehearse)
  rehearse.current = notes.rehearse
  useEffect(
    () => () => {
      if (rehearsingRef.current) void rehearse.current(false)
    },
    []
  )

  if (!state) return null
  const s = state.settings
  const has = hasNotesText(text)
  const open = (e: MouseEvent<HTMLButtonElement>): void => setDialog(e.currentTarget)

  return (
    <div className="rec-group notes-card" role="group" aria-labelledby="notes-card-label" data-has-notes={has ? 'true' : 'false'}>
      <div className="notes-card-head">
        <span id="notes-card-label" className="notes-card-label">
          <NotesIcon /> {NOTES_COPY.groupLabel}
        </span>
      </div>
      {has ? (
        <>
          <p className="notes-summary">{notesSummary(words, s.wpm)}</p>
          <label className={`toggle ${disabled ? 'disabled' : ''}`}>
            <span>{NOTES_COPY.showWhileRecording}</span>
            <input
              type="checkbox"
              aria-label={NOTES_COPY.showWhileRecording}
              checked={s.showWhileRecording}
              disabled={disabled}
              onChange={(e) => void notes.update({ showWhileRecording: e.target.checked }).then(setError)}
            />
          </label>
          <div className="notes-card-actions">
            <button type="button" className="btn" disabled={disabled} aria-haspopup="dialog" onClick={open}>
              {NOTES_COPY.edit}
            </button>
            <button type="button" className="btn" disabled={disabled} aria-pressed={rehearsing} onClick={() => void notes.rehearse(!rehearsing).then(setRehearseError)}>
              {rehearsing ? NOTES_COPY.stopRehearsing : NOTES_COPY.rehearse}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="hint">{NOTES_COPY.emptyHint}</p>
          <div className="notes-card-actions">
            <button type="button" className="btn" disabled={disabled} aria-haspopup="dialog" onClick={open}>
              {NOTES_COPY.add}
            </button>
          </div>
        </>
      )}
      {!state.support.hiddenFromCapture && (
        <p className="notes-older" role="note">
          {NOTES_COPY.olderWindows}
        </p>
      )}
      {error && (
        <p className="notes-error" role="alert">
          {NOTES_COPY.saveFailed(error)}
        </p>
      )}
      {rehearseError && (
        <p className="notes-error" role="alert">
          {rehearseError}
        </p>
      )}
      {dialog !== false &&
        createPortal(
          <NotesDialog
            notes={notes}
            opener={dialog}
            onClose={() => {
              setDialog(false)
              setError(null)
              setRehearseError(null)
            }}
          />,
          document.body
        )}
    </div>
  )
}
