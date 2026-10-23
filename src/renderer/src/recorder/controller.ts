import type { RecorderCommand } from '../../../shared/api'
import { RecordingSession, type SessionOptions } from './session'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Runs a full recording: acquire streams, countdown, record until stopped from the
 * floating toolbar / shortcut, then hand the files to the main process.
 * Resolves to the new project id, or null when cancelled.
 */
export async function runRecording(options: SessionOptions): Promise<string | null> {
  const api = window.api
  const session = new RecordingSession(options)
  let finish: ((cmd: 'stop' | 'cancel') => void) | null = null
  const finished = new Promise<'stop' | 'cancel'>((resolve) => (finish = resolve))
  let cancelled = false
  let statusTimer: ReturnType<typeof setInterval> | null = null

  const pushStatus = (): void => {
    void api.setRecordingStatus({ state: session.paused ? 'paused' : 'recording', elapsed: session.elapsed })
  }

  const unsubscribe = api.onRecorderCommand((cmd: RecorderCommand) => {
    if (cmd === 'stop' || cmd === 'cancel') {
      if (cmd === 'cancel') cancelled = true
      finish?.(cmd)
    } else if (cmd === 'pause') {
      session.pause()
      pushStatus()
    } else if (cmd === 'resume') {
      session.resume()
      pushStatus()
    }
  })

  try {
    await session.acquire()
    session.onEnded = () => finish?.('stop')

    for (let n = 3; n > 0; n--) {
      if (cancelled) break
      await api.setRecordingStatus({ state: 'countdown', elapsed: n })
      await sleep(1000)
    }
    if (cancelled) {
      session.dispose()
      await api.cancelRecording()
      return null
    }

    session.start()
    await api.recordingStarted(Date.now())
    statusTimer = setInterval(pushStatus, 200)
    pushStatus()

    const outcome = await finished
    clearInterval(statusTimer)
    statusTimer = null

    if (outcome === 'cancel') {
      await session.stop()
      await api.cancelRecording()
      return null
    }

    await api.setRecordingStatus({ state: 'processing', elapsed: session.elapsed })
    const result = await session.stop()
    return await api.saveRecording({
      screen: new Uint8Array(await result.screen.arrayBuffer()),
      webcam: result.webcam ? new Uint8Array(await result.webcam.arrayBuffer()) : undefined,
      startedAt: result.startedAt,
      webcamStartedAt: result.webcamStartedAt ?? undefined,
      duration: result.duration,
      width: result.width,
      height: result.height,
      hasAudio: result.hasAudio,
      cursorHidden: result.cursorHidden
    })
  } catch (err) {
    session.dispose()
    await api.cancelRecording()
    throw err
  } finally {
    if (statusTimer) clearInterval(statusTimer)
    unsubscribe()
  }
}
