/**
 * How a single window is recorded, so its cursor, clicks and auto zoom work like a
 * screen recording's (the window's position on screen is known over time):
 *
 * (a) native: the helper records the window without the cursor and reports its
 *     rectangle (NativeStopInfo.windowRects); Chromium records audio only.
 * (b) Chromium records the window (cursor in the video) while a watcher reports its
 *     rectangle ("watch-window").
 * (c) Chromium only: no rectangle, so no cursor data (keystrokes still work).
 *
 * A failure of (a) falls back to (b), and of (b) to (c), automatically.
 */
import type { WindowCaptureSupport } from '../../shared/api/recording'
import { posesFromRects, type Rect, type Size } from '../../shared/recording/windowGeometry'
import type { WindowRectEvent, WindowWatchSession } from '../nativeCapture'
import { nativeWindowAvailable, startWindowWatch, stopWindowWatch, type NativeCaptureApi } from './nativeVideo'
import type { WindowMapping } from './trackMath'

/** Told to the user when a window is recorded without cursor data (route c). */
export const WINDOW_NO_EFFECTS =
  'This window could not be followed on screen, so it is recorded without cursor data: auto zoom, click highlights and the smooth cursor are unavailable for this recording.'

/** Chromium capture of a window: watched (b) or not (c). */
export type ChromiumWindowRoute =
  | { method: 'chromium'; watch: WindowWatchSession; first: WindowRectEvent }
  | { method: 'chromium'; watch: null; reason: string }

export type WindowRoute = { method: 'native' } | ChromiumWindowRoute

/** Chromium capture of a window, with its rectangle watched when possible: (b), else (c). */
export async function watchForChromium(
  api: NativeCaptureApi,
  windowId: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<ChromiumWindowRoute> {
  const watched = await startWindowWatch(api, windowId, timeoutMs, signal)
  if (watched.ok) return { method: 'chromium', watch: watched.watch, first: watched.first }
  console.warn('Window tracking unavailable, recording the window without cursor data:', watched.message)
  return { method: 'chromium', watch: null, reason: watched.message }
}

/** Picks the best way to record `windowId` (an Electron "window:<id>:<n>" source id). */
export async function planWindowCapture(api: NativeCaptureApi, windowId: string, timeoutMs?: number): Promise<WindowRoute> {
  if (await nativeWindowAvailable(api)) return { method: 'native' }
  return watchForChromium(api, windowId, timeoutMs)
}

/** How long the support check waits for a watcher's first rectangle. */
const SUPPORT_PROBE_MS = 3000

const supportCache = new WeakMap<NativeCaptureApi, Promise<WindowCaptureSupport>>()

/**
 * What window recordings get on this PC (for the hint on Home), checked once per helper:
 * native window capture, else whether a watcher can follow a window at all, tried on one
 * of the app's own windows (`probeWindowId`) so the answer is exactly what recording does.
 */
export function windowCaptureSupport(api: NativeCaptureApi, probeWindowId: string | null): Promise<WindowCaptureSupport> {
  const cached = supportCache.get(api)
  if (cached) return cached
  const check = (async (): Promise<WindowCaptureSupport> => {
    if (await nativeWindowAvailable(api)) return { effects: true, smoothCursor: true }
    if (!probeWindowId) return { effects: false, smoothCursor: false }
    const watched = await startWindowWatch(api, probeWindowId, SUPPORT_PROBE_MS)
    if (!watched.ok) return { effects: false, smoothCursor: false }
    void stopWindowWatch(watched.watch)
    return { effects: true, smoothCursor: false }
  })()
  supportCache.set(api, check)
  // A check that failed unexpectedly is not remembered.
  check.catch(() => supportCache.delete(api))
  return check
}

/**
 * How a window recording's cursor positions are mapped into its video: the window's
 * rectangle over time (`rects`, physical pixels, converted to the cursor's DIP space by
 * `toDip`) fitted into the video, whose size is that of the proxy (`video`, rounded down
 * to even pixels as the proxy step does). Null when nothing is known about the window.
 */
export function windowMapping(rects: readonly WindowRectEvent[], toDip: (r: Rect) => Rect, video: Size): WindowMapping | null {
  const out = { width: 2 * Math.floor(video.width / 2), height: 2 * Math.floor(video.height / 2) }
  if (!(out.width > 0 && out.height > 0)) return null
  const poses = posesFromRects(rects, toDip)
  if (!poses.some((p) => !p.minimized)) return null
  return { poses, out }
}
