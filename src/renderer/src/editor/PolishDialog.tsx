import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AiProviderInfo } from '../../../shared/api/ai'
import { DEFAULT_POLISH_OPTIONS, polishAvailability, polishTranscriber, POLISH_STEPS, readPolishOptions, type PolishOptions, type PolishResult, type PolishStep, type PolishSummary } from '../../../shared/editor/polish'
import {
  CANCELLED_NOTICE,
  CHANGED_SINCE,
  KEEP_LOOK,
  LOOKING_FOR_PROVIDERS,
  NOTHING_CHOSEN,
  POLISH_FOOTNOTE,
  POLISH_LEAD,
  POLISH_TITLE,
  polishFailed,
  polishHeadline,
  polishHint,
  polishResultLines,
  polishSkipText,
  polishStepLabel,
  SILENCE_ACTION_CHIPS,
  transcriberLabel,
  UNDONE_NOTICE
} from '../../../shared/editor/polishCopy'
import { BUILT_IN_PRESETS, parseUserPresets, type StylePreset } from '../../../shared/editor/stylePresets'
import { zoomSettingsOf } from '../../../shared/engine/zoom'
import type { CursorTrack, Project } from '../../../shared/types'
import { OPEN_SETTINGS_EVENT } from '../settings/SettingsButton'
import { onTranscriptionJob, transcriptionJob } from './captionItems'
import { useEditor } from './context'
import { Chips } from './controls'
import { EditorIcon } from './EditorIcon'
import { useModalFocus } from './modalFocus'
import { LOCAL_TRANSCRIBER_ID } from '../../../shared/api/speech'
import { BANGLA_MODEL } from '../../../shared/speech/catalog'
import { SPEECH_COPY } from '../../../shared/speech/speechCopy'
import { availableState, onSpeechRead, spokenLanguage, useSpeechState } from './speechState'
import { runPolish, type PolishRowState, type PolishRun } from './polishRunner'
import './polish.css'
import { keepVersionBefore } from '../versions/autoVersion'

type View =
  | { kind: 'options' }
  | { kind: 'running'; rows: Record<PolishStep, PolishRowState> }
  | { kind: 'summary'; before: Project; after: Project; result: PolishResult }
  | { kind: 'failed'; message: string }

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A row's state as a small mark: waiting, a spinner while it works, a tick when done, a dash when skipped. */
function RowMark({ phase }: { phase: PolishRowState['phase'] | 'changed' | 'unchanged' | 'skipped' }): JSX.Element {
  if (phase === 'working') return <span className="polish-spinner" aria-hidden="true" />
  if (phase === 'done' || phase === 'changed') return <EditorIcon name="check" size={14} />
  if (phase === 'unchanged') return <span className="polish-mark same" aria-hidden="true" />
  return <span className={`polish-mark ${phase === 'skipped' ? 'off' : ''}`} aria-hidden="true" />
}

/**
 * "Polish in one click" (docs/design/polish-in-one-click.md §5): the options (one row per step,
 * remembered in the 'polish' preference), the run with each row's progress, Skip and Cancel,
 * then the summary of the one undo step it made, with Undo polish. Modal: it does not close on a
 * backdrop click, and Esc is Cancel (Done in the summary).
 */
