/** Proxies (screen.mp4, webcam.mp4) are always encoded at 60 fps constant frame rate. */
export const PROXY_FPS = 60

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

/** Seeks and resolves once the frame at `t` is decoded and drawable. */
export function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  const target = Math.max(0, Math.min(t, (Number.isFinite(v.duration) ? v.duration : t) - 0.001))
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
 * Seeks to the proxy frame shown at time `t`. A seek to an exact frame boundary
 * usually shows the previous frame in Chromium, so this aims at the middle of the
 * frame instead; overlays are still computed at `t` by the caller.
 */
export function seekToFrame(v: HTMLVideoElement, t: number, fps = PROXY_FPS): Promise<void> {
  return seekTo(v, t + 0.5 / fps)
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
