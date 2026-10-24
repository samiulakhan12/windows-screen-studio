/** Messages the recording code shows to the user (pure, so they can be tested). */
import type { NativeEndedInfo } from '../nativeCapture'
import { RecordingError } from './errors'

/**
 * Plain text for a failure, never a raw Node error such as
 * "EBUSY: resource busy or locked, open 'C:\…\screen.webm'". `folder` is where the
 * recording is saved, named when Windows blocks writing there.
 */
export function friendlyMessage(err: unknown, folder?: string): string {
  if (err instanceof RecordingError) return err.message
  const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null | undefined
  const where = folder ? `“${folder}”` : 'the recordings folder'
  switch (e?.code) {
    case 'ENOSPC':
      return 'Your disk is full. Free some space and try again.'
    case 'EPERM':
    case 'EACCES':
      return `Windows blocked saving to ${where}. If Controlled folder access or your antivirus protects it, allow Screen Studio for Windows and try again.`
    case 'EBUSY':
      return 'A recording file is in use by another program (for example antivirus or OneDrive). Try again in a moment.'
    case 'EROFS':
      return `${folder ? `“${folder}”` : 'The recordings folder'} is read-only, so the recording cannot be saved there.`
    case 'ENOENT':
      return `${folder ? `“${folder}”` : 'The recordings folder'} or a file in it is missing (was it moved or deleted?).`
    case 'EMFILE':
    case 'ENFILE':
      return 'Too many files are open. Close some programs and try again.'
  }
  const message = e?.message || (err ? String(err) : '')
  if (typeof e?.code === 'string' && /^E[A-Z]+$/.test(e.code)) return `Could not save the recording (${e.code}).`
  return message || 'Something went wrong while saving the recording.'
}

/** Why a native recording stopped by itself (the capture helper ended). */
export function nativeEndedMessage(info: NativeEndedInfo): string {
  const kept = 'Everything recorded until then was kept.'
  if (info.reason === 'closed') return `Recording stopped because the recorded screen was disconnected or turned off. ${kept}`
  return `Recording stopped because screen capture failed unexpectedly. ${kept}`
}

export interface RendererGone {
  /** A recording was in progress (countdown, recording or paused). */
  recording: boolean
  /** It had started, so its footage was kept. */
  kept: boolean
  /** A stopped recording is still being turned into a project. */
  processing: boolean
}

/** The warning shown when the main window's renderer crashed or was killed. */
export function rendererGoneDialog(state: RendererGone): { message: string; detail: string } {
  if (state.recording) {
    return {
      message: 'The recorder stopped unexpectedly.',
      detail: state.kept
        ? 'What was recorded until then has been kept. Recover it from “Unfinished recordings” on the home screen.'
        : 'The recording had not started yet, so nothing was lost. Please try again.'
    }
  }
  return {
    message: 'Screen Studio for Windows stopped unexpectedly and was reloaded.',
    detail: state.processing
      ? 'Your recording is still being prepared and will appear under “Recent recordings” when it is ready.'
      : 'Your projects are saved automatically. If an export was running, it was stopped; please start it again.'
  }
}
