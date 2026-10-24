import { useEffect, useRef, useState } from 'react'
import type { RecorderCommand, ToolbarStatus } from '../../../shared/api/recording'
import { formatTime } from '../../../shared/engine/project'
import { Icon } from '../components/Icon'
import '../recorder/recorder.css'

/** How long the discard confirmation stays up before reverting. */
const CONFIRM_MS = 4000
/** How long "Zoom marked" shows after the "zoom here" hotkey. */
const MARK_MS = 1400

/** True for a moment after each new "zoom here" mark. */
function useMarkFlash(marks: number): boolean {
  const seen = useRef(marks)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (marks <= seen.current) {
      seen.current = marks
      return
    }
    seen.current = marks
    setFlash(true)
    const timer = setTimeout(() => setFlash(false), MARK_MS)
    return () => clearTimeout(timer)
  }, [marks])
  return flash
}

/**
 * Seconds shown by the timer. It ticks locally from the last status instead of
 * receiving a message every few hundred milliseconds, and re-renders only when the
 * displayed second changes.
 */
function useTimer(status: ToolbarStatus): number {
  const base = useRef({ elapsed: 0, at: 0 })
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    base.current = { elapsed: status.elapsed, at: performance.now() }
    setSeconds(Math.floor(status.elapsed))
    if (status.state !== 'recording') return
    const timer = setInterval(() => {
      const { elapsed, at } = base.current
      setSeconds(Math.floor(elapsed + (performance.now() - at) / 1000))
    }, 250)
    return () => clearInterval(timer)
  }, [status])
  return seconds
}

/** Floating, always-on-top recording control bar (excluded from the capture). */
export function Toolbar(): JSX.Element | null {
  const [status, setStatus] = useState<ToolbarStatus>({ state: 'idle', elapsed: 0 })
  const [confirming, setConfirming] = useState(false)
  const seconds = useTimer(status)
  const marked = useMarkFlash(status.marks ?? 0)

  useEffect(() => {
    let live = true
    const off = window.api.onRecordingStatus((s) => {
      live = false
      setStatus(s)
    })
    // The window may load after the first status was sent: ask for the current one.
    void window.api.getRecordingStatus().then((s) => live && setStatus(s))
    return off
  }, [])

  useEffect(() => {
    if (status.state !== 'recording' && status.state !== 'paused') setConfirming(false)
  }, [status.state])

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  const send = (cmd: RecorderCommand) => () => void window.api.sendRecorderCommand(cmd)
  const keys = status.hotkeys ?? {}
  const withKey = (what: string, key: string | undefined): string => (key ? `${what} (${key})` : what)
  const stopHint = status.stopShortcut === false ? 'Stop (the stop hotkey is used by another app)' : withKey('Stop', keys.stop)
  // Hotkeys another app owns (older main processes only report the stop shortcut).
  const problems = status.hotkeyProblems ?? (status.stopShortcut === false ? ['The stop shortcut is used by another app: stop with this button.'] : [])

  if (status.state === 'countdown') {
    return (
      <div className="toolbar countdown">
        {status.starting ? (
          <span className="countdown-starting">Starting…</span>
        ) : (
          <>
            <span className="countdown-number" key={status.elapsed}>
              {status.elapsed}
            </span>
            <span className="muted">Recording starts…</span>
          </>
        )}
        <button className="tb-btn cancel" title="Cancel" onClick={send('cancel')}>
          <Icon name="x" />
        </button>
      </div>
    )
  }

  if (status.state !== 'recording' && status.state !== 'paused') return null

  if (confirming) {
    return (
      <div className="toolbar confirm">
        <span className="tb-question">Discard this recording?</span>
        <div className="tb-spacer" />
        <button className="tb-text-btn" onClick={() => setConfirming(false)} autoFocus>
          Keep
        </button>
        <button className="tb-text-btn danger" onClick={send('cancel')}>
          Discard
        </button>
      </div>
    )
  }

  const paused = status.state === 'paused'
  // Blinks once a second with the timer's own re-render: no CSS animation keeps the
  // always-on-top window repainting at the display refresh rate while recording.
  const dim = !paused && seconds % 2 === 1
  return (
    <div className="toolbar">
      <button className="tb-btn stop" title={stopHint} onClick={send('stop')}>
        <span className="stop-square" />
      </button>
      <span className={`rec-dot ${paused ? 'paused' : ''} ${dim ? 'dim' : ''}`} />
      <span className="tb-time">{formatTime(seconds, false)}</span>
      {paused && (
        <span
          className={`tb-state ${status.idle ? 'idle' : ''}`}
          title={status.idle ? 'Paused because nothing happened for a while. Move the mouse or press a key to continue.' : undefined}
        >
          {status.idle ? 'Paused (idle)' : 'Paused'}
        </span>
      )}
      {problems.length > 0 && (
        <span className="tb-warn" title={problems.join('\n')}>
          !
        </span>
      )}
      <div className="tb-spacer" />
      {marked && (
        <span className="tb-mark" role="status">
          Zoom marked
        </span>
      )}
      <button className="tb-btn pause" title={withKey(paused ? 'Resume' : 'Pause', keys.pause)} onClick={send(paused ? 'resume' : 'pause')}>
        <Icon name={paused ? 'play' : 'pause'} />
      </button>
      <button className="tb-btn discard" title="Discard recording" onClick={() => setConfirming(true)}>
        <Icon name="trash" />
      </button>
    </div>
  )
}
