import { frameCovers, frameSeekTime } from '../../../shared/render/frameTiming'

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

export function whenReady(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (v.readyState >= 2) return resolve()
    const ok = (): void => {
      cleanup()
      resolve()
    }
    const fail = (): void => {
      cleanup()
      reject(new Error(`Could not load video (${v.error?.message ?? 'unknown error'})`))
    }
    const cleanup = (): void => {
      v.removeEventListener('loadeddata', ok)
      v.removeEventListener('error', fail)
    }
    v.addEventListener('loadeddata', ok)
    v.addEventListener('error', fail)
  })
}

/** `t` clamped to the playable range (the last frame stays reachable). */
const clampToMedia = (v: HTMLVideoElement, t: number): number => Math.max(0, Math.min(t, (Number.isFinite(v.duration) ? v.duration : t) - 0.001))

/** Seeks and resolves once the frame at `t` is decoded and drawable. */
export function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  const target = clampToMedia(v, t)
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
      reject(new Error(`Could not read video (${v.error?.message ?? 'unknown error'})`))
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
    img.onerror = () => reject(new Error('Could not load image'))
    img.src = url
  })
}
