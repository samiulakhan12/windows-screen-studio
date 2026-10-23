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
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - target) < 0.0005 && v.readyState >= 2 && !v.seeking) return resolve()
    const done = (): void => {
      v.removeEventListener('seeked', done)
      resolve()
    }
    v.addEventListener('seeked', done)
    v.currentTime = target
  })
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
