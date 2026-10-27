import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { AiProviderInfo, TranscribeOptions } from '../../../../shared/api/ai'
import { LOCAL_TRANSCRIBER_ID, type SpeechModelView, type SpeechState } from '../../../../shared/api/speech'
import { BANGLA_MODEL, isBengali, speechModel, type SpeechModelId } from '../../../../shared/speech/catalog'
import { localErrorCode, quickerModel } from '../../../../shared/speech/errors'
import { estimateSeconds, nextTimeLeft, sizeWords } from '../../../../shared/speech/estimate'
import {
  announceLine,
  banglaBlockedLine,
  barText,
  cancelledLine,
  chipLabel,
  consentBody,
  consentTitle,
  continueDownload,
  deletePartLabel,
  diskLine,
  downloadAgainLabel,
  downloadBusyLine,
  downloadButton,
  downloadFailed,
  downloadSpaceNeeded,
  downloadingLine,
  estimateLine,
  heardLine,
  leftWords,
  memoryWarning,
  phaseLine,
  resumedLine,
  retryingLine,
  slowerLine,
  smallPrint,
  SPEECH_COPY,
  stoppedLine,
  tierPurpose,
  useInstalledLabel,
  useTierLabel,
  type LocalPhase
} from '../../../../shared/speech/speechCopy'
import { localModel } from '../../../../shared/speech/transcriber'
import type { Project, Transcript } from '../../../../shared/types'
import { clearTranscriptionError, type TranscriptionJob } from '../captionItems'
import { EditorIcon } from '../EditorIcon'
import {
  cancelLocalCaptions,
  captionsIntent,
  chooseModel,
  dropIntent,
  downloadThenCaptions,
  keptParts,
  loadSpeechState,
  modelView,
  offered,
  onSpeechRead,
  otherDownload,
  setSpokenLanguage
} from '../speechState'

/*
 * The Captions tab's "On this PC" transcriber (docs/design/offline-captions.md §7.1-7.2, §7.7):
 * the quality chips, the consent card and download, the ready, running, cancelled and error
 * states. Every sentence is speechCopy.ts or errors.ts; this file is layout and behaviour.
 */

/** Opens the app settings at a section (the settings dialog listens for it). */
export const openSettings = (section: 'ai' | 'speech'): void => void window.dispatchEvent(new CustomEvent('ssw:open-settings', { detail: { section } }))

/** Focus fell to the page (a focused button disappeared): put it on `ref` instead. Runs when `key` changes. */
function useCatchFocus(ref: RefObject<HTMLElement>, key: unknown): void {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const active = document.activeElement
    if (active && active !== document.body) return
    ref.current?.focus({ preventScroll: true })
  }, [ref, key])
}

/** Seconds this PC is expected to take for `view` on a recording of `seconds`. */
export const estimateFor = (state: SpeechState, view: SpeechModelView, seconds: number): number => estimateSeconds(view, seconds, state.engine.threads, view.measured, state.engine.build)

/**
 * The chips shown: Fast, Standard, Accurate, Most accurate only once downloaded and allowed here,
 * and Bangla only for Bengali where it is allowed (speechState.offered).
 */
const chipModels = (state: SpeechState, chosen: SpeechModelId, language: string): SpeechModelView[] => state.models.filter((m) => offered(m, chosen, language))

/**
 * The Bangla model's line under the chips (docs/design/offline-captions.md §14.4), or null:
 * Bengali with another chip picked ('choose'), Bengali where it is not allowed ('blocked', with
 * the reason), or Detect automatically with it downloaded ('detect').
 */
export function banglaLine(state: Pick<SpeechState, 'models'>, model: SpeechModelId, language: string): { kind: 'choose' | 'blocked' | 'detect'; text: string } | null {
  const bangla = modelView(state, BANGLA_MODEL)
  if (!bangla) return null
  if (isBengali(language)) {
    if (!bangla.allowed) return { kind: 'blocked', text: banglaBlockedLine(bangla.reason ?? '') }
    return model !== bangla.id ? { kind: 'choose', text: SPEECH_COPY.banglaHint } : null
  }
  return !language && bangla.allowed && bangla.status.state === 'installed' ? { kind: 'detect', text: SPEECH_COPY.banglaDetect } : null
}

/* ---------- quality ---------- */

/**
 * The "Quality" radio group (visible labels carry the size or "Downloaded"), the tier's
 * purpose, the estimate for this recording, the slow-PC lines, the Bangla model's line and the
 * link to Settings. A chip chooses for this app session only: it never changes the default model.
 */
