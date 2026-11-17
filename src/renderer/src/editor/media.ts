import { frameCovers, frameSeekTime } from '../../../shared/render/frameTiming'
import { ExportFailure } from '../../../shared/render/exportPlan'
import { t } from '../../../shared/i18n/t'

/**
 * Proxies are constant frame rate: the screen proxy (screen.mp4) at 60 fps, the
 * webcam proxy (webcam.mp4) at the camera's own rate, usually 30 fps. The real rate
 * is read from the file when possible; these are the fallbacks.
 */
export const SCREEN_PROXY_FPS = 60
export const WEBCAM_PROXY_FPS = 30

export function createVideo(url: string): HTMLVideoElement {
  const v = document.createElement('video')
  v.src = url
  v.preload = 'auto'
  v.playsInline = true
  v.crossOrigin = 'anonymous'
  return v
}

/** An audio element for a project sound file (CORS-clean, so Web Audio can process it). */
export function createAudio(url: string): HTMLAudioElement {
  const a = document.createElement('audio')
  a.crossOrigin = 'anonymous'
  a.preload = 'auto'
  a.preservesPitch = true
  a.src = url
  return a
}

/** Length (seconds) of an audio or video file, or null when it cannot be read within `timeoutMs`. */
export function mediaDuration(url: string, timeoutMs = 10000): Promise<number | null> {
  return new Promise((resolve) => {
    const a = document.createElement('audio')
    a.preload = 'metadata'
    const done = (value: number | null): void => {
      clearTimeout(timer)
      a.onloadedmetadata = null
      a.onerror = null
      a.removeAttribute('src')
      a.load()
      resolve(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null)
    a.onerror = () => done(null)
    a.src = url
  })
}

/**
 * Resolves once `v` has the frame at its position (readyState HAVE_CURRENT_DATA or more).
 * 'loadeddata' fires once per load: a seek started on a loaded video drops it back to
 * HAVE_METADATA until 'seeked', so a caller that comes in during that seek waits for the
 * seek (or 'canplay') instead of an event that never fires again.
 */
export function whenReady(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (v.readyState >= 2) return resolve()
    const ok = (): void => {
      cleanup()
      resolve()
    }
    const settled = (): void => {
      if (v.readyState >= 2) ok()
    }
    const fail = (): void => {
      cleanup()
      // Coded: an export stops on a recording it cannot read instead of trying another encoder (output-and-languages §9.6).
      reject(new ExportFailure(t('editor.media.loadFailed', { reason: v.error?.message ?? t('editor.media.unknownError') }), 'unreadable'))
    }
    const cleanup = (): void => {
      v.removeEventListener('loadeddata', ok)
      v.removeEventListener('seeked', settled)
      v.removeEventListener('canplay', settled)
      v.removeEventListener('error', fail)
    }
    v.addEventListener('loadeddata', ok)
    v.addEventListener('seeked', settled)
    v.addEventListener('canplay', settled)
    v.addEventListener('error', fail)
  })
}

/** `t` clamped to the playable range (the last frame stays reachable). */
const clampToMedia = (v: HTMLVideoElement, t: number): number => Math.max(0, Math.min(t, (Number.isFinite(v.duration) ? v.duration : t) - 0.001))
/** Seeks and resolves once the frame at time `at` is decoded and drawable. */
/** Seeks and resolves once the frame at `t` is decoded and drawable. */
export function seekTo(v: HTMLVideoElement, at: number): Promise<void> {
  const target = clampToMedia(v, at)
  return new Promise((resolve, reject) => {
    if (Math.abs(v.currentTime - target) < 0.0005 && v.readyState >= 2 && !v.seeking) return resolve()
    const done = (): void => {
      v.removeEventListener('seeked', done)
      v.removeEventListener('error', fail)
      resolve()
    }
    const fail = (): void => {
      v.removeEventListener('seeked', done)
      v.removeEventListener('error', fail)
      reject(new ExportFailure(t('editor.media.readFailed', { reason: v.error?.message ?? t('editor.media.unknownError') }), 'unreadable'))
    }
    v.addEventListener('seeked', done)
    v.addEventListener('error', fail)
    v.currentTime = target
  })
}

/**
 * Seeks to the frame of a `fps` constant-rate video shown at time `t`. A seek to
 * an exact frame boundary usually shows the previous frame in Chromium, so this
 * aims at the middle of the frame instead; overlays are still computed at `t` by
 * the caller.
 */
export function seekToFrame(v: HTMLVideoElement, t: number, fps: number): Promise<void> {
  return seekTo(v, frameSeekTime(t, fps))
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The frame a paused video shows once a `seekToFrame(v, t)` has finished, as a
 * VideoFrame the caller must close, or null when it cannot be captured (draw the
 * element instead). Chromium fires 'seeked' a moment before the new frame reaches
 * the element's compositor, so an immediate draw shows the previous frame on about
 * 1 seek in 50 under load. The frame's own timestamp tells which one it is: this
 * waits (briefly) for the frame covering the seek target. Returns `verified: false`
 * when the timestamps never matched, so callers can stop checking a file whose
 * timestamps are offset.
 */
export async function seekedFrame(v: HTMLVideoElement, t: number, fps: number, maxWaitMs = 100): Promise<{ frame: VideoFrame; verified: boolean } | null> {
  if (typeof VideoFrame === 'undefined') return null
  const target = clampToMedia(v, frameSeekTime(t, fps))
  const shows = (f: VideoFrame): boolean => frameCovers(f.timestamp / 1e6, target, fps)
  const deadline = performance.now() + maxWaitMs
  for (;;) {
    let frame: VideoFrame
    try {
      frame = new VideoFrame(v)
    } catch {
      return null
    }
    if (shows(frame)) return { frame, verified: true }
    if (performance.now() >= deadline) return { frame, verified: false }
    frame.close()
    await pause(2)
  }
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(t('editor.media.imageFailed')))
    img.src = url
  })
}
