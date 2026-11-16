import { useRef, useState } from 'react'
import { ipcMessage } from './providerText'
import { t } from '../../../shared/i18n/t'

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
      <h3 id="settings-diagnostics-title">{t('settings.diagnostics.title')}</h3>
      <p className="hint">
        {t('settings.diagnostics.hint')}
      </p>
      <div className="health-actions">
        <button type="button" className="btn settings-small" onClick={() => void show()} disabled={state === 'busy'}>
          {state === 'busy' ? t('settings.diagnostics.collecting') : report ? t('common.action.refresh') : t('settings.diagnostics.show')}
        </button>
        <button type="button" className="btn ghost settings-small" onClick={() => void window.api.openLogFolder().catch(() => undefined)}>
          {t('settings.diagnostics.openLogs')}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <textarea ref={boxRef} className="health-report" readOnly value={report.text} aria-label={t('settings.diagnostics.report')} rows={12} spellCheck={false} data-testid="diagnostics-text" />
          <div className="health-actions">
            <button type="button" className="btn primary settings-small" onClick={() => void copy()}>
              {state === 'copied' ? t('common.state.copied') : t('settings.diagnostics.copy')}
            </button>
            <span className="hint" role="status">
              {state === 'copied' ? t('settings.diagnostics.copied') : state === 'stale' ? t('settings.diagnostics.stale') : ''}
            </span>
          </div>
        </>
      )}
    </section>
  )
}
