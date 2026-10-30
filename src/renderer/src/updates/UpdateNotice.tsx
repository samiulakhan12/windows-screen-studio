import { useState } from 'react'
import { isPutOff, putOff, useUpdates } from './useUpdates'
import './updates.css'

/**
 * Home's title bar, once an update is downloaded (NW-15, docs/design/auto-update.md §1.7): "Flown
 * 0.7.2 is ready" with Restart now and Later. Later hides it until the next version or the next
 * start. Never shown in the editor or during a recording (Home is hidden then). The live region
 * stays mounted, so the notice is announced when it appears.
 */
export function UpdateNotice(): JSX.Element {
  const s = useUpdates()
  const [, setTick] = useState(0)
  const [refused, setRefused] = useState<string | null>(null)
  const show = !!s && s.phase === 'ready' && !!s.version && !isPutOff(s.version)

  return (
    <div className="update-slot" aria-live="polite">
      {show && (
        <div className="update-pill" data-testid="update-notice">
          <span className="update-pill-text">{refused ?? `Flown ${s.version} is ready. It installs when you close Flown.`}</span>
          <button
            type="button"
            className="btn primary update-pill-btn"
            onClick={() => {
              void window.api.updatesInstall().then((r) => setRefused(r.ok ? null : r.reason), () => undefined)
            }}
          >
            Restart now
          </button>
          <button
            type="button"
            className="btn ghost update-pill-btn"
            onClick={() => {
              putOff(s.version!)
              setTick((n) => n + 1)
            }}
          >
            Later
          </button>
        </div>
      )}
    </div>
  )
}
