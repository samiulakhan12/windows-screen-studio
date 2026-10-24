export type DeviceKind = 'screen' | 'microphone' | 'camera'

/** An error whose message is meant for the user; `privacy` points at the Windows setting to fix it. */
export class RecorderError extends Error {
  constructor(
    message: string,
    readonly privacy: 'microphone' | 'camera' | null = null
  ) {
    super(message)
  }
}

/** Processing was postponed by the user; the recording waits under Unfinished recordings. */
export const PROCESSING_DEFERRED = 'Processing was stopped. Your recording is kept under Unfinished recordings; finish it there any time.'

export const SOURCE_GONE = 'The screen or window you picked is no longer available. Pick it again and retry.'

/**
 * Told when native capture did not start and the recording goes on with standard (Chromium)
 * capture. For a window it says why, in the helper's words (e.g. the window was minimised),
 * rather than guessing a cause such as the Windows version.
 */
export function nativeFallbackWarning(target: 'screen' | 'window', reason: string): string {
  const cost = 'The Windows cursor is recorded in the video, so the smooth cursor is unavailable for this recording.'
  if (target === 'screen') return `Screen capture used standard mode because the native capture helper did not start. ${cost}`
  let why = stripIpcPrefix(reason).replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')
  if (why.length > 200) why = `${why.slice(0, 199).trimEnd()}…`
  return `Native window capture did not start${why ? ` (${why})` : ''}, so the window is recorded in standard mode. ${cost}`
}

/** Removes Electron's "Error invoking remote method '…': Error: " wrapper from IPC errors. */
export function stripIpcPrefix(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Za-z]*Error):\s*/, '')
}

/** Maps getUserMedia/getDisplayMedia/IPC failures to a message a user can act on. */
export function friendlyError(err: unknown, kind?: DeviceKind): RecorderError {
  if (err instanceof RecorderError) return err
  const e = err as { name?: string; message?: string } | null
  const name = e?.name ?? ''
  const raw = stripIpcPrefix(e?.message ?? '')
  const device = kind === 'camera' || kind === 'microphone' ? kind : null
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    if (device) return new RecorderError(`Access to the ${device} is blocked. Allow it in Windows Settings › Privacy & security › ${device === 'camera' ? 'Camera' : 'Microphone'}.`, device)
    return new RecorderError('Screen capture was blocked. Check that recording is allowed and try again.')
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    if (device) return new RecorderError(`The ${device} could not be started. It may be in use by another app, or blocked in Windows privacy settings.`, device)
    return new RecorderError('The screen could not be captured. Try again, or pick another screen or window.')
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    if (device) return new RecorderError(`The selected ${device} is not connected. Pick another one or choose “No ${device}”.`)
    return new RecorderError(SOURCE_GONE)
  }
  if (name === 'AbortError' && !device) return new RecorderError('Screen capture could not start. Try again, or pick another screen or window.')
  if (raw) return new RecorderError(raw)
  return new RecorderError(name && name !== 'Error' ? `Recording failed (${name}).` : 'Recording failed for an unknown reason.')
}
