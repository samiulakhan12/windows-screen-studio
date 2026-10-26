import { app } from 'electron'
import os from 'node:os'

/**
 * Whether this PC can keep a window out of screen captures entirely. Windows 10 2004 (build
 * 19041) is the first with WDA_EXCLUDEFROMCAPTURE; older versions record a protected window as a
 * black box, so the live camera bubble and the speaker notes must stay out of the recorded area
 * there. Other platforms: macOS excludes it, Linux has no exclusion (development and tests only).
 *
 * Unpackaged builds let e2e tests pretend to be an older Windows with
 * `globalThis.__SSW_CAPTURE_EXCLUSION__ = false` (as __SSW_NATIVE_CAPTURE__ substitutes the helper).
 */
export function captureExclusionSupported(platform: string = process.platform, release: string = os.release()): boolean {
  const override = (globalThis as { __SSW_CAPTURE_EXCLUSION__?: unknown }).__SSW_CAPTURE_EXCLUSION__
  // `app` is read only when a test set the hook, so modules that mock Electron without it still load.
  if (typeof override === 'boolean' && !app.isPackaged) return override
  if (platform !== 'win32') return true
  const [major, , build] = release.split('.').map(Number)
  return major > 10 || (major === 10 && build >= 19041)
}
