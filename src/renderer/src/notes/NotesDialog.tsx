import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { countWords } from '../../../shared/notes/blocks'
import { NOTES_FONT, NOTES_HEIGHT, NOTES_TEXT_MAX, NOTES_WIDTH, NOTES_WPM, type NotesSettings, type NotesSettingsPatch } from '../../../shared/notes/notes'
import { countLine, NOTES_COPY, speedWords } from '../../../shared/notes/notesCopy'
import { NOTES_HOTKEY_ACTIONS, type NotesHotkeyAction } from '../../../shared/recording/hotkeys'
import { friendlyError } from '../../../shared/recording/errors'
import { Icon } from '../components/Icon'
import { HotkeyField } from '../recorder/RecordingOptions'
import { DraftScript } from './DraftScript'
import type { NotesController } from './useNotes'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

/** How long a slider waits after the last move before saving (dragging sends one save, not dozens). */
const SLIDER_SAVE_MS = 200

/**
 * Tab stays inside the dialog and focus goes back to `opener` when it closes. It steps aside
 * while another modal dialog is on top (Settings, opened by "Add an AI provider").
 */
function useDialogFocus(box: RefObject<HTMLElement>, opener: HTMLElement | null): void {
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const active = document.activeElement
      const other = active instanceof Element ? active.closest('[aria-modal="true"]') : null
      if (other && other !== el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const inside = active instanceof Node && el.contains(active)
      if (!inside || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener('keydown', onTab, true)
    return () => {
      window.removeEventListener('keydown', onTab, true)
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [box, opener])
}

/** A slider that shows its value at once and saves it SLIDER_SAVE_MS after the last move. */
function NotesSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onSave
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onSave: (v: number) => void
}): JSX.Element {
  const [local, setLocal] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const save = useRef(onSave)
  save.current = onSave
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const shown = local ?? value
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{label}</span>
        <span className="muted">{format(shown)}</span>
      </span>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={format(shown)}
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLocal(v)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => {
            timer.current = null
            save.current(v)
            setLocal(null)
          }, SLIDER_SAVE_MS)
        }}
      />
    </label>
  )
}

/**
 * The Notes dialog (docs/design/teleprompter.md, "Notes dialog"): the script with its count and
 * Draft script on the left, how the notes behave while recording on the right. Modal: Tab stays
 * inside, Esc closes, focus goes back to the button that opened it.
 */
