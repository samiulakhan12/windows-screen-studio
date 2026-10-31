import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { isPutOff, putOff, useRefusal, useUpdates } from './useUpdates'
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
  const [refused, setRefused] = useRefusal(s)
  const slot = useRef<HTMLDivElement>(null)
  const show = !!s && s.phase === 'ready' && !!s.version && !isPutOff(s.version)

  return (
    <div ref={slot} className="update-slot" aria-live="polite">
      {show && (
        <Pill slot={slot}>
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
        </Pill>
      )}
    </div>
  )
}

/**
 * The notice itself. It goes with its focused button (Later, or the update stops being ready while
 * Restart now has the focus): the focus then moves on to the next control in the title bar
 * (Settings), never to the page. A layout effect's cleanup runs before React removes the pill.
 */
function Pill({ slot, children }: { slot: RefObject<HTMLDivElement>; children: ReactNode }): JSX.Element {
  const pill = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = pill.current
    return () => {
      // When the whole title bar goes (Home closes) the slot's ref is already cleared: nothing to do.
      if (el?.contains(document.activeElement)) (slot.current?.nextElementSibling as HTMLElement | null)?.focus()
    }
  }, [slot])
  return (
    <div ref={pill} className="update-pill" data-testid="update-notice">
      {children}
    </div>
  )
}
