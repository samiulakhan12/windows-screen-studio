import { useEffect, useRef, useState } from 'react'
import type { RecorderCommand, ToolbarStatus } from '../../../shared/api/recording'
import { formatTime } from '../../../shared/engine/project'
import { RecIcon } from './recordingIcons'
import './Toolbar.css'

/** How long a discard or restart confirmation stays up before reverting. */
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
 * displayed second changes. A status resent with the same state and elapsed time (the
 * camera bubble shown or hidden, a "zoom here" mark) keeps the running count.
 */
function useTimer({ state, elapsed: statusElapsed }: ToolbarStatus): number {
  const base = useRef({ elapsed: 0, at: 0 })
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    base.current = { elapsed: statusElapsed, at: performance.now() }
    setSeconds(Math.floor(statusElapsed))
    if (state !== 'recording') return
    const timer = setInterval(() => {
      const { elapsed, at } = base.current
      setSeconds(Math.floor(elapsed + (performance.now() - at) / 1000))
    }, 250)
    return () => clearInterval(timer)
  }, [state, statusElapsed])
  return seconds
}

/**
 * The microphone meter: the level arrives a few times a second and is written straight to the
 * bar (no re-render), and only while the microphone records.
 */
function MicMeter({ active }: { active: boolean }): JSX.Element {
  const fill = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = fill.current
    if (!el) return
    el.style.transform = 'scaleY(0)'
    if (!active) return
    return window.api.onRecordingLevel((level) => {
      el.style.transform = `scaleY(${Math.max(0.04, level).toFixed(2)})`
    })
  }, [active])
  return (
    <span className="rb-meter" aria-hidden="true">
      <span ref={fill} className="rb-meter-fill" />
    </span>
  )
}

type Confirm = 'discard' | 'restart'

const CONFIRMS: Record<Confirm, { question: string; detail: string; action: string; command: RecorderCommand }> = {
  discard: { question: 'Discard this recording?', detail: 'Everything recorded so far is deleted.', action: 'Discard', command: 'cancel' },
  restart: { question: 'Restart the recording?', detail: 'This take is deleted and a new one starts.', action: 'Restart', command: 'restart' }
}

/**
 * Floating, always-on-top recording bar (excluded from the capture): a compact pill with the
 * recording dot and timer, the microphone's level and mute, the camera bubble's show/hide, pause
 * or resume, restart and discard (each confirmed first) and Stop. Drag it by any empty part.
 * During the countdown it counts down 3-2-1 with a Cancel button.
 */