export function NotesDialog({ notes, opener, onClose }: { notes: NotesController; opener: HTMLElement | null; onClose: () => void }): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [rehearseError, setRehearseError] = useState<string | null>(null)
  useDialogFocus(boxRef, opener)

  const settings = notes.state?.settings as NotesSettings
  const words = useMemo(() => countWords(notes.text), [notes.text])
  const rehearsing = notes.state?.window?.mode === 'rehearse'

  const close = useCallback(() => {
    void notes.flushText()
    onClose()
  }, [notes, onClose])

  useEffect(() => {
    textRef.current?.focus()
  }, [])

  const save = (patch: NotesSettingsPatch): void => {
    void notes.update(patch).then(setError)
  }

  const setHotkey = useCallback(
    async (action: NotesHotkeyAction, accelerator: string): Promise<string | null> => {
      if (accelerator) {
        const check = await window.api.checkHotkey(action, accelerator).catch((err: unknown) => ({ ok: false as const, message: friendlyError(err).message }))
        if (!check.ok) return check.message
        accelerator = check.accelerator
      }
      return notes.update({ hotkeys: { [action]: accelerator } })
    },
    [notes]
  )

  const status = notes.saveStatus

  return (
    <div className="overlay modal-backdrop notes-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="modal notes-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notes-title"
        ref={boxRef}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault()
            close()
          }
        }}
      >
        <header className="modal-head">
          <h2 id="notes-title">{NOTES_COPY.dialogTitle}</h2>
          <button type="button" className="btn ghost icon-btn" onClick={close} title="Close" aria-label="Close speaker notes">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="notes-body">
          <div className="notes-script">
            <label className="field notes-text-field">
              <span>{NOTES_COPY.textLabel}</span>
              <textarea
                ref={textRef}
                className="notes-textarea"
                value={notes.text}
                maxLength={NOTES_TEXT_MAX}
                spellCheck
                placeholder={NOTES_COPY.placeholder}
                onChange={(e) => notes.setText(e.target.value)}
                onBlur={() => void notes.flushText()}
              />
            </label>
            <div className="notes-count-row">
              <span className="notes-count" aria-live="polite">
                {countLine(words, settings.wpm)}
              </span>
              <span className={`notes-saved ${status.kind}`} role={status.kind === 'error' ? 'alert' : undefined}>
                {status.kind === 'saved' ? NOTES_COPY.saved : status.kind === 'error' ? NOTES_COPY.couldNotSave(status.message) : ''}
              </span>
            </div>
            <DraftScript
              text={notes.text}
              onReplace={(t) => {
                notes.setText(t)
                void notes.flushText()
              }}
            />
          </div>
          <div className="notes-settings" role="group" aria-labelledby="notes-while">
            <h3 id="notes-while" className="notes-subtitle">
              {NOTES_COPY.whileRecording}
            </h3>
            <label className="toggle">
              <span>{NOTES_COPY.showMyNotes}</span>
              <input type="checkbox" aria-label={NOTES_COPY.showMyNotes} checked={settings.showWhileRecording} onChange={(e) => save({ showWhileRecording: e.target.checked })} />
            </label>
            <div className="notes-option">
              <label className="toggle">
                <span>{NOTES_COPY.autoStart}</span>
                <input type="checkbox" aria-label={NOTES_COPY.autoStart} checked={settings.autoStart} onChange={(e) => save({ autoStart: e.target.checked })} />
              </label>
              <p className="hint">{NOTES_COPY.autoStartHint}</p>
            </div>
            <div className="notes-option">
              <label className="toggle">
                <span>{NOTES_COPY.keep}</span>
                <input type="checkbox" aria-label={NOTES_COPY.keep} checked={settings.keepWithRecording} onChange={(e) => save({ keepWithRecording: e.target.checked })} />
              </label>
              <p className="hint">{NOTES_COPY.keepHint}</p>
            </div>
            <NotesSlider label={NOTES_COPY.speed} value={settings.wpm} min={NOTES_WPM.min} max={NOTES_WPM.max} step={NOTES_WPM.step} format={speedWords} onSave={(wpm) => save({ wpm })} />
            <NotesSlider
              label={NOTES_COPY.textSize}
              value={settings.fontSize}
              min={NOTES_FONT.min}
              max={NOTES_FONT.max}
              step={NOTES_FONT.step}
              format={(v) => `${v} px`}
              onSave={(fontSize) => save({ fontSize })}
            />
            <NotesSlider label={NOTES_COPY.width} value={settings.width} min={NOTES_WIDTH.min} max={NOTES_WIDTH.max} step={10} format={(v) => `${v}`} onSave={(width) => save({ width })} />
            <NotesSlider label={NOTES_COPY.height} value={settings.height} min={NOTES_HEIGHT.min} max={NOTES_HEIGHT.max} step={10} format={(v) => `${v}`} onSave={(height) => save({ height })} />
            <p className="hint">{NOTES_COPY.sizeHint}</p>
            <div className="notes-position">
              <span className="notes-position-label">{NOTES_COPY.position}</span>
              <span className="notes-position-value">{settings.placement ? NOTES_COPY.positionSaved : NOTES_COPY.positionDefault}</span>
              <button type="button" className="btn notes-small" disabled={!settings.placement} onClick={() => save({ placement: null })}>
                {NOTES_COPY.resetPosition}
              </button>
            </div>
            <div className="hotkeys notes-hotkeys" role="group" aria-label="Notes hotkeys">
              <span className="option-label">{NOTES_COPY.hotkeysLabel}</span>
              {NOTES_HOTKEY_ACTIONS.map((action) => (
                <HotkeyField key={action} action={action} value={settings.hotkeys[action]} disabled={false} onSet={(a) => setHotkey(action, a)} />
              ))}
              <p className="hint">{NOTES_COPY.hotkeysHint}</p>
            </div>
            {error && (
              <p className="hint notes-warn" role="alert">
                {NOTES_COPY.couldNotSave(error)}
              </p>
            )}
          </div>
        </div>
        <footer className="modal-foot notes-foot">
          {rehearseError && (
            <span className="hint notes-warn notes-foot-msg" role="alert">
              {rehearseError}
            </span>
          )}
          <button
            type="button"
            className="btn"
            aria-pressed={rehearsing}
            onClick={() => void notes.rehearse(!rehearsing).then(setRehearseError)}
          >
            {rehearsing ? NOTES_COPY.stopRehearsing : NOTES_COPY.rehearse}
          </button>
          <button type="button" className="btn primary" onClick={close}>
            {NOTES_COPY.done}
          </button>
        </footer>
      </div>
    </div>
  )
}
