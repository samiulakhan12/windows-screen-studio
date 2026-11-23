import { useEffect, useId, useRef, useState } from 'react'
import type { EverywhereRequest, UnderCoverResult } from '../../../shared/api/privacy'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { fmt } from '../../../shared/i18n/fmt'
import { t } from '../../../shared/i18n/t'
import type { EditorServices } from '../editor/context'
import { useModalFocus } from '../editor/modalFocus'
import { forgetUnderCover, readUnderCover, runEverywhere } from './followRun'
import { FindProgressLine, useReaderState } from './readerState'
import './covers.css'

type State =
  | { kind: 'reading' }
  | { kind: 'reader' }
  | { kind: 'noText' }
  | { kind: 'busy' }
  | { kind: 'ready'; nameLike: boolean }
  | { kind: 'running' }
  | { kind: 'done'; added: number }
  | { kind: 'failed' }

const stateOf = (r: UnderCoverResult): State => (r.ok ? { kind: 'ready', nameLike: r.nameLike } : r.reason === 'reader' ? { kind: 'reader' } : r.reason === 'noText' ? { kind: 'noText' } : r.reason === 'busy' ? { kind: 'busy' } : { kind: 'failed' })

/**
 * *Cover this text everywhere* (docs/design/auto-blur.md §2.2, §5.9): a modal dialog labelled by its
 * title. On opening, main reads the text under the cover at the playhead; then the dialog offers the
 * reader's download, says no text was read, or explains, offers to remember a name-like text in this
 * video's or Settings' names (No by default) and runs it, with *Stop*. What it found lands in one
 * undo step; the screen's text is never shown.
 */
export function EverywhereDialog(props: { services: EditorServices; coverId: string; onClose: () => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLButtonElement>(null)
  const [state, setState] = useState<State>({ kind: 'reading' })
  const [remember, setRemember] = useState<EverywhereRequest['remember']>('no')
  const [download, setDownload] = useState<string | null>(null)
  const run = useRef<AbortController | null>(null)
  const reader = useReaderState()
  const uid = `everywhere-${useId().replace(/:/g, '')}`
  const close = (): void => {
    run.current?.abort()
    props.onClose()
  }
  useModalFocus(box, close)

  const read = (): void => {
    setState({ kind: 'reading' })
    void readUnderCover(props.services, props.coverId).then(
      (r) => setState(stateOf(r)),
      () => setState({ kind: 'failed' })
    )
  }
  useEffect(() => {
    read()
    return () => {
      run.current?.abort()
      forgetUnderCover(props.coverId)
    }
    // Read once per cover the dialog is opened for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.coverId])
  useEffect(() => {
    if (state.kind !== 'reading') first.current?.focus()
  }, [state.kind])
  // The reader downloaded meanwhile: read again.
  useEffect(() => {
    if (state.kind === 'reader' && reader?.status === 'ready') read()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader?.status])

  const fetchReader = async (): Promise<void> => {
    setDownload(null)
    try {
      const s = await window.api.downloadReader()
      if (s.status === 'ready') read()
      else if (s.status === 'failed') setDownload(s.reason)
    } catch (err) {
      setDownload(err instanceof Error ? err.message : String(err))
    }
  }

  const start = async (): Promise<void> => {
    const stop = new AbortController()
    run.current = stop
    setState({ kind: 'running' })
    const r = await runEverywhere(props.services, props.coverId, state.kind === 'ready' && state.nameLike ? remember : 'no', stop.signal)
    run.current = null
    setState(r ? { kind: 'done', added: r.added } : { kind: 'failed' })
  }

  let body: JSX.Element
  let foot: JSX.Element
  const closeButton = (main: boolean): JSX.Element => (
    <button ref={main ? first : undefined} type="button" className={main ? 'btn primary' : 'btn'} onClick={close} data-testid="everywhere-close">
      {t(main ? 'common.action.done' : 'common.action.cancel')}
    </button>
  )
  switch (state.kind) {
    case 'reading':
      body = (
        <p role="status" data-testid="everywhere-reading">
          {t(PRIVACY_COPY.everywhere.reading)}
        </p>
      )
      foot = closeButton(false)
      break
    case 'reader': {
      const progress = reader?.status === 'downloading' ? Math.round((reader.done / Math.max(1, reader.total)) * 100) : null
      body = (
        <div data-testid="everywhere-needs-reader">
          <p>{t(PRIVACY_COPY.everywhere.needsReader)}</p>
          {progress !== null && <p role="status">{t(PRIVACY_COPY.find.readerProgress, { percent: fmt.count(progress) })}</p>}
          {download !== null && <p role="alert">{t(PRIVACY_COPY.find.readerFailed, { reason: download })}</p>}
        </div>
      )
      foot = (
        <>
          {closeButton(false)}
          <button ref={first} type="button" className="btn primary" disabled={progress !== null} onClick={() => void fetchReader()} data-testid="everywhere-download">
            {t(download !== null ? PRIVACY_COPY.find.readerRetry : PRIVACY_COPY.find.readerDownload)}
          </button>
        </>
      )
      break
    }
    case 'noText':
    case 'busy':
    case 'failed':
      body = (
        <p role="alert" data-testid={`everywhere-${state.kind}`}>
          {t(state.kind === 'noText' ? PRIVACY_COPY.everywhere.noText : state.kind === 'busy' ? PRIVACY_COPY.run.busy : PRIVACY_COPY.everywhere.failed)}
        </p>
      )
      foot = closeButton(true)
      break
    case 'ready':
      body = (
        <>
          <p>{t(PRIVACY_COPY.everywhere.body)}</p>
          {state.nameLike && (
            <fieldset className="cover-remember" data-testid="everywhere-remember">
              <legend>{t(PRIVACY_COPY.everywhere.remember)}</legend>
              {(['no', 'project', 'settings'] as const).map((v) => (
                <label key={v} className="radio">
                  <input type="radio" name={`${uid}-remember`} value={v} checked={remember === v} onChange={() => setRemember(v)} />
                  <span>{t(v === 'no' ? PRIVACY_COPY.everywhere.rememberNo : v === 'project' ? PRIVACY_COPY.everywhere.rememberThis : PRIVACY_COPY.everywhere.rememberAll)}</span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      )
      foot = (
        <>
          {closeButton(false)}
          <button ref={first} type="button" className="btn primary" onClick={() => void start()} data-testid="everywhere-start">
            {t(PRIVACY_COPY.everywhere.start)}
          </button>
        </>
      )
      break
    case 'running':
      body = (
        <div data-testid="everywhere-running">
          <FindProgressLine projectId={props.services.store.state.id} />
        </div>
      )
      foot = (
        <button ref={first} type="button" className="btn" onClick={() => run.current?.abort()} data-testid="everywhere-stop">
          {t(PRIVACY_COPY.run.stop)}
        </button>
      )
      break
    case 'done':
      body = (
        <p role="status" data-testid="everywhere-done">
          {t(PRIVACY_COPY.everywhere.done, { count: state.added, n: fmt.count(state.added) })}
        </p>
      )
      foot = closeButton(true)
      break
  }

  return (
    <div className="overlay modal-backdrop">
      <div className="cover-everywhere" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} ref={box} tabIndex={-1} data-testid="everywhere-dialog" data-state={state.kind}>
        <header className="modal-head">
          <h2 id={`${uid}-title`}>{t(PRIVACY_COPY.everywhere.title)}</h2>
        </header>
        <div className="modal-body">{body}</div>
        <footer className="modal-foot">{foot}</footer>
      </div>
    </div>
  )
}