export function LocalQuality({
  state,
  model,
  project,
  chipsRef,
  language = ''
}: {
  state: SpeechState
  model: SpeechModelId
  project: Pick<Project, 'duration'>
  chipsRef: RefObject<HTMLDivElement>
  /** The spoken language ('' detects): the Bangla chip only for Bengali. */
  language?: string
}): JSX.Element {
  const models = chipModels(state, model, language)
  const view = modelView(state, model)
  const estimate = view ? estimateFor(state, view, project.duration) : 0
  const bangla = banglaLine(state, model, language)
  const pick = (id: SpeechModelId): void => {
    chooseModel(id, language)
    clearTranscriptionError()
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    // Handled here: the editor's window keydown handler would also step the playhead on Left and Right.
    e.preventDefault()
    e.stopPropagation()
    const i = Math.max(0, models.findIndex((m) => m.id === model))
    const next = models[(i + step + models.length) % models.length]
    pick(next.id)
    const button = chipsRef.current?.querySelector<HTMLElement>(`[data-model="${next.id}"]`)
    button?.focus()
  }
  return (
    <>
      <div className="field">
        <span id="local-quality-label">{SPEECH_COPY.qualityLabel}</span>
        <div className="chips local-chips" role="radiogroup" aria-labelledby="local-quality-label" data-testid="local-model" ref={chipsRef} onKeyDown={onKey}>
          {models.map((m) => {
            const { label, name } = chipLabel(m)
            const on = m.id === model
            return (
              <button key={m.id} type="button" role="radio" aria-checked={on} aria-label={name} tabIndex={on ? 0 : -1} data-model={m.id} className={`chip ${on ? 'active' : ''}`} onClick={() => pick(m.id)}>
                {label}
              </button>
            )
          })}
        </div>
      </div>
      {view && (
        <div className="local-quality-notes">
          <p className="hint">{tierPurpose(view.tier)}</p>
          <p className="hint" data-testid="local-estimate">
            {estimateLine(view, estimate)}
          </p>
          {state.engine.build === 'compatible' && <p className="hint warn">{SPEECH_COPY.compatibleBuild}</p>}
          {estimate > project.duration && project.duration > 0 && <p className="hint warn">{slowerLine(estimate)}</p>}
          {bangla && (
            <p className={`hint ${bangla.kind === 'detect' ? '' : 'warn'}`} data-testid="bangla-hint" data-kind={bangla.kind}>
              {bangla.text}
              {bangla.kind === 'detect' && (
                <>
                  {' '}
                  <button type="button" className="link" onClick={() => setSpokenLanguage('bn')}>
                    {SPEECH_COPY.chooseBengali}
                  </button>
                </>
              )}
            </p>
          )}
          <button type="button" className="link" onClick={() => openSettings('speech')}>
            {SPEECH_COPY.manageModels}
          </button>
        </div>
      )}
    </>
  )
}

/* ---------- the state of captions on this PC ---------- */

export type LocalState = 'no-sound' | 'needs-model' | 'downloading' | 'verifying' | 'stopped' | 'download-failed' | 'ready' | 'cancelled' | 'error'

/**
 * The block's state for the chosen model and spoken `language` ('' detects); running and done are
 * shown by the Generate section itself.
 */
export function localState(view: SpeechModelView, project: Pick<Project, 'id' | 'hasAudio'>, job: TranscriptionJob | null, language = ''): LocalState {
  if (!project.hasAudio) return 'no-sound'
  const code = job?.error ? localErrorCode(job.error) : null
  if (job?.error && code !== 'no-model') return 'error'
  switch (view.status.state) {
    case 'installed':
      return (keptParts(project.id, view.id, language)?.kept ?? 0) > 0 ? 'cancelled' : 'ready'
    case 'downloading':
      return 'downloading'
    case 'verifying':
      return 'verifying'
    case 'stopped':
      return 'stopped'
    case 'failed':
      return 'download-failed'
    default:
      return 'needs-model'
  }
}

const online = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false

/** Space a download of `view` still needs: the bytes to fetch and the spare the main process keeps. */
const spaceNeeded = (view: SpeechModelView): number => {
  const s = view.status
  return downloadSpaceNeeded(view.id, s.state === 'stopped' || s.state === 'failed' || s.state === 'downloading' ? s.received : 0)
}

