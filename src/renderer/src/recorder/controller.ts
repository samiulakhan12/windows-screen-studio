import type { CapturePlan, RecorderCommand, RecorderStatusUpdate } from '../../../shared/api/recording'
import { friendlyError, nativeFallbackWarning, RecorderError, SOURCE_GONE } from '../../../shared/recording/errors'
import { openCameraBubble, type LiveBubble } from './cameraBubble'
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
 * "Restart" on the toolbar throws the recording away and runs a new one with the same setup.
 */
export async function runRecording(options: SessionOptions, callbacks: RecordingCallbacks = {}): Promise<string | null> {
  for (;;) {
    const result = await recordOnce(options, callbacks)
    if (result !== RESTART) return result
  }
}

const RESTART = Symbol('restart')

async function recordOnce(options: SessionOptions, callbacks: RecordingCallbacks): Promise<string | null | typeof RESTART> {
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
  // E.g. a window recorded without cursor effects: say so before recording, not after.
  if (plan.notice) callbacks.onWarning?.(plan.notice)
  // A hotkey another app owns: the floating bar still works.
  plan.hotkeyProblems?.forEach((p) => callbacks.onWarning?.(p))
  const session = new RecordingSession(api, plan, options)
  // Every status says whether the microphone is muted (the recording bar shows it).
  const status = (s: RecorderStatusUpdate): Promise<void> =>
    api.setRecordingStatus(token, session.hasMic ? { ...s, mic: { muted: session.micMuted } } : s).catch(() => undefined)
  let bubble: LiveBubble | null = null
  const flushWarnings = (): void => {
    session.warnings.forEach((w) => callbacks.onWarning?.(w))
    session.warnings.length = 0
  }
  // Problems only the main process sees (e.g. the recorded screen was disconnected).
  const offWarning = api.onRecorderWarning((message) => callbacks.onWarning?.(message))

  let started = false
  let saving = false
  let outcome: 'stop' | 'cancel' | 'restart' | null = null
  let cancelReason: string | null = null
  let wake: (() => void) | null = null
  const finish = (o: 'stop' | 'cancel' | 'restart', reason: string | null = null): void => {
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
    if (cmd === 'restart') return finish('restart')
    if (cmd === 'mute' || cmd === 'unmute') {
      session.setMicMuted(cmd === 'mute')
      if (started) void status({ state: session.paused ? 'paused' : 'recording', elapsed: session.elapsed })
      return
    }
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
    bubble?.close()
    callbacks.onPhase?.('saving')
    await status({ state: 'processing', elapsed: session.elapsed })
    const meta = await session.stop()
    flushWarnings()
    const id = await api.saveRecording(token, meta)
    if (session.error) callbacks.onWarning?.(`${session.error.message} Everything recorded before that was saved.`)
    return id
  }

  try {
    await session.acquire()
    flushWarnings()
    // Shown from the countdown on, so it can be put in place before recording starts.
    const camera = session.cameraTrack
    if (camera) bubble = openCameraBubble(api, token, camera)
    callbacks.onPhase?.('countdown')
    const countdown = plan.countdown ?? 3
    for (let n = countdown; n > 0 && !outcome; n--) {
      await status({ state: 'countdown', elapsed: n })
      await wait(1000)
    }
    if (countdown <= 0 && !outcome) {
      // No countdown: the app's window still has to be out of the picture before capture starts.
      await status({ state: 'countdown', elapsed: 0, starting: true })
      await wait(400)
    }

    let native: { startedAt: number; width: number; height: number } | null = null
    if (!outcome && plan.method === 'native') {
      // The helper can take several seconds (encoder setup, first frame): say so.
      await status({ state: 'countdown', elapsed: 0, starting: true })
      // Cancel stays responsive meanwhile: the main process stops the helper.
      const result = await Promise.race([api.startNativeVideo(token), wait().then(() => null)])
      if (result?.ok) native = result
      else if (result && !outcome) {
        console.warn('Native capture did not start:', result.message)
        callbacks.onWarning?.(nativeFallbackWarning(options.sourceId.startsWith('window:') ? 'window' : 'screen', result.message))
        if (result.notice) callbacks.onWarning?.(result.notice)
        await session.fallbackToChromium()
        flushWarnings()
      }
    }
    if (outcome) {
      bubble?.close()
      session.dispose()
      await api.cancelRecording(token, outcome === 'restart')
      if (cancelReason) throw new RecorderError(cancelReason)
      return outcome === 'restart' ? RESTART : null
    }

    const info = session.start(native)
    started = true
    await api.recordingStarted(token, info)
    await status({ state: 'recording', elapsed: 0 })
    callbacks.onPhase?.('recording')
    session.meterMic((level) => api.sendRecordingLevel(token, level))
    await wait()

    if (outcome === 'cancel' || outcome === 'restart') {
      bubble?.close()
      session.dispose()
      await api.cancelRecording(token, outcome === 'restart')
      return outcome === 'restart' ? RESTART : null
    }
    return await saveWhatWasRecorded()
  } catch (err) {
    bubble?.close()
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
    bubble?.close()
    unsubscribe()
    offWarning()
  }
}
