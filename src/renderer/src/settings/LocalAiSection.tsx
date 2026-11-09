/**
 * Settings › AI on this PC (docs/design/smart-tools.md §2.5): the PC's line, one row per model
 * (Download with a name that says the size, then a progress bar with Cancel, then Remove; a row the
 * PC cannot use says why and offers no Download), Use (Automatic, or a downloaded model pinned),
 * the speeds measured on this PC; and its row in Settings › AI providers (LocalAiRow). `reveal`
 * (Settings opened at 'localAi') scrolls the section into view and focuses its heading.
 */
import { useEffect, useRef, useState } from 'react'
import type { LocalAiState, LocalModelId, LocalModelState, LocalModelUse } from '../../../shared/api/localAi'
import { LOCAL_MODELS, suggestedModel, type LocalModelSpec } from '../../../shared/localAi/catalog'
import { blockReason, pcLine, sizeGb, speedLine } from '../../../shared/localAi/messages'
import { loadLocalAiState, modelInUse, setLocalAiState, useLocalAi } from '../ai/localAiState'
import { ipcMessage } from './providerText'
import '../ai/localAi.css'

export const LOCAL_AI_COPY = {
  title: 'AI on this PC',
  lead: 'Writes titles, chapter names, summaries, clean-ups, translations and posts with no key, and sends nothing anywhere. Good for drafts: check what it writes. Slower than an AI service.',
  checking: 'Checking this PC…',
  failed: 'AI on this PC could not be checked.',
  download: 'Download',
  downloadAgain: 'Download again',
  cancel: 'Cancel',
  remove: 'Remove',
  downloaded: 'Downloaded',
  suggested: 'Suggested for this PC',
  use: 'Model for AI on this PC',
  automatic: 'Automatic',
  damaged: 'The model file is missing or damaged.'
} as const

const specOf = (id: LocalModelId): LocalModelSpec | undefined => LOCAL_MODELS.find((m) => m.id === id)

/** "Download Recommended, 3.1 gigabytes": what the Download button says to a screen reader. */
export function downloadName(spec: LocalModelSpec, bytes: number): string {
  return `Download ${spec.title}, ${(bytes / 1e9).toFixed(1)} gigabytes`
}

/** "1.2 of 3.1 GB". */
export function progressText(done: number, bytes: number): string {
  return `${(Math.max(0, done) / 1e9).toFixed(1)} of ${sizeGb(bytes)}`
}

/** What the download's progress bar says to a screen reader (§14): "1.2 of 3.1 gigabytes". */
export function progressValueText(done: number, bytes: number): string {
  return `${(Math.max(0, done) / 1e9).toFixed(1)} of ${(Math.max(0, bytes) / 1e9).toFixed(1)} gigabytes`
}

