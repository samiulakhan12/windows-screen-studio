import { useEffect, useRef, useState } from 'react'
import type { SpeechModelView, SpeechState } from '../../../shared/api/speech'
import { DEFAULT_SPEECH_MODEL, type SpeechModelId } from '../../../shared/speech/catalog'
import {
  blockedLine,
  detectorLine,
  diskFooter,
  downloadFailed,
  engineLine,
  removeName,
  removeQuestion,
  rowDownload,
  rowFacts,
  rowStatus,
  rowTitle,
  SPEECH_COPY,
  tierPurpose
} from '../../../shared/speech/speechCopy'
import { estimateFor } from '../editor/panels/LocalCaptions'
import { loadSpeechState, useSpeechState } from '../editor/speechState'
import { ipcMessage } from './providerText'
import './speech.css'

/**
 * Settings › Captions on this PC (docs/design/offline-captions.md §7.3): the speech models
 * (download with a click that names the size, cancel, continue, remove, the model used for new
 * captions), the speech engine and the speech detector, and the models folder. `reveal` (Settings
 * opened at `speech`) scrolls it into view and focuses its heading.
 */
export function SpeechModelsSection({ reveal = false }: { reveal?: boolean }): JSX.Element {
  const speech = useSpeechState()
  const ref = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!reveal) return
    ref.current?.scrollIntoView({ block: 'nearest' })
    headingRef.current?.focus({ preventScroll: true })
  }, [reveal])

  const act = (what: Promise<unknown>): void => {
    setError(null)
    void what.catch((err: unknown) => {
      const message = ipcMessage(err)
      if (message !== 'Cancelled.') setError(message)
    })
  }

  return (
    <section className="settings-section speech-section" aria-labelledby="settings-speech-title" ref={ref} data-testid="speech-models">
      <h3 id="settings-speech-title" ref={headingRef} tabIndex={-1}>
        {SPEECH_COPY.settingsTitle}
      </h3>
      <p className="hint">{SPEECH_COPY.settingsLead}</p>
      {speech.status === 'loading' && <p className="settings-empty">{SPEECH_COPY.checking}</p>}
      {speech.status === 'failed' && (
        <p className="speech-line" data-testid="speech-engine">
          {engineLine({ available: false, build: null, threads: 1, reason: 'failed' })}
        </p>
      )}
      {speech.status === 'ready' && <Models state={speech.state} act={act} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function Models({ state, act }: { state: SpeechState; act: (what: Promise<unknown>) => void }): JSX.Element {
  const [removing, setRemoving] = useState<SpeechModelId | null>(null)
  /** Where focus goes when the Remove question closes. */
  const returnFocus = useRef<string | null>(null)
  useEffect(() => {
    if (removing) return
    const key = returnFocus.current
    returnFocus.current = null
    if (key) document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true })
  }, [removing])

  const closeQuestion = (id: SpeechModelId): void => {
    returnFocus.current = `speech-remove:${id}`
    setRemoving(null)
  }

  return (
    <>
      {state.engine.available && (
        <div className="speech-models" role="radiogroup" aria-label={SPEECH_COPY.settingsRadios}>
          {state.models.map((m) => (
            <Row
              key={m.id}
              m={m}
              state={state}
              act={act}
              asking={removing === m.id}
              onAsk={() => setRemoving(m.id)}
              onCloseQuestion={() => closeQuestion(m.id)}
              onRemoved={() => {
                returnFocus.current = null
                setRemoving(null)
              }}
            />
          ))}
        </div>
      )}
      <p className="speech-line" data-testid="speech-engine">
        {engineLine(state.engine)}
      </p>
      <p className="speech-line" data-testid="speech-detector">
        {detectorLine(state.detector)}
      </p>
      <div className="speech-footer">
        <span>{diskFooter(state.disk)}</span>
        <button type="button" className="btn ghost settings-small" onClick={() => act(window.api.showSpeechModelsFolder())}>
          {SPEECH_COPY.showFolder}
        </button>
      </div>
    </>
  )
}