export function PolishDialog(props: {
  recorded: CursorTrack
  hasCameraFile: boolean
  /** Closed without a polish to report; `notice` says why (cancelled, undone). */
  onClose: (notice?: string) => void
  onDone: (r: { changed: boolean; clipsChanged: boolean; summary: PolishSummary }) => void
}): JSX.Element {
  const { recorded, hasCameraFile, onClose, onDone } = props
  const services = useEditor()
  const { store } = services
  const project = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const job = useSyncExternalStore(onTranscriptionJob, transcriptionJob)
  const [options, setOptions] = useState<PolishOptions | null>(null)
  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null)
  const [userPresets, setUserPresets] = useState<StylePreset[] | null>(null)
  const [view, setView] = useState<View>({ kind: 'options' })
  const runRef = useRef<PolishRun | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLButtonElement>(null)

  // The remembered options, the user's presets and the AI providers, read once when it opens.
  useEffect(() => {
    let alive = true
    const api = window.api
    api.getPref('polish').then(
      (raw) => alive && setOptions(readPolishOptions(raw)),
      () => alive && setOptions({ ...DEFAULT_POLISH_OPTIONS })
    )
    api.getPref('stylePresets').then(
      (raw) => alive && setUserPresets(parseUserPresets(raw)),
      () => alive && setUserPresets([])
    )
    api.listAiProviders().then(
      (list) => alive && setProviders(Array.isArray(list) ? list : []),
      () => alive && setProviders([])
    )
    return () => {
      alive = false
    }
  }, [])

  // Closing the dialog (or the editor) stops a run: nothing is written.
  useEffect(() => () => runRef.current?.cancel(), [])

  const capable = (providers ?? []).filter((p) => !!p.transcriptionModel)
  // Captions on this PC (offline-captions §3.8): wait for both the providers and the speech state.
  const speech = useSpeechState()
  const local = availableState(speech)
  // The Captions tab's spoken language this session: Bengali uses the Bangla model once it is downloaded (§14.4).
  const spoken = useSyncExternalStore(onSpeechRead, spokenLanguage)
  const transcriber = providers && options && speech.status !== 'loading' ? polishTranscriber(providers, speech.status === 'ready' ? speech.state : null, options.captionsProvider, spoken) : null
  const chosenId = transcriber && 'providerId' in transcriber ? transcriber.providerId : transcriber?.skip === 'no-model' ? LOCAL_TRANSCRIBER_ID : null
  const available = polishAvailability(project, recorded, {
    hasCameraFile,
    transcribers: providers && speech.status !== 'loading' ? (chosenId ? [{ id: chosenId }] : []) : null,
    transcribing: !!job?.running,
    localNotReady: transcriber !== null && 'skip' in transcriber && transcriber.skip === 'no-model'
  })
  const provider = chosenId && chosenId !== LOCAL_TRANSCRIBER_ID ? (capable.find((p) => p.id === chosenId) ?? null) : null
  const choices = [...(local ? [{ id: LOCAL_TRANSCRIBER_ID, label: SPEECH_COPY.localOption }] : []), ...capable.map((p) => ({ id: p.id, label: transcriberLabel(p) }))]
  const presets = [...BUILT_IN_PRESETS, ...(userPresets ?? [])]
  const styleFound = !!options?.styleId && presets.some((p) => p.id === options.styleId)
  const ready = !!options && providers !== null && userPresets !== null && speech.status !== 'loading'
  /** Whether a row is on: chosen and able to run (a row that cannot run shows unchecked; the remembered option stays). */
  const isOn = (step: PolishStep): boolean => !!options && (step === 'style' ? styleFound : options[step] && !available[step])
  const anything = POLISH_STEPS.some(isOn)

  // The view's main button takes the focus; the panel itself while that button is disabled (the
  // options are read, or no step can run), as a disabled button does not take it.
  useEffect(() => {
    const main = mainRef.current
    ;(main && !main.disabled ? main : boxRef.current)?.focus({ preventScroll: true })
  }, [view.kind, ready])

  const set = (patch: Partial<PolishOptions>): void => setOptions((o) => (o ? { ...o, ...patch } : o))

  const start = (): void => {
    if (!options || !ready || !anything || runRef.current) return
    // E-12: the edit before is kept as a version (docs/design/versions.md §2.4).
    void keepVersionBefore(store.state, 'polish')
    const chosen: PolishOptions = { ...options, styleId: styleFound ? options.styleId : null }
    window.api.setPref('polish', chosen).catch((err: unknown) => console.warn('The polish options could not be saved:', err))
    const make = transcriber && 'providerId' in transcriber ? transcriber : null
    const run = runPolish(
      services,
      recorded,
      chosen,
      { hasCameraFile, providerId: make?.providerId ?? null, ...(make?.model ? { model: make.model } : {}), ...(make?.language ? { language: make.language } : {}), userPresets: userPresets ?? [] },
      (rows) => setView({ kind: 'running', rows })
    )
    runRef.current = run
    run.done.then(
      (r) => {
        if (runRef.current !== run) return
        runRef.current = null
        if (r) setView({ kind: 'summary', ...r })
      },
      (err: unknown) => {
        if (runRef.current !== run) return
        runRef.current = null
        console.error('polish: planning failed', err)
        setView({ kind: 'failed', message: polishFailed(errorText(err)) })
      }
    )
  }

  const cancel = (): void => {
    const run = runRef.current
    runRef.current = null
    run?.cancel()
    onClose(run ? CANCELLED_NOTICE : undefined)
  }

  const finish = (): void => {
    if (view.kind !== 'summary') return onClose()
    const { before, after, result } = view
    onDone({ changed: after !== before, clipsChanged: after.clips !== before.clips, summary: result.summary })
  }

  const undoPolish = (): void => {
    if (view.kind !== 'summary' || store.state !== view.after || view.after === view.before) return
    store.undo()
    onClose(UNDONE_NOTICE)
  }

  const addProvider = (): void => {
    // Settings is a dialog of its own: this one closes first, and reads the providers again when it opens.
    onClose()
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'ai' } }))
  }

  useModalFocus(boxRef, () => (view.kind === 'summary' ? finish() : view.kind === 'failed' ? onClose() : cancel()))

  /* ---------- options ---------- */

  const optionRow = (step: PolishStep): JSX.Element => {
    const label = polishStepLabel(step)
    const loading = step === 'captions' && (providers === null || speech.status === 'loading')
    const why = loading ? null : available[step]
    const hint = loading
      ? LOOKING_FOR_PROVIDERS
      : why
        ? polishSkipText(step, why)
        : polishHint(step, {
            silenceAction: options?.silenceAction ?? 'cut',
            autoZoomOn: zoomSettingsOf(project).auto.enabled,
            provider,
            local: chosenId === LOCAL_TRANSCRIBER_ID,
            bangla: !!transcriber && 'model' in transcriber && transcriber.model === BANGLA_MODEL
          })
    const disabled = !ready || loading || !!why
    return (
      <li key={step} className="polish-row" data-testid={`polish-row-${step}`} data-available={!loading && !why}>
        {step === 'style' ? (
          <label className="polish-style">
            <span>{label}</span>
            <select aria-label="Style preset" value={styleFound ? (options?.styleId ?? '') : ''} disabled={!ready} onChange={(e) => set({ styleId: e.target.value || null })}>
              <option value="">{KEEP_LOOK}</option>
              {BUILT_IN_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              {!!userPresets?.length && (
                <optgroup label="Your presets">
                  {userPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        ) : (
          <label className={`toggle ${disabled ? 'disabled' : ''}`}>
            <span>{label}</span>
            <input type="checkbox" aria-label={label} checked={isOn(step)} disabled={disabled} onChange={(e) => set({ [step]: e.target.checked })} />
          </label>
        )}
        <p className="hint">{hint}</p>
        {step === 'silences' && !why && options?.silences && (
          <Chips label="Silence action" value={options.silenceAction} onChange={(silenceAction) => set({ silenceAction })} options={[...SILENCE_ACTION_CHIPS]} />
        )}
        {step === 'captions' && (!why || why === 'no-model') && options?.captions && choices.length > 1 && (
          <select className="polish-provider" aria-label="Transcription provider" value={chosenId ?? ''} onChange={(e) => set({ captionsProvider: e.target.value })}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        {step === 'captions' && why === 'no-provider' && (
          <button className="btn small" onClick={addProvider}>
            <EditorIcon name="gear" size={14} /> Add an AI provider
          </button>
        )}
      </li>
    )
  }

  /* ---------- running and summary ---------- */

  const runningRow = (step: PolishStep, row: PolishRowState): JSX.Element => (
    <li key={step} className="polish-row running" data-testid={`polish-row-${step}`} data-phase={row.phase}>
      <RowMark phase={row.phase} />
      <span className="polish-name">{polishStepLabel(step)}</span>
      <span className="polish-text" role={row.phase === 'working' ? 'status' : undefined}>
        {row.text}
      </span>
      {row.canSkip && (
        <button className="btn ghost small" onClick={() => (step === 'captions' ? runRef.current?.skipCaptions() : runRef.current?.skipFace())}>
          Skip
        </button>
      )}
    </li>
  )

  let body: JSX.Element
  let foot: JSX.Element
  if (view.kind === 'options') {
    body = (
      <>
        <p className="hint">{POLISH_LEAD}</p>
        <ul className="polish-rows">{POLISH_STEPS.map(optionRow)}</ul>
      </>
    )
    foot = (
      <>
        <button className="btn" onClick={cancel}>
          Cancel
        </button>
        <button ref={mainRef} className="btn primary" disabled={!ready || !anything} title={ready && !anything ? NOTHING_CHOSEN : undefined} onClick={start}>
          <EditorIcon name="sparkle" size={16} /> Polish
        </button>
      </>
    )
  } else if (view.kind === 'running') {
    body = <ul className="polish-rows">{POLISH_STEPS.map((step) => runningRow(step, view.rows[step]))}</ul>
    foot = (
      <button ref={mainRef} className="btn" onClick={cancel}>
        Cancel
      </button>
    )
  } else if (view.kind === 'summary') {
    const changed = view.after !== view.before
    const canUndo = changed && project === view.after
    body = (
      <div className="polish-summary" data-testid="polish-summary" data-changed={changed}>
        <p className="polish-headline" role="status">
          {polishHeadline(view.result.summary, changed)}
        </p>
        <ul className="polish-rows">
          {polishResultLines(view.result.summary).map((line) => (
            <li key={line.step} className="polish-row result" data-testid={`polish-line-${line.step}`} data-status={line.status}>
              <RowMark phase={line.status} />
              <span className="polish-text">{line.text}</span>
            </li>
          ))}
        </ul>
        {changed && <p className="hint">{POLISH_FOOTNOTE}</p>}
      </div>
    )
    foot = (
      <>
        {changed && (
          <button className="btn" disabled={!canUndo} title={canUndo ? undefined : CHANGED_SINCE} onClick={undoPolish}>
            <EditorIcon name="undo" size={16} /> Undo polish
          </button>
        )}
        <button ref={mainRef} className="btn primary" onClick={finish}>
          Done
        </button>
      </>
    )
  } else {
    body = (
      <p className="callout" role="alert">
        <EditorIcon name="alert" size={16} />
        <span>{view.message}</span>
      </p>
    )
    foot = (
      <button ref={mainRef} className="btn primary" onClick={() => onClose()}>
        Done
      </button>
    )
  }

  return (
    <div className="overlay modal-backdrop">
      <div className="polish-dialog" role="dialog" aria-modal="true" aria-labelledby="polish-title" ref={boxRef} tabIndex={-1} data-view={view.kind}>
        <header className="modal-head">
          <h2 id="polish-title">
            <EditorIcon name="sparkle" size={18} /> {POLISH_TITLE}
          </h2>
        </header>
        {body}
        <footer className="modal-foot">{foot}</footer>
      </div>
    </div>
  )
}