/**
 * Everything after the shared language and sound fields when "On this PC" is chosen: the
 * consent card, the download, the ready controls and the errors. `focusRequest` (the "Generate
 * captions" command) focuses the primary control, which is focusable even when aria-disabled.
 */
export function LocalAction({
  state,
  model,
  project,
  job,
  options,
  capable,
  listError,
  reload,
  focusRequest,
  chipsRef,
  onUseProvider,
  onStart,
  confirmReplace
}: {
  state: SpeechState
  model: SpeechModelId
  project: Project
  job: TranscriptionJob | null
  options: Omit<TranscribeOptions, 'providerId' | 'model'>
  capable: AiProviderInfo[]
  listError: string | null
  reload: () => void
  focusRequest: number
  chipsRef: RefObject<HTMLDivElement>
  onUseProvider: (id: string) => void
  /** Starts captions with the downloaded `model` (asks before replacing captions); false when the user said no. */
  onStart: (model: SpeechModelId) => void
  /** Asks before captions replace the current ones (true when there are none); a download that makes captions asks at the click. */
  confirmReplace: () => boolean
}): JSX.Element | null {
  const intent = useSyncExternalStore(onSpeechRead, () => captionsIntent(project.id))
  const [, setTick] = useState(0)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const view = modelView(state, model)
  const ls = view ? localState(view, project, job, options.language) : 'needs-model'
  const estimate = view ? estimateFor(state, view, project.duration) : 0
  const lm = localModel(state)

  // The command: the primary control gets the focus (download, Continue, Cancel or Generate).
  const handled = useRef(0)
  useEffect(() => {
    if (!focusRequest || focusRequest === handled.current) return
    handled.current = focusRequest
    primaryRef.current?.focus()
  }, [focusRequest])
  // Focus never falls to the page: Download → Cancel → (verifying) the card's heading.
  useCatchFocus(ls === 'verifying' ? headingRef : primaryRef, ls)
  // navigator.onLine changes are shown as they happen.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const on = (): void => setTick((n) => n + 1)
    window.addEventListener('online', on)
    window.addEventListener('offline', on)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', on)
    }
  }, [])

  if (!view) return null
  const download = (id: SpeechModelId = model): void => {
    if (otherDownload(state, id) || !confirmReplace()) return
    clearTranscriptionError()
    void downloadThenCaptions(project.id, id, { ...options, providerId: LOCAL_TRANSCRIBER_ID, model: id })
  }
  // While another model downloads, the buttons that download `id` are aria-disabled with this line.
  const busyProps = (id: SpeechModelId): { 'aria-disabled'?: 'true'; 'aria-describedby'?: string } =>
    otherDownload(state, id) ? { 'aria-disabled': 'true', 'aria-describedby': 'local-download-why' } : {}
  const busyLine = (id: SpeechModelId): ReactNode => {
    const busy = otherDownload(state, id)
    return busy ? (
      <p className="hint warn" id="local-download-why">
        {downloadBusyLine(busy.id, id)}
      </p>
    ) : null
  }
  const cancelDownload = (discard = false): void => {
    dropIntent(project.id)
    void window.api.cancelSpeechDownload(view.id, discard).catch((err: unknown) => console.warn('The download could not be stopped:', err))
  }
  const noKeys = capable.length === 0
  const cloud = noKeys ? (
    <div className="local-cloud">
      <button type="button" className="link" onClick={() => openSettings('ai')}>
        {SPEECH_COPY.preferCloud}
      </button>
      {listError && (
        <p className="hint warn">
          Your providers could not be read: {listError}{' '}
          <button type="button" className="link" onClick={reload}>
            {SPEECH_COPY.checkAgain}
          </button>
        </p>
      )}
    </div>
  ) : null

  const box = (children: ReactNode, extra?: ReactNode): JSX.Element => (
    <>
      <div className="local-captions" data-testid="local-captions" data-state={ls} data-model={view.id}>
        {children}
      </div>
      {extra}
    </>
  )

  switch (ls) {
    case 'no-sound':
      return box(<p className="hint warn">{SPEECH_COPY.noSound}</p>)

    case 'needs-model': {
      const button = downloadButton(view.id)
      const lacksSpace = state.disk.free !== null && state.disk.free < spaceNeeded(view)
      const offline = !online()
      const busy = !!otherDownload(state, view.id)
      const blocked = lacksSpace || offline || busy
      const other = lm.installed && lm.model !== view.id ? lm.model : null
      return box(
        <div className="local-card">
          <h4 ref={headingRef} tabIndex={-1}>
            {consentTitle(view.id)}
          </h4>
          <p>{consentBody(view.id, project.duration, estimate)}</p>
          <div className="local-actions">
            <button
              ref={primaryRef}
              type="button"
              className="btn primary"
              data-testid="local-download"
              aria-label={button.name}
              aria-disabled={blocked ? 'true' : undefined}
              aria-describedby={blocked ? 'local-download-why' : undefined}
              onClick={() => !blocked && online() && download()}
            >
              <EditorIcon name="captions" size={15} /> {button.label}
            </button>
            {other && (
              <button type="button" className="btn" data-testid="local-use-installed" onClick={() => onStart(other)}>
                {useInstalledLabel(other)}
              </button>
            )}
          </div>
          {busyLine(view.id)}
          {!busy && lacksSpace && (
            <p className="hint warn" id="local-download-why">
              {diskLine(view.id, state.disk.free!)}{' '}
              <button type="button" className="link" onClick={() => loadSpeechState(true)}>
                {SPEECH_COPY.checkAgain}
              </button>
            </p>
          )}
          {!busy && !lacksSpace && offline && (
            <p className="hint warn" id="local-download-why">
              {SPEECH_COPY.offline(sizeOf(view.id))}
            </p>
          )}
          <p className="local-small">{smallPrint(view.id)}</p>
        </div>,
        cloud
      )
    }

    case 'downloading': {
      const s = view.status as Extract<SpeechModelView['status'], { state: 'downloading' }>
      const share = s.total > 0 ? Math.min(1, s.received / s.total) : 0
      const left = s.bytesPerSecond > 0 ? Math.max(0, s.total - s.received) / s.bytesPerSecond : null
      return box(
        <div className="local-card">
          <h4 ref={headingRef} tabIndex={-1}>
            {consentTitle(view.id)}
          </h4>
          <p className="captions-phase">{downloadingLine(view.id, s)}</p>
          <div
            className="captions-bar"
            role="progressbar"
            aria-label={SPEECH_COPY.downloadBar}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
            aria-valuetext={barText(share, left)}
          >
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
          {s.retrying && <p className="hint warn">{retryingLine(s.retrying)}</p>}
          {intent?.model === view.id && <p className="hint">{SPEECH_COPY.downloadNote}</p>}
          <span className="sr-only" aria-live="polite">
            {`${SPEECH_COPY.downloadBar}: ${Math.floor(share * 4) * 25} percent`}
          </span>
          <div className="local-actions">
            <button ref={primaryRef} type="button" className="btn" onClick={() => cancelDownload()}>
              {SPEECH_COPY.cancel}
            </button>
          </div>
        </div>
      )
    }

    case 'verifying':
      return box(
        <div className="local-card">
          <h4 ref={headingRef} tabIndex={-1}>
            {consentTitle(view.id)}
          </h4>
          <p className="captions-phase">{SPEECH_COPY.verifying}</p>
          <div className="captions-bar busy" role="progressbar" aria-label={SPEECH_COPY.downloadBar} aria-valuetext={SPEECH_COPY.verifying}>
            <span />
          </div>
          <span className="sr-only" aria-live="polite">
            {SPEECH_COPY.verifying}
          </span>
        </div>
      )

    case 'stopped': {
      const s = view.status as Extract<SpeechModelView['status'], { state: 'stopped' }>
      return box(
        <div className="local-card">
          <h4 ref={headingRef} tabIndex={-1}>
            {consentTitle(view.id)}
          </h4>
          <p>{stoppedLine(s)}</p>
          <div className="local-actions">
            <button ref={primaryRef} type="button" className="btn primary" {...busyProps(view.id)} onClick={() => download()}>
              {continueDownload}
            </button>
            <button type="button" className="btn ghost" onClick={() => cancelDownload(true)}>
              {deletePartLabel(s.received)}
            </button>
          </div>
          {busyLine(view.id)}
        </div>,
        cloud
      )
    }

    case 'download-failed': {
      const s = view.status as Extract<SpeechModelView['status'], { state: 'failed' }>
      const failed = downloadFailed(view.id, s, state.disk.free)
      // One button whatever it does, so the focus stays on it when Check again finds room and it becomes Try again.
      const action =
        failed.action === 'try-again'
          ? { label: SPEECH_COPY.tryAgain, run: () => download() }
          : failed.action === 'check-again'
            ? { label: SPEECH_COPY.checkAgain, run: () => loadSpeechState(true) }
            : { label: SPEECH_COPY.chooseAnother, run: () => chipsRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus() }
      return box(
        <div className="local-card">
          <div className="captions-error" role="alert">
            <p>{failed.text}</p>
            <div className="local-actions">
              <button ref={primaryRef} type="button" className="btn" {...(failed.action === 'try-again' ? busyProps(view.id) : {})} onClick={action.run}>
                {action.label}
              </button>
              {failed.action === 'choose-tier' && capable.length > 0 && (
                <button type="button" className="btn ghost" onClick={() => onUseProvider(capable[0].id)}>
                  {SPEECH_COPY.useProvider}
                </button>
              )}
            </div>
          </div>
          {failed.action === 'try-again' && busyLine(view.id)}
        </div>,
        cloud
      )
    }

    case 'error': {
      const code = localErrorCode(job!.error!)
      const failedModel = speechModel(job?.local?.model) ? (job!.local!.model as SpeechModelId) : view.id
      const quicker = code === 'memory' ? quickerModel(failedModel) : null
      return box(
        <>
          <div className="captions-error" role="alert">
            <p>Captions could not be made: {job!.error}</p>
            <div className="local-actions">
              {code === 'damaged' && (
                <button ref={primaryRef} type="button" className="btn" {...busyProps(failedModel)} onClick={() => download(failedModel)}>
                  {downloadAgainLabel(failedModel)}
                </button>
              )}
              {quicker && (
                <button
                  ref={primaryRef}
                  type="button"
                  className="btn"
                  onClick={() => {
                    chooseModel(quicker.id)
                    clearTranscriptionError()
                  }}
                >
                  {useTierLabel(quicker.id)}
                </button>
              )}
              {(code === 'crashed' || code === 'stalled') && (
                <button ref={primaryRef} type="button" className="btn" onClick={() => onStart(failedModel)}>
                  {SPEECH_COPY.generateAgain}
                </button>
              )}
              <button type="button" className="link" onClick={clearTranscriptionError}>
                Dismiss
              </button>
            </div>
          </div>
          {code === 'damaged' && busyLine(failedModel)}
        </>
      )
    }

    case 'ready':
    case 'cancelled': {
      const kept = ls === 'cancelled' ? keptParts(project.id, view.id, options.language) : null
      const memory = memoryWarning(view.id, state.memory.free)
      return box(
        <>
          {kept && <p className="hint">{cancelledLine(kept.kept, kept.parts)}</p>}
          {memory && (
            <p className="hint warn" role="status">
              {memory}
            </p>
          )}
          <div className="row start captions-actions">
            <button ref={primaryRef} type="button" className="btn primary" data-testid="local-generate" onClick={() => onStart(view.id)}>
              <EditorIcon name="captions" size={15} /> {project.transcript ? 'Regenerate' : SPEECH_COPY.generate}
            </button>
          </div>
          <p className="hint">{SPEECH_COPY.readyHint}</p>
        </>
      )
    }
  }
}

