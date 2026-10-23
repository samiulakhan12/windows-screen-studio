import type { AspectRatio, Corner, WebcamSettings } from '../types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const RATIOS: Record<Exclude<AspectRatio, 'auto'>, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Output frame size for an aspect ratio, given the target height (the shorter side for portrait). */
export function outputSize(aspect: AspectRatio, srcW: number, srcH: number, height: number): { width: number; height: number } {
  const ratio = aspect === 'auto' ? srcW / srcH : RATIOS[aspect]
  if (ratio >= 1) return { width: even(height * ratio), height: even(height) }
  // Portrait: keep the long side at `height * 16/9`-ish by treating `height` as the width.
  return { width: even(height), height: even(height / ratio) }
}

/** Rectangle where the recording is drawn: fitted inside the padded output, centred. */
export function contentRect(outW: number, outH: number, srcW: number, srcH: number, padding: number): Rect {
  const pad = Math.min(outW, outH) * padding
  const availW = Math.max(1, outW - pad * 2)
  const availH = Math.max(1, outH - pad * 2)
  const scale = Math.min(availW / srcW, availH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { x: (outW - w) / 2, y: (outH - h) / 2, w, h }
}

export function webcamRect(outW: number, outH: number, settings: Pick<WebcamSettings, 'corner' | 'size'>): Rect {
  const size = Math.min(outW, outH) * settings.size
  const margin = Math.min(outW, outH) * 0.04
  const corner: Corner = settings.corner
  const x = corner.endsWith('left') ? margin : outW - margin - size
  const y = corner.startsWith('top') ? margin : outH - margin - size
  return { x, y, w: size, h: size }
}
