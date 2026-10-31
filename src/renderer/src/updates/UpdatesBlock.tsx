import { useState } from 'react'
import { spokenStatus, statusLine, type UpdateState } from '../../../shared/updates/updates'
import { checkedAt, installUpdate, useRefusal, useUpdates } from './useUpdates'
import './updates.css'

type Action = { label: string; run?: () => Promise<unknown> }

/** The one action button: its label follows the state, and it stays in place so the focus never drops. */
function actionOf(s: UpdateState, restart: () => Promise<unknown>): Action | null {
  switch (s.phase) {
    case 'disabled':
      return null
    case 'checking':
      return { label: 'Check for updates' }
    case 'available':
      return { label: `Download Flown ${s.version}`, run: () => window.api.updatesDownload() }
    case 'downloading':
      return { label: 'Downloading…' }
    case 'ready':
      return { label: 'Restart now', run: restart }
    case 'error':
      return s.version ? { label: `Download Flown ${s.version}`, run: () => window.api.updatesDownload() } : { label: 'Check for updates', run: () => window.api.updatesCheck() }
    case 'idle':
      return { label: 'Check for updates', run: () => window.api.updatesCheck() }
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
      <h4 className="updates-title">Updates</h4>
      {/* Hidden from screen readers: the live region below says the same, so it is not read twice. */}
      <p className="updates-status" data-testid="updates-status" aria-hidden="true">
        {statusLine(s)}
        {last && <span className="muted"> Last checked {last}.</span>}
      </p>
      {/* The live region: the same status without the download's percent, so a download is not
          announced at every percent (the progress bar gives the value when asked). */}
      <span className="sr-only" role="status">
        {spokenStatus(s)}
        {last && ` Last checked ${last}.`}
      </span>
      {s.phase === 'downloading' && <progress className="updates-progress" max={100} value={s.percent ?? 0} aria-label={`Downloading Flown ${s.version}`} />}
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
        Update Flown automatically
      </label>
      <p className="hint">
        Flown looks for a new version on GitHub every few hours, downloads it in the background and installs it when you close Flown. The same check refreshes the
        list of suggested AI models.
      </p>
      {s.notes && s.version && (
        <details className="updates-notes">
          <summary>What&apos;s new in {s.version}</summary>
          <div className="updates-notes-text" data-testid="updates-notes">
            {s.notes}
          </div>
        </details>
      )}
    </div>
  )
}
