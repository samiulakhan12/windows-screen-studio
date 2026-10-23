import {
  nativeCaptureTimeouts,
  type NativeCaptureOptions,
  type NativeCaptureSession,
  type NativeStartInfo,
  type NativeStopInfo
} from '../nativeCapture'

/** The native capture contract (src/main/nativeCapture.ts), injectable for tests. */
export interface NativeCaptureApi {
  isNativeCaptureAvailable(): Promise<boolean>
  startNativeCapture(options: NativeCaptureOptions): NativeCaptureSession
}

export type NativeStart = { ok: true; session: NativeCaptureSession; info: NativeStartInfo } | { ok: false; message: string }

/**
 * Outer guards, only against a broken helper client: the helper session enforces the
 * real budgets itself (nativeCaptureTimeouts), so these never cut a legitimate but
 * slow start short (monitor lookup, encoder setup and the first frame can take ~20 s).
 */
const MARGIN_MS = 2000
export const defaultStartTimeoutMs = (): number => nativeCaptureTimeouts.start + MARGIN_MS
export const defaultProbeTimeoutMs = (): number => nativeCaptureTimeouts.probe + MARGIN_MS

function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('The recording was cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(message))
    }, ms)
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

/** False on any error or hang, so callers simply fall back to Chromium capture. */
export async function nativeAvailable(api: NativeCaptureApi, timeoutMs = defaultProbeTimeoutMs()): Promise<boolean> {
  try {
    return await withTimeout(api.isNativeCaptureAvailable(), timeoutMs, 'timed out')
  } catch (err) {
    console.warn('Native capture availability check failed:', err)
    return false
  }
}

/**
 * Starts the helper and waits for its first frame. Failures are returned, never thrown.
 * Aborting `signal` (the recording was cancelled meanwhile) kills the helper at once.
 */
export async function startNativeVideo(
  api: NativeCaptureApi,
  options: NativeCaptureOptions,
  timeoutMs = defaultStartTimeoutMs(),
  signal?: AbortSignal
): Promise<NativeStart> {
  let session: NativeCaptureSession | null = null
  try {
    if (signal?.aborted) throw new Error('The recording was cancelled')
    session = api.startNativeCapture(options)
    // A late rejection after a timeout must not become an unhandled rejection.
    session.started.catch(() => undefined)
    const info = await withTimeout(session.started, timeoutMs, 'The capture helper did not start in time', signal)
    if (!(info.width > 0 && info.height > 0 && Number.isFinite(info.startedAt))) {
      throw new Error('The capture helper reported an invalid video')
    }
    return { ok: true, session, info }
  } catch (err) {
    try {
      session?.kill()
    } catch {
      // Already gone.
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** Finalises the helper's MP4; kills it if it does not finish in time. */
export async function stopNativeVideo(session: NativeCaptureSession, at?: number, timeoutMs = 30000): Promise<NativeStopInfo> {
  try {
    return await withTimeout(session.stop(at), timeoutMs, 'The capture helper did not stop in time')
  } catch (err) {
    try {
      session.kill()
    } catch {
      // Already gone.
    }
    throw err
  }
}
