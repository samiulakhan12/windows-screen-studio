import { useEffect, useRef, useState } from 'react'
import { fmt } from '../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../shared/i18n/t'
import { etaMinutes } from '../../../shared/import/plan'
import { useModalFocus } from '../editor/modalFocus'
import type { ImportView, VideoImporter } from './useVideoImport'
import './import.css'

const STAGE_TEXT: Record<'checking' | 'converting' | 'finishing', MessageKey> = {
  checking: 'review.import.checking',
  converting: 'review.import.converting',
  finishing: 'review.import.finishing'
}

/** The dialog's title for a file ("screen-capture": its name without its extension), or for a file not known yet. */
function titleOf(view: Exclude<ImportView, { kind: 'idle' }>): string {
  const name = view.fileName?.replace(/\.[^.]*$/, '')
  if (view.kind === 'running') return view.fileName ? t('review.import.importingFile', { name: name! }) : t('review.import.importing')
  if (view.kind === 'done') return view.fileName ? t('review.import.importedFile', { name: name! }) : t('review.import.imported')
  return view.fileName ? t('review.import.failedFile', { name: name! }) : t('review.import.failed')
}

/** "About 3 min left", "Less than a minute left"; null while too early to tell. */
function etaText(elapsed: number, progress: number | null): string | null {
  const minutes = etaMinutes(elapsed, progress)
  if (minutes === null) return null
  return minutes === 0 ? t('review.import.etaUnderMinute') : t('review.import.eta', { n: fmt.count(minutes) })
}

/** Seconds since the copy started, refreshed every second while it runs (for the time left). */
function useElapsed(view: ImportView): number {
  const [now, setNow] = useState(() => performance.now())
  const running = view.kind === 'running'
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(performance.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  return view.kind === 'running' ? Math.max(0, (now - view.startedAt) / 1000) : 0
}

/** The import's progress, notes or refusal (docs/design/import-video.md §6). Nothing while idle. */
export function ImportDialog({ importer }: { importer: VideoImporter }): JSX.Element | null {
  if (importer.view.kind === 'idle') return null
  return <ImportDialogBox importer={importer} view={importer.view} />
}

function ImportDialogBox({ importer, view }: { importer: VideoImporter; view: Exclude<ImportView, { kind: 'idle' }> }): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  // Esc cancels a running import, and closes the dialog afterwards.
  useModalFocus(boxRef, view.kind === 'running' ? (view.stage === 'finishing' ? () => undefined : importer.cancel) : importer.close)
  const elapsed = useElapsed(view)
  const title = titleOf(view)
  return (
    <div className="overlay modal-backdrop">
      {/* The notes describe the dialog, so a screen reader reads them with the title when Open in editor takes the focus. */}
      <div ref={boxRef} className="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title" aria-describedby={view.kind === 'done' ? 'import-notes' : undefined} data-testid="import-dialog" data-state={view.kind}>
        <header className="modal-head">
          <h2 id="import-title">{title}</h2>
        </header>
        {view.kind === 'running' && (
          <>
            <p className="import-stage" role="status">
              {t(STAGE_TEXT[view.stage])}
            </p>
            {view.stage !== 'checking' && (
              <>
                <div className="progress" role="progressbar" aria-label={t('review.import.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.progress === null ? undefined : Math.round(view.progress * 100)}>
                  <div className={`progress-bar ${view.progress === null ? 'unknown' : ''}`} style={view.progress === null ? undefined : { width: `${Math.round(view.progress * 100)}%` }} />
                </div>
                {view.progress !== null && (
                  <p className="muted import-eta">
                    {fmt.count(Math.round(view.progress * 100))} %{etaText(elapsed, view.progress) ? ` · ${etaText(elapsed, view.progress)}` : ''}
                  </p>
                )}
              </>
            )}
            <p className="hint">{t('review.import.yourFile')}</p>
            <footer className="modal-foot">
              {/* Too late to stop once the project is being written: it opens. */}
              <button className="btn" autoFocus disabled={view.stage === 'finishing'} onClick={importer.cancel}>
                {t('common.action.cancel')}
              </button>
            </footer>
          </>
        )}
        {view.kind === 'done' && (
          <>
            <ul id="import-notes" className="import-notes">
              {view.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <footer className="modal-foot">
              <button className="btn ghost" onClick={importer.close}>
                {t('common.action.close')}
              </button>
              <button className="btn primary" autoFocus onClick={() => importer.open(view.projectId)}>
                {t('review.import.open')}
              </button>
            </footer>
          </>
        )}
        {view.kind === 'failed' && (
          <>
            <p className="import-error" role="alert">
              {view.error}
            </p>
            <footer className="modal-foot">
              <button className="btn" autoFocus onClick={importer.close}>
                {t('common.action.close')}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