function Row({
  m,
  state,
  act,
  asking,
  onAsk,
  onCloseQuestion,
  onRemoved
}: {
  m: SpeechModelView
  state: SpeechState
  act: (what: Promise<unknown>) => void
  asking: boolean
  onAsk: () => void
  onCloseQuestion: () => void
  onRemoved: () => void
}): JSX.Element {
  const s = m.status
  const installed = s.state === 'installed'
  const blocked = blockedLine(m, state)
  const status = rowStatus(m, state.disk.free)
  const download = (): void => act(window.api.downloadSpeechModel(m.id))
  const dl = rowDownload(m)
  const whyId = `speech-why-${m.id}`
  const inUseId = `speech-inuse-${m.id}`
  const failed = s.state === 'failed' ? downloadFailed(m.id, s, state.disk.free) : null
  // Focus never falls to the page when the row's buttons change (§7.7): after a change of state, of
  // the failure's button or of the Remove question (not on mount), the row's action takes the
  // focus if it fell to the body, else its status line (Checking… has no button).
  const actionRef = useRef<HTMLButtonElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const shown = `${s.state}:${failed?.action ?? ''}:${asking}`
  const lastShown = useRef(shown)
  useEffect(() => {
    if (lastShown.current === shown) return
    lastShown.current = shown
    const active = document.activeElement
    if (active && active !== document.body) return
    ;(actionRef.current ?? statusRef.current)?.focus({ preventScroll: true })
  }, [shown])

  return (
    <div className="speech-model" data-model={m.id} data-state={s.state}>
      <label className="speech-model-head">
        <input
          type="radio"
          name="speech-default"
          value={m.id}
          checked={state.defaultModel === m.id && installed}
          disabled={!installed}
          aria-label={rowTitle(m)}
          onChange={() => act(window.api.setDefaultSpeechModel(m.id))}
        />
        <strong>{rowTitle(m)}</strong>
        {m.id === DEFAULT_SPEECH_MODEL && <span className="speech-badge">{SPEECH_COPY.recommended}</span>}
        {installed && <span className="speech-badge ok">{SPEECH_COPY.downloaded}</span>}
      </label>
      <p className="speech-facts">{rowFacts(m, estimateFor(state, m, 600))}</p>
      <p className="speech-purpose">{tierPurpose(m.tier, true)}</p>
      <p className="speech-licence">{SPEECH_COPY.licenceLine}</p>
      {status && s.state !== 'installed' && (
        <p className={`speech-status ${s.state === 'failed' || s.state === 'damaged' ? 'error' : ''}`} data-testid="speech-status" ref={statusRef} tabIndex={-1}>
          {status}
        </p>
      )}
      {blocked && (
        <p className="speech-why" id={whyId}>
          {blocked}
        </p>
      )}
      {asking ? (
        <div
          className="ai-remove-question"
          role="alert"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            onCloseQuestion()
          }}
        >
          <span>{removeQuestion(m)}</span>
          <button
            type="button"
            className="btn danger settings-small"
            onClick={() => {
              onRemoved()
              act(window.api.removeSpeechModel(m.id))
            }}
          >
            {SPEECH_COPY.remove}
          </button>
          <button type="button" className="btn ghost settings-small" autoFocus onClick={onCloseQuestion}>
            {SPEECH_COPY.cancel}
          </button>
        </div>
      ) : (
        <div className="speech-actions">
          {(s.state === 'missing' || (s.state === 'failed' && failed?.action !== 'check-again')) && (
            <button
              ref={actionRef}
              type="button"
              className="btn settings-small"
              aria-label={blocked ? dl.name : s.state === 'failed' ? `${SPEECH_COPY.tryAgain}: ${dl.name}` : dl.name}
              aria-disabled={blocked ? 'true' : undefined}
              aria-describedby={blocked ? whyId : undefined}
              onClick={() => !blocked && download()}
            >
              {s.state === 'failed' ? SPEECH_COPY.tryAgain : dl.label}
            </button>
          )}
          {failed?.action === 'check-again' && (
            <button ref={actionRef} type="button" className="btn settings-small" onClick={() => loadSpeechState(true)}>
              {SPEECH_COPY.checkAgain}
            </button>
          )}
          {s.state === 'downloading' && (
            <button ref={actionRef} type="button" className="btn ghost settings-small" onClick={() => act(window.api.cancelSpeechDownload(m.id))}>
              {SPEECH_COPY.cancel}
            </button>
          )}
          {s.state === 'stopped' && (
            <>
              <button ref={actionRef} type="button" className="btn settings-small" onClick={download}>
                {SPEECH_COPY.continue}
              </button>
              <button type="button" className="btn ghost settings-small" onClick={() => act(window.api.cancelSpeechDownload(m.id, true))}>
                {SPEECH_COPY.delete}
              </button>
            </>
          )}
          {s.state === 'damaged' && (
            <button ref={actionRef} type="button" className="btn settings-small" aria-label={`${SPEECH_COPY.downloadAgain}: ${dl.name}`} onClick={download}>
              {SPEECH_COPY.downloadAgain}
            </button>
          )}
          {installed && (
            <>
              <button
                ref={actionRef}
                type="button"
                className="btn ghost danger settings-small"
                data-focus-key={`speech-remove:${m.id}`}
                aria-label={removeName(m)}
                aria-disabled={m.inUse ? 'true' : undefined}
                aria-describedby={m.inUse ? inUseId : undefined}
                onClick={() => !m.inUse && onAsk()}
              >
                {SPEECH_COPY.remove}
              </button>
              {m.inUse && (
                <span className="speech-why" id={inUseId}>
                  {SPEECH_COPY.inUse}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