export function LocalAiSection(props: { reveal: boolean }): JSX.Element {
  const local = useLocalAi()
  const ref = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!props.reveal) return
    ref.current?.scrollIntoView({ block: 'nearest' })
    headingRef.current?.focus({ preventScroll: true })
  }, [props.reveal])

  const act = (what: Promise<LocalAiState | void>): void => {
    setError(null)
    void what.then(
      (state) => {
        if (state) setLocalAiState(state)
        else loadLocalAiState()
      },
      (err: unknown) => {
        const message = ipcMessage(err)
        if (message !== 'Cancelled.') setError(message)
        loadLocalAiState()
      }
    )
  }

  return (
    <section className="settings-section local-ai-section" aria-labelledby="settings-local-ai-title" ref={ref} data-testid="local-ai">
      <h3 id="settings-local-ai-title" ref={headingRef} tabIndex={-1}>
        {LOCAL_AI_COPY.title}
      </h3>
      <p className="hint">{LOCAL_AI_COPY.lead}</p>
      {local.status === 'loading' && <p className="settings-empty">{LOCAL_AI_COPY.checking}</p>}
      {local.status === 'failed' && <p className="local-ai-line">{LOCAL_AI_COPY.failed}</p>}
      {local.status === 'ready' && <Models state={local.state} act={act} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * What the section announces when a download ends (§14: "Recommended is ready"): the models that
 * were downloading in `before` and are ready in `after`.
 */
export function readyAnnouncement(before: LocalAiState | null, after: LocalAiState): string {
  if (!before) return ''
  const done = after.models.filter((m) => m.state === 'ready' && before.models.find((b) => b.id === m.id)?.state === 'downloading')
  return done.map((m) => `${specOf(m.id)?.title ?? m.id} is ready`).join('. ')
}

function Models({ state, act }: { state: LocalAiState; act: (what: Promise<LocalAiState | void>) => void }): JSX.Element {
  // A download that ends is announced once, politely.
  const previous = useRef<LocalAiState | null>(null)
  const [announced, setAnnounced] = useState('')
  useEffect(() => {
    const said = readyAnnouncement(previous.current, state)
    previous.current = state
    if (said) setAnnounced(said)
  }, [state])
  const ready = state.models.filter((m) => m.state === 'ready')
  const nothingYet = !state.models.some((m) => m.state === 'ready' || m.state === 'downloading')
  const suggested = nothingYet ? suggestedModel(state.pc) : null
  const inUse = modelInUse(state)
  const measured = inUse ? state.speeds[inUse] : undefined
  const setUse = (use: LocalModelUse): void => act(window.api.setLocalModelUse(use))
  return (
    <>
      <p className="local-ai-line" data-testid="local-ai-pc">
        {pcLine(state.pc)}
      </p>
      <div className="local-ai-models">
        {state.models.map((m) => (
          <Row key={m.id} m={m} state={state} suggested={suggested === m.id} act={act} />
        ))}
      </div>
      {ready.length > 0 && (
        <fieldset className="local-ai-use" role="radiogroup" aria-label={LOCAL_AI_COPY.use}>
          <legend>{LOCAL_AI_COPY.use}</legend>
          <label>
            <input type="radio" name="local-ai-use" value="auto" checked={state.use === 'auto'} onChange={() => setUse('auto')} />
            {LOCAL_AI_COPY.automatic}
          </label>
          {ready.map((m) => (
            <label key={m.id}>
              <input type="radio" name="local-ai-use" value={m.id} checked={state.use === m.id} onChange={() => setUse(m.id)} />
              {specOf(m.id)?.title ?? m.id}
            </label>
          ))}
        </fieldset>
      )}
      {measured && (
        <p className="local-ai-line" data-testid="local-ai-speed">
          {speedLine(measured)}
        </p>
      )}
      <span className="sr-only" role="status" aria-live="polite" data-testid="local-ai-announce">
        {announced}
      </span>
    </>
  )
}

function Row({ m, state, suggested, act }: { m: LocalModelState; state: LocalAiState; suggested: boolean; act: (what: Promise<LocalAiState | void>) => void }): JSX.Element | null {
  const spec = specOf(m.id)
  const [asking, setAsking] = useState(false)
  // Focus never falls to the page when the row's buttons change: the row's action takes it.
  const actionRef = useRef<HTMLButtonElement>(null)
  const shown = `${m.state}:${asking}`
  const lastShown = useRef(shown)
  useEffect(() => {
    if (lastShown.current === shown) return
    lastShown.current = shown
    const active = document.activeElement
    if (active && active !== document.body) return
    actionRef.current?.focus({ preventScroll: true })
  }, [shown])
  if (!spec) return null
  const why = m.block ? blockReason(spec, m.block, state.pc) : null
  const whyId = `local-ai-why-${m.id}`
  const download = (): void => act(window.api.downloadLocalModel(m.id))
  return (
    <div className="local-ai-model" data-model={m.id} data-state={m.state}>
      <p className="local-ai-head">
        <strong>{spec.title}</strong> · {spec.name} · {sizeGb(m.bytes)}
        {suggested && !why && <span className="local-ai-badge">{LOCAL_AI_COPY.suggested}</span>}
        {m.state === 'ready' && <span className="local-ai-badge ok">{LOCAL_AI_COPY.downloaded}</span>}
      </p>
      <p className="local-ai-hint">{spec.hint}</p>
      <p className="local-ai-licence">
        {spec.licence} · {spec.maker}
      </p>
      {why && (
        <p className="local-ai-why" id={whyId}>
          {why}
        </p>
      )}
      {m.state === 'damaged' && <p className="local-ai-status error">{LOCAL_AI_COPY.damaged}</p>}
      {m.state === 'downloading' && (
        <div className="local-ai-progress">
          <progress max={m.bytes} value={m.done ?? 0} aria-label={`Downloading ${spec.title}`} aria-valuetext={progressValueText(m.done ?? 0, m.bytes)} />
          <span>{progressText(m.done ?? 0, m.bytes)}</span>
        </div>
      )}
      {asking ? (
        <div
          className="ai-remove-question"
          role="alert"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            setAsking(false)
          }}
        >
          <span>{`Remove the ${spec.title} model (${sizeGb(m.bytes)})? AI on this PC cannot use it until it is downloaded again.`}</span>
          <button
            type="button"
            className="btn danger settings-small"
            onClick={() => {
              setAsking(false)
              act(window.api.removeLocalModel(m.id))
            }}
          >
            {LOCAL_AI_COPY.remove}
          </button>
          <button type="button" className="btn ghost settings-small" autoFocus onClick={() => setAsking(false)}>
            {LOCAL_AI_COPY.cancel}
          </button>
        </div>
      ) : (
        <div className="local-ai-actions">
          {(m.state === 'missing' || m.state === 'damaged') && !why && (
            <button ref={actionRef} type="button" className="btn settings-small" aria-label={downloadName(spec, m.bytes)} onClick={download}>
              {m.state === 'damaged' ? LOCAL_AI_COPY.downloadAgain : LOCAL_AI_COPY.download}
            </button>
          )}
          {m.state === 'downloading' && (
            <button ref={actionRef} type="button" className="btn ghost settings-small" aria-label={`Cancel the download of ${spec.title}`} onClick={() => act(window.api.cancelLocalDownload(m.id))}>
              {LOCAL_AI_COPY.cancel}
            </button>
          )}
          {m.state === 'ready' && (
            <button ref={actionRef} type="button" className="btn ghost danger settings-small" aria-label={`Remove ${spec.title}`} onClick={() => setAsking(true)}>
              {LOCAL_AI_COPY.remove}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Settings › AI providers' first row (§2.5): "On this PC · no key · good for drafts" with Set up
 * (which opens Settings at AI on this PC), or "Using Recommended" once a model is there.
 */
export function LocalAiRow(props: { onOpen(): void }): JSX.Element {
  const local = useLocalAi()
  const id = local.status === 'ready' ? modelInUse(local.state) : null
  const spec = id ? specOf(id) : undefined
  return (
    <div className="ai-provider local-ai-row" data-testid="local-ai-row">
      <div className="ai-provider-main">
        <div className="ai-provider-title">
          <strong className="ai-provider-name">On this PC</strong>
          <span className="ai-provider-meta">no key · good for drafts</span>
        </div>
      </div>
      {spec ? (
        <span className="local-ai-using">{`Using ${spec.title}`}</span>
      ) : (
        <button type="button" className="btn settings-small" onClick={props.onOpen} aria-label={`Set up ${LOCAL_AI_COPY.title}`}>
          Set up
        </button>
      )}
    </div>
  )
}
