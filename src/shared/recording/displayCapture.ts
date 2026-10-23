import { friendlyError } from './errors'

/** Shown when a recording goes ahead without the system audio the user asked for. */
export const SYSTEM_AUDIO_WARNING =
  'System audio could not be captured (is a speaker or headphones connected?), so the recording has no system sound.'

/**
 * Requests screen capture, with system audio when `systemAudio`. Chromium only hands out
 * system audio (WASAPI loopback) together with the video, and when the loopback cannot
 * start (no active output device) it rejects the whole request. Then the screen is
 * captured without system audio instead of not at all; a refusal (permission) is final.
 */
export async function captureDisplay<S>(
  request: (audio: boolean) => Promise<S>,
  systemAudio: boolean
): Promise<{ stream: S; systemAudioFailed: boolean }> {
  try {
    return { stream: await request(systemAudio), systemAudioFailed: false }
  } catch (err) {
    const name = (err as { name?: string } | null)?.name
    if (!systemAudio || name === 'NotAllowedError' || name === 'SecurityError') throw friendlyError(err, 'screen')
    console.warn('Screen capture with system audio failed; retrying without it:', err)
    try {
      return { stream: await request(false), systemAudioFailed: true }
    } catch (retryErr) {
      throw friendlyError(retryErr, 'screen')
    }
  }
}
