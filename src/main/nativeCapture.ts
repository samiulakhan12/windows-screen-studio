/**
 * Client for the native Windows capture helper (native/ — Windows.Graphics.Capture
 * with the cursor excluded, hardware H.264 via Media Foundation).
 *
 * CONTRACT (implemented by the helper integration; consumed by recordingIpc.ts):
 * - isNativeCaptureAvailable() resolves false on non-Windows, when the helper exe is
 *   missing, or when WGC is unsupported. Callers must then fall back to Chromium capture.
 * - startNativeCapture() spawns the helper for one display; `started` resolves when the
 *   first frame has been captured (startedAt = epoch ms of that frame).
 * - pause()/resume() exclude paused time from the output timeline.
 * - stop() finalises the MP4 and resolves with cursor-shape changes seen while recording.
 */
import type { CursorShape } from '../shared/types'

export interface NativeCaptureOptions {
  /** Electron display id (screen.getAllDisplays()[n].id) of the monitor to record. */
  displayId: string
  /** Output .mp4 path. */
  output: string
  fps: 30 | 60
}

export interface NativeStartInfo {
  /** Epoch ms of the first captured frame. */
  startedAt: number
  /** Physical pixel size of the encoded video. */
  width: number
  height: number
}

export interface NativeStopInfo {
  frames: number
  /** Cursor shape changes as epoch ms (not yet pause-adjusted). */
  shapes: { at: number; shape: CursorShape }[]
}

export interface NativeCaptureSession {
  readonly started: Promise<NativeStartInfo>
  pause(): void
  resume(): void
  stop(): Promise<NativeStopInfo>
  /** Aborts immediately; the output file may be incomplete. */
  kill(): void
}

export async function isNativeCaptureAvailable(): Promise<boolean> {
  return false
}

export function startNativeCapture(_options: NativeCaptureOptions): NativeCaptureSession {
  throw new Error('Native capture is not available in this build')
}