export function Toolbar(): JSX.Element | null {
  const [status, setStatus] = useState<ToolbarStatus>({ state: 'idle', elapsed: 0 })
  const [confirming, setConfirming] = useState<Confirm | null>(null)
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
    if (status.state !== 'recording' && status.state !== 'paused') setConfirming(null)
  }, [status.state])

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(null), CONFIRM_MS)
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
      <div className="toolbar rec-bar countdown" role="timer" aria-live="polite">
        {status.starting ? (
          <>
            <span className="rb-spinner" aria-hidden="true" />
            <span className="countdown-starting">Starting…</span>
          </>
        ) : (
          <>
            <span className="rb-count" key={status.elapsed}>
              <svg className="rb-count-ring" viewBox="0 0 36 36" aria-hidden="true">
                <circle cx="18" cy="18" r="16" />
              </svg>
              <span className="countdown-number">{status.elapsed}</span>
            </span>
            <span className="rb-count-text">
              <strong>Recording starts…</strong>
              <span className="muted">{keys.stop ? `Stop any time with ${keys.stop}` : 'Get ready'}</span>
            </span>
          </>
        )}
        <div className="tb-spacer" />
        <button className="tb-btn cancel" title="Cancel" aria-label="Cancel recording" onClick={send('cancel')}>
          <RecIcon name="x" />
        </button>
      </div>
    )
  }

  if (status.state !== 'recording' && status.state !== 'paused') return null

  if (confirming) {
    const c = CONFIRMS[confirming]
    return (
      <div className={`toolbar rec-bar confirm ${confirming}`} role="alertdialog" aria-label={c.question}>
        <span className="rb-confirm-icon" aria-hidden="true">
          <RecIcon name={confirming === 'restart' ? 'restart' : 'trash'} />
        </span>
        <span className="rb-confirm-text">
          <span className="tb-question">{c.question}</span>
          <span className="muted">{c.detail}</span>
        </span>
        <div className="tb-spacer" />
        <button className="tb-text-btn" onClick={() => setConfirming(null)} autoFocus>
          Keep
        </button>
        <button className="tb-text-btn danger" onClick={send(c.command)}>
          {c.action}
        </button>
      </div>
    )
  }

  const paused = status.state === 'paused'
  // Pulses once a second with the timer's own re-render: no CSS animation keeps the
  // always-on-top window repainting at the display refresh rate while recording.
  const dim = !paused && seconds % 2 === 1
  const muted = status.mic?.muted === true
  const camShown = status.camera?.shown !== false
  return (
    <div className={`toolbar rec-bar ${paused ? 'is-paused' : ''}`}>
      <span className="rb-grip" title="Drag to move the bar" aria-hidden="true">
        <RecIcon name="grip" size={14} />
      </span>
      <span className={`rec-dot ${paused ? 'paused' : ''} ${dim ? 'dim' : ''}`} />
      <span className="tb-time" aria-label="Recorded time">
        {formatTime(seconds, false)}
      </span>
      {paused && (
        <span
          className={`tb-state ${status.idle ? 'idle' : ''}`}
          title={status.idle ? 'Paused because nothing happened for a while. Move the mouse or press a key to continue.' : undefined}
        >
          {status.idle ? 'Paused (idle)' : 'Paused'}
        </span>
      )}
      {marked && (
        <span className="tb-mark" role="status">
          <RecIcon name="zoom" size={13} /> Zoom marked
        </span>
      )}
      {problems.length > 0 && (
        <span className="tb-warn" title={problems.join('\n')} role="img" aria-label="Hotkey problem">
          !
        </span>
      )}
      <div className="tb-spacer" />
      {status.mic && (
        <button
          className={`tb-btn mic ${muted ? 'muted' : ''}`}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          title={muted ? 'The microphone is muted: click to record it again' : 'Mute the microphone'}
          onClick={send(muted ? 'unmute' : 'mute')}
        >
          <RecIcon name={muted ? 'mic-off' : 'mic'} />
          <MicMeter active={!muted && !paused} />
        </button>
      )}
      {status.camera && (
        <button
          className={`tb-btn camera ${camShown ? '' : 'off'}`}
          aria-pressed={camShown}
          aria-label={camShown ? 'Hide camera bubble' : 'Show camera bubble'}
          title={camShown ? 'Hide the camera bubble (the camera keeps recording)' : 'Show the camera bubble'}
          onClick={() => void window.api.toggleCameraBubble()}
        >
          <RecIcon name={camShown ? 'camera' : 'camera-off'} />
        </button>
      )}
      {(status.mic || status.camera) && <span className="rb-sep" aria-hidden="true" />}
      <button className="tb-btn pause" title={withKey(paused ? 'Resume' : 'Pause', keys.pause)} aria-label={paused ? 'Resume' : 'Pause'} onClick={send(paused ? 'resume' : 'pause')}>
        <RecIcon name={paused ? 'play' : 'pause'} />
      </button>
      <button className="tb-btn restart" title="Restart: discard this take and record again" aria-label="Restart recording" onClick={() => setConfirming('restart')}>
        <RecIcon name="restart" />
      </button>
      <button className="tb-btn discard" title="Discard recording" aria-label="Discard recording" onClick={() => setConfirming('discard')}>
        <RecIcon name="trash" />
      </button>
      <button className="tb-btn stop" title={stopHint} aria-label="Stop recording" onClick={send('stop')}>
        <span className="stop-square" />
        <span className="rb-stop-label">Stop</span>
      </button>
    </div>
  )
}
