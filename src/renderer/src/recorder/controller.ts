import type { CapturePlan, RecorderCommand } from '../../../shared/api/recording'
import type { RecordingStatus } from '../../../shared/types'
import { friendlyError, RecorderError, SOURCE_GONE } from './errors'
import { RecordingSession, type SessionOptions } from './session'

export type RecordingPhase = 'preparing' | 'countdown' | 'recording' | 'saving'

export interface RecordingCallbacks {
  onPhase?(phase: RecordingPhase): void
  /** Problems that did not stop the recording (e.g. a missing device). */
  onWarning?(message: string): void
}

/**
 * Runs a full recording: prepare, acquire streams, countdown, record until stopped
 * from the floating toolbar or shortcut, then let the main process build the project.
 * Resolves to the new project id, or null when cancelled. Once recording has started,
 * captured media is never thrown away on errors: it is saved, or kept on disk.
 */
export async function runRecording(options: SessionOptions, callbacks: RecordingCallbacks = {}): Promise<string | null> {
  const api = window.api
  callbacks.onPhase?.('preparing')
  let plan: CapturePlan
  try {
    plan = await api.prepareCapture({
      sourceId: options.sourceId,
      region: options.region,
      systemAudio: options.systemAudio,
      captureKeys: options.captureKeys
    })
  } catch (err) {
    throw friendlyError(err)
  }
  const { token } = plan
  const session = new RecordingSession(api, plan, options)
  const status = (s: RecordingStatus): Promise<void> => api.setRecordingStatus(token, s).catch(() => undefined)

  let started = false
  let saving = false
  let outcome: 'stop' | 'cancel' | null = null
  let cancelReason: string | null = null
  let wake: (() => void) | null = null
  const finish = (o: 'stop' | 'cancel', reason: string | null = null): void => {
    if (outcome) return
    outcome = o
    cancelReason = reason
    wake?.()
  }
  const wait = (ms?: number): Promise<void> =>
    new Promise((resolve) => {
      if (outcome) return resolve()
      wake = resolve
      if (ms !== undefined) setTimeout(resolve, ms)
    })

  const unsubscribe = api.onRecorderCommand((cmd: RecorderCommand) => {
    if (!started) {
      // Before the recorder runs, "stop" means "never mind": there is nothing to save.
      if (cmd === 'stop' || cmd === 'cancel') finish('cancel')
      return
    }
    if (cmd === 'stop' || cmd === 'cancel') finish(cmd)
    else if (cmd === 'pause' && !session.paused) {
      session.pause()
      void status({ state: 'paused', elapsed: session.elapsed })
    } else if (cmd === 'resume' && session.paused) {
      session.resume()
      void status({ state: 'recording', elapsed: session.elapsed })
    }
  })
  session.onEnded = () => (started ? finish('stop') : finish('cancel', SOURCE_GONE))
  session.onFailure = () => finish('stop')

  const saveWhatWasRecorded = async (): Promise<string> => {
    saving = true
    callbacks.onPhase?.('saving')
    await status({ state: 'processing', elapsed: session.elapsed })
    const meta = await session.stop()
    session.warnings.forEach((w) => callbacks.onWarning?.(w))
    const id = await api.saveRecording(token, meta)
    if (session.error) callbacks.onWarning?.(`${session.error.message} Everything recorded before that was saved.`)
    return id
  }

  try {
    await session.acquire()
    session.warnings.forEach((w) => callbacks.onWarning?.(w))
    session.warnings.length = 0
    callbacks.onPhase?.('countdown')
    for (let n = 3; n > 0 && !outcome; n--) {
      await status({ state: 'countdown', elapsed: n })
      await wait(1000)
    }

    let native: { startedAt: number; width: number; height: number } | null = null
    if (!outcome && plan.method === 'native') {
      const result = await api.startNativeVideo(token)
      if (result.ok) native = result
      else await session.fallbackToChromium()
    }
    if (outcome) {
      session.dispose()
      await api.cancelRecording(token)
      if (cancelReason) throw new RecorderError(cancelReason)
      return null
    }

    const info = session.start(native)
    started = true
    await api.recordingStarted(token, info)
    await status({ state: 'recording', elapsed: 0 })
    callbacks.onPhase?.('recording')
    await wait()

    if (outcome === 'cancel') {
      session.dispose()
      await api.cancelRecording(token)
      return null
    }
    return await saveWhatWasRecorded()
  } catch (err) {
    if (!started) {
      session.dispose()
      await api.cancelRecording(token).catch(() => undefined)
    } else if (!saving) {
      // Something broke mid-recording: keep and process what was captured.
      return await saveWhatWasRecorded().catch((saveErr: unknown) => {
        throw friendlyError(saveErr)
      })
    }
    throw friendlyError(err)
  } finally {
    unsubscribe()
  }
}
