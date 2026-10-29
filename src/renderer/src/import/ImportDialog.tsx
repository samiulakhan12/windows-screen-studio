import { useEffect, useRef, useState } from 'react'
import { etaText } from '../../../shared/import/plan'
import { useModalFocus } from '../editor/modalFocus'
import type { ImportView, VideoImporter } from './useVideoImport'
import './import.css'

const STAGE_TEXT = {
  checking: 'Checking the video…',
  converting: 'Making an editing copy…',
  finishing: 'Finishing…'
} as const

/** "screen-capture" for the title (the file's name without its extension). */
const shown = (fileName: string | null): string => (fileName ? `"${fileName.replace(/\.[^.]*$/, '')}"` : 'the video')

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
  const title = view.kind === 'running' ? `Importing ${shown(view.fileName)}` : view.kind === 'done' ? `Imported ${shown(view.fileName)}` : `Could not import ${shown(view.fileName)}`
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
              {STAGE_TEXT[view.stage]}
            </p>
            {view.stage !== 'checking' && (
              <>
                <div className="progress" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.progress === null ? undefined : Math.round(view.progress * 100)}>
                  <div className={`progress-bar ${view.progress === null ? 'unknown' : ''}`} style={view.progress === null ? undefined : { width: `${Math.round(view.progress * 100)}%` }} />
                </div>
                {view.progress !== null && (
                  <p className="muted import-eta">
                    {Math.round(view.progress * 100)} %{etaText(elapsed, view.progress) ? ` · ${etaText(elapsed, view.progress)}` : ''}
                  </p>
                )}
              </>
            )}
            <p className="hint">Your file is not changed: Flown makes its own copy to edit.</p>
            <footer className="modal-foot">
              {/* Too late to stop once the project is being written: it opens. */}
              <button className="btn" autoFocus disabled={view.stage === 'finishing'} onClick={importer.cancel}>
                Cancel
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
                Close
              </button>
              <button className="btn primary" autoFocus onClick={() => importer.open(view.projectId)}>
                Open in editor
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
                Close
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
