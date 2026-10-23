import type { NativeCaptureOptions, NativeCaptureSession, NativeStartInfo, NativeStopInfo } from '../nativeCapture'

/** The native capture contract (src/main/nativeCapture.ts), injectable for tests. */
export interface NativeCaptureApi {
  isNativeCaptureAvailable(): Promise<boolean>
  startNativeCapture(options: NativeCaptureOptions): NativeCaptureSession
}

export type NativeStart = { ok: true; session: NativeCaptureSession; info: NativeStartInfo } | { ok: false; message: string }

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** False on any error or hang, so callers simply fall back to Chromium capture. */
export async function nativeAvailable(api: NativeCaptureApi, timeoutMs = 5000): Promise<boolean> {
  try {
    return await withTimeout(api.isNativeCaptureAvailable(), timeoutMs, 'timed out')
  } catch (err) {
    console.warn('Native capture availability check failed:', err)
    return false
  }
}

/** Starts the helper and waits for its first frame. Failures are returned, never thrown. */
export async function startNativeVideo(api: NativeCaptureApi, options: NativeCaptureOptions, timeoutMs = 8000): Promise<NativeStart> {
  let session: NativeCaptureSession | null = null
  try {
    session = api.startNativeCapture(options)
    // A late rejection after a timeout must not become an unhandled rejection.
    session.started.catch(() => undefined)
    const info = await withTimeout(session.started, timeoutMs, 'The capture helper did not start in time')
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
