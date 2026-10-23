import type { Project, ZoomSegment } from '../types'

export function createProject(init: {
  id: string
  name: string
  duration: number
  width: number
  height: number
  hasWebcam: boolean
  hasAudio: boolean
  webcamOffset: number
  zooms: ZoomSegment[]
  cursorValid: boolean
  /** OS cursor absent from the video, so the smooth cursor won't double up. */
  cursorHidden: boolean
}): Project {
  return {
    version: 1,
    id: init.id,
    name: init.name,
    createdAt: new Date().toISOString(),
    duration: init.duration,
    width: init.width,
    height: init.height,
    hasWebcam: init.hasWebcam,
    hasAudio: init.hasAudio,
    webcamOffset: init.webcamOffset,
    trim: { start: 0, end: init.duration },
    zooms: init.zooms,
    autoZoom: true,
    style: {
      background: { type: 'gradient', preset: 'aurora' },
      padding: 0.07,
      cornerRadius: 14,
      shadow: 0.6,
      aspectRatio: 'auto'
    },
    cursor: {
      show: init.cursorValid && init.cursorHidden,
      size: 1.4,
      smoothing: 0.6,
      clickEffect: true,
      hideWhenIdle: true
    },
    webcam: { show: init.hasWebcam, corner: 'bottom-right', size: 0.24, shape: 'circle' }
  }
}

/** Seconds -> "m:ss.t" */
export function formatTime(seconds: number, withTenths = true): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  const whole = Math.floor(rest)
  const base = `${m}:${whole.toString().padStart(2, '0')}`
  return withTenths ? `${base}.${Math.floor((rest - whole) * 10)}` : base
}

/** Frame times for an export of [start, end) at `fps`. */
export function frameTimes(start: number, end: number, fps: number): number[] {
  const count = Math.max(1, Math.round((end - start) * fps))
  return Array.from({ length: count }, (_, i) => start + i / fps)
}