const sizeOf = (id: SpeechModelId): string => sizeWords(speechModel(id)!.bytes)

/* ---------- running ---------- */

/** The phase of a running job on this PC. */
function phaseOf(job: TranscriptionJob): LocalPhase {
  if (job.stopping) return 'stopping'
  const p = job.progress
  if (!p || p.phase === 'extracting') return 'preparing'
  if (p.phase === 'loading') return 'loading'
  if (p.phase === 'finishing') return 'finishing'
  return 'transcribing'
}

/**
 * A job on this PC while it runs: the phase in recording time, the time left, a bar, the newest
 * words heard, parts taken from an earlier run, and Cancel. The visible block is not a live
 * region (it changes every second); a hidden one speaks phase changes and every 25 %.
 */
export function LocalRunning({ job, duration }: { job: TranscriptionJob; duration: number }): JSX.Element {
  const p = job.progress
  const phase = phaseOf(job)
  const share = p ? (p.fraction ?? (p.total > 0 && p.done > 0 ? p.done / p.total : null)) : null
  const [, setNow] = useState(0)
  // The clock: the time left counts down between progress lines (a long part reports rarely).
  useEffect(() => {
    const timer = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  // The time left from the work done since the last part taken from an earlier run (each comes in
  // a fraction of a second and would make the speed look infinite: the start moves with `resumed`),
  // updated when the share moves.
  const timing = useRef<{ f0: number; t0: number; share: number; left: number | null; at: number; resumed: number } | null>(null)
  if (share !== null && phase === 'transcribing') {
    const now = Date.now()
    const resumed = p?.resumed ?? 0
    const t = timing.current
    if (!t || resumed !== t.resumed) timing.current = { f0: share, t0: now, share, left: null, at: now, resumed }
    else if (share !== t.share && t.f0 < 1) {
      const done = (share - t.f0) / (1 - t.f0)
      const left = nextTimeLeft(t.left === null ? null : Math.max(0, t.left - (now - t.at) / 1000), (now - t.t0) / 1000, done)
      timing.current = { ...t, share, left, at: now }
    }
  }
  const t = timing.current
  const left = { current: t && t.left !== null ? Math.max(0, t.left - (Date.now() - t.at) / 1000) : null }
  const cancelRef = useRef<HTMLButtonElement>(null)
  useCatchFocus(cancelRef, phase)
  const quarter = share === null ? 0 : Math.floor(Math.min(1, share) * 4)
  const part = p && p.total > 0 ? Math.min(p.done + 1, p.total) : 1
  return (
    <div className="local-captions" data-testid="local-captions" data-state="running" data-part={part} data-parts={p?.total ?? 0}>
      <div className="captions-progress">
        <span className="captions-phase">{phaseLine(phase, phase === 'transcribing' ? (p?.at ?? undefined) : undefined, duration)}</span>
        {phase === 'transcribing' && <span className="hint">{left.current === null ? SPEECH_COPY.workingOutLeft : leftWords(left.current)}</span>}
        <div
          className={`captions-bar ${share === null ? 'busy' : ''}`}
          role="progressbar"
          aria-label={SPEECH_COPY.jobBar}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share === null ? undefined : Math.round(share * 100)}
          aria-valuetext={share === null ? phaseLine(phase) : barText(share, left.current)}
        >
          <span style={share === null ? undefined : { width: `${Math.round(share * 100)}%` }} />
        </div>
        {p?.preview && <p className="local-heard">{heardLine(p.preview)}</p>}
        {!!p?.resumed && p.total > 0 && <p className="hint">{resumedLine(p.resumed, p.total)}</p>}
        <p className="hint">{SPEECH_COPY.runningNote}</p>
        <span className="sr-only" aria-live="polite">
          {announceLine(phase, quarter)}
        </span>
      </div>
      <button ref={cancelRef} type="button" className="btn" onClick={cancelLocalCaptions} disabled={!!job.stopping}>
        {SPEECH_COPY.cancel}
      </button>
    </div>
  )
}

/* ---------- the Bangla model offered after a run ---------- */

/**
 * Whether the summary of `transcript` offers the Bangla model: captions made on this PC in
 * Bengali with another model, and the Bangla model allowed here (docs/design/offline-captions.md §14.4).
 */
export function banglaOfferApplies(state: Pick<SpeechState, 'models' | 'engine'> | null, transcript: Pick<Transcript, 'provider' | 'model' | 'language'> | undefined): boolean {
  const bangla = state?.engine.available ? modelView(state, BANGLA_MODEL) : null
  return !!bangla?.allowed && transcript?.provider === 'local' && isBengali(transcript.language) && !speechModel(transcript.model)?.language
}

/**
 * The offer under that summary: why the Bangla model is better, and one button that downloads it
 * and makes the captions again ("Download Bangla model (539 MB) and make captions"), or makes them
 * again once it is here.
 */
export function BanglaOffer({ state, onUse }: { state: SpeechState; onUse: () => void }): JSX.Element | null {
  const bangla = modelView(state, BANGLA_MODEL)
  if (!bangla) return null
  const installed = bangla.status.state === 'installed'
  const button = downloadButton(bangla.id)
  return (
    <div className="local-bangla-offer" data-testid="bangla-offer">
      <p className="hint">{SPEECH_COPY.banglaOffer}</p>
      <button type="button" className="btn primary" data-testid="bangla-offer-button" aria-label={installed ? undefined : button.name} onClick={onUse}>
        <EditorIcon name="captions" size={15} /> {installed ? SPEECH_COPY.banglaAgain : button.label}
      </button>
    </div>
  )
}

/** Fast or Standard: the tiers that make more mistakes in languages other than English. */
export const isSmallTier = (model: string): boolean => {
  const tier = speechModel(model)?.tier
  return tier === 'fast' || tier === 'standard'
}
