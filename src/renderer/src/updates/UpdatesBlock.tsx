import { useState } from 'react'
import { spokenStatus, statusLine, type UpdateState } from '../../../shared/updates/updates'
import { checkedAt, installUpdate, useRefusal, useUpdates } from './useUpdates'
import './updates.css'
import { t } from '../../../shared/i18n/t'
import { richText } from '../i18n/richText'

type Action = { label: string; run?: () => Promise<unknown> }

/** The one action button: its label follows the state, and it stays in place so the focus never drops. */
function actionOf(s: UpdateState, restart: () => Promise<unknown>): Action | null {
  switch (s.phase) {
    case 'disabled':
      return null
    case 'checking':
      return { label: t('settings.updates.check') }
    case 'available':
      return { label: t('settings.updates.download', { version: s.version ?? '' }), run: () => window.api.updatesDownload() }
    case 'downloading':
      return { label: t('settings.updates.downloading') }
    case 'ready':
      return { label: t('settings.updates.restart'), run: restart }
    case 'error':
      return s.version ? { label: t('settings.updates.download', { version: s.version }), run: () => window.api.updatesDownload() } : { label: t('settings.updates.check'), run: () => window.api.updatesCheck() }
    case 'idle':
      return { label: t('settings.updates.check'), run: () => window.api.updatesCheck() }
  }
}

/**
 * Settings › About › Updates (NW-15, docs/design/auto-update.md §1.7): the status, one action (check,
 * download, Restart now), "Update Flown automatically" and the release notes as plain text.
 */
export function UpdatesBlock(): JSX.Element {
  const s = useUpdates()
  const [refused, setRefused] = useRefusal(s)
  // The switch shows the change at once; main's answer (a state change) takes over when it arrives.
  const [pendingAuto, setPendingAuto] = useState<boolean | null>(null)

  const restart = async (): Promise<void> => {
    const r = await installUpdate()
    setRefused(r.ok ? null : r.reason)
  }

  if (!s) return <div className="updates-block" data-testid="updates" aria-busy="true" />
  const action = actionOf(s, restart)
  const last = s.lastCheck && (s.phase === 'idle' || s.phase === 'error') ? checkedAt(s.lastCheck) : ''

  return (
    <div className="updates-block" data-testid="updates" data-phase={s.phase}>
      <h4 className="updates-title">{t('settings.updates.title')}</h4>
      {/* Hidden from screen readers: the live region below says the same, so it is not read twice. */}
      <p className="updates-status" data-testid="updates-status" aria-hidden="true">
        {statusLine(s)}
        {last && <span className="muted"> {richText('settings.updates.lastChecked', { when: last })}</span>}
      </p>
      {/* The live region: the same status without the download's percent, so a download is not
          announced at every percent (the progress bar gives the value when asked). */}
      <span className="sr-only" role="status">
        {spokenStatus(s)}
        {last && ` ${t('settings.updates.lastChecked', { when: last })}`}
      </span>
      {s.phase === 'downloading' && <progress className="updates-progress" max={100} value={s.percent ?? 0} aria-label={t('settings.updates.downloadingLabel', { version: s.version ?? '' })} />}
      {action && (
        <div className="updates-actions">
          <button
            type="button"
            className={s.phase === 'ready' ? 'btn primary' : 'btn'}
            data-testid="updates-action"
            aria-disabled={action.run ? undefined : true}
            onClick={() => {
              if (!action.run) return
              setRefused(null)
              void action.run().catch(() => undefined)
            }}
          >
            {action.label}
          </button>
        </div>
      )}
      {refused && (
        <p className="updates-refused" role="alert" data-testid="updates-refused">
          {refused}
        </p>
      )}
      <label className="updates-auto">
        <input
          type="checkbox"
          data-testid="updates-auto"
          checked={pendingAuto ?? s.auto}
          disabled={s.phase === 'disabled'}
          onChange={(e) => {
            const on = e.target.checked
            setPendingAuto(on)
            void window.api
              .updatesSetAuto(on)
              .catch(() => undefined)
              .finally(() => setPendingAuto(null))
          }}
        />
        {t('settings.updates.auto')}
      </label>
      <p className="hint">
        {t('settings.updates.hint')}
      </p>
      {s.notes && s.version && (
        <details className="updates-notes">
          <summary>{t('settings.updates.notes', { version: s.version })}</summary>
          <div className="updates-notes-text" data-testid="updates-notes">
            {s.notes}
          </div>
        </details>
      )}
    </div>
  )
}
