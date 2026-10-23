import { useEffect, useState } from 'react'
import type { RecordingStatus } from '../../../shared/types'
import { formatTime } from '../../../shared/engine/project'
import { Icon } from '../components/Icon'

/** Floating, always-on-top recording control bar (excluded from the capture). */
export function Toolbar(): JSX.Element {
  const [status, setStatus] = useState<RecordingStatus>({ state: 'idle', elapsed: 0 })
  useEffect(() => window.api.onRecordingStatus(setStatus), [])
  const send = (cmd: 'stop' | 'pause' | 'resume' | 'cancel') => () => void window.api.sendRecorderCommand(cmd)

  if (status.state === 'countdown') {
    return (
      <div className="toolbar countdown">
        <span className="countdown-number" key={status.elapsed}>
          {status.elapsed}
        </span>
        <span className="muted">Recording starts…</span>
        <button className="tb-btn" title="Cancel" onClick={send('cancel')}>
          <Icon name="x" />
        </button>
      </div>
    )
  }

  const paused = status.state === 'paused'
  return (
    <div className="toolbar">
      <button className="tb-btn stop" title="Stop (Ctrl+Shift+2)" onClick={send('stop')}>
        <span className="stop-square" />
      </button>
      <span className={`rec-dot ${paused ? 'paused' : ''}`} />
      <span className="tb-time">{formatTime(status.elapsed, false)}</span>
      <div className="tb-spacer" />
      <button className="tb-btn" title={paused ? 'Resume' : 'Pause'} onClick={send(paused ? 'resume' : 'pause')}>
        <Icon name={paused ? 'play' : 'pause'} />
      </button>
      <button className="tb-btn" title="Discard recording" onClick={send('cancel')}>
        <Icon name="trash" />
      </button>
    </div>
  )
}
