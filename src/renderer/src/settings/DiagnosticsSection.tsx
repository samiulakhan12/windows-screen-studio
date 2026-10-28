import { useRef, useState } from 'react'
import { ipcMessage } from './providerText'

/**
 * Settings › Diagnostics (X-03, docs/design/hands-off.md §2.6): the report is made by main and
 * shown here first; Copy copies exactly what is shown (main copies the report it made, by id).
 */
export function DiagnosticsSection(): JSX.Element {
  const [report, setReport] = useState<{ id: string; text: string } | null>(null)
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'stale'>('idle')
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  const show = async (): Promise<void> => {
    setState('busy')
    setError(null)
    try {
      const r = await window.api.collectDiagnostics()
      setReport(r)
      setState('idle')
      requestAnimationFrame(() => boxRef.current?.focus())
    } catch (err) {
      setState('idle')
      setError(ipcMessage(err))
    }
  }

  const copy = async (): Promise<void> => {
    if (!report) return
    setState((await window.api.copyDiagnostics(report.id).catch(() => false)) ? 'copied' : 'stale')
  }

  return (
    <section className="settings-section health-section" aria-labelledby="settings-diagnostics-title" data-testid="diagnostics">
      <h3 id="settings-diagnostics-title">Diagnostics</h3>
      <p className="hint">
        If something goes wrong, copy this report and send it to us. It lists your Windows version, graphics card, encoders and recent app messages. Keys, file contents and your
        own folders are left out.
      </p>
      <div className="health-actions">
        <button type="button" className="btn settings-small" onClick={() => void show()} disabled={state === 'busy'}>
          {state === 'busy' ? 'Collecting…' : report ? 'Refresh' : 'Show diagnostics'}
        </button>
        <button type="button" className="btn ghost settings-small" onClick={() => void window.api.openLogFolder().catch(() => undefined)}>
          Open log folder
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <textarea ref={boxRef} className="health-report" readOnly value={report.text} aria-label="Diagnostics report" rows={12} spellCheck={false} data-testid="diagnostics-text" />
          <div className="health-actions">
            <button type="button" className="btn primary settings-small" onClick={() => void copy()}>
              {state === 'copied' ? 'Copied' : 'Copy diagnostics'}
            </button>
            <span className="hint" role="status">
              {state === 'copied' ? 'The report is on the clipboard.' : state === 'stale' ? 'This report is out of date: refresh it first.' : ''}
            </span>
          </div>
        </>
      )}
    </section>
  )
}
