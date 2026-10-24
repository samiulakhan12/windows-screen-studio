import type { AspectRatio, Corner, StyleSettings, WebcamSettings } from '../types'
import { frameInsets, frameOf } from './deviceFrames'

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

/** Display shapes whose standard sizes an 'auto' export snaps to (16:9, 16:10, 4:3, 3:2, ultrawide, square). */
const STANDARD_RATIOS = [16 / 9, 16 / 10, 4 / 3, 3 / 2, 64 / 27, 43 / 18, 1].flatMap((r) => (r === 1 ? [1] : [r, 1 / r]))

/**
 * Aspect ratio of an 'auto' export. A source within 1% of a standard shape (a
 * 1918x1080 window, a 1366x768 laptop) uses that shape, so 4K is 3840x2160 rather
 * than an off-standard 3834x2160; the recording is fitted inside, so nothing stretches.
 */
export function autoAspect(srcW: number, srcH: number): number {
  const ratio = srcW / srcH
  // The nearest one: 64:27 and 43:18 (3440x1440) are less than 1% apart.
  let best = ratio
  let bestErr = 0.01
  for (const r of STANDARD_RATIOS) {
    const err = Math.abs(ratio / r - 1)
    if (err < bestErr) {
      best = r
      bestErr = err
    }
  }
  return best
}

/** Output frame size for an aspect ratio, given the target height (the shorter side for portrait). */
export function outputSize(aspect: AspectRatio, srcW: number, srcH: number, height: number): { width: number; height: number } {
  const ratio = aspect === 'auto' ? autoAspect(srcW, srcH) : RATIOS[aspect]
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

/**
 * Rectangle where the recording itself is drawn for a style: inside the padding, leaving room
 * for the device frame's chrome (title bar, bezels, laptop base) around it. Every caller that
 * maps between the output frame and the recording goes through this.
 */
export function styleContentRect(outW: number, outH: number, srcW: number, srcH: number, style: Pick<StyleSettings, 'padding' | 'frame'>): Rect {
  const frame = frameOf(style)
  if (!frame) return contentRect(outW, outH, srcW, srcH, style.padding)
  // The chrome is sized in multiples of the recording's shorter side, so the whole device
  // grows linearly with the recording: fit that, then centre the device (not the recording).
  const ins = frameInsets(frame.kind, srcW > srcH)
  const pad = Math.min(outW, outH) * style.padding
  const availW = Math.max(1, outW - pad * 2)
  const availH = Math.max(1, outH - pad * 2)
  const m = Math.min(srcW, srcH)
  const scale = Math.min(availW / (srcW + (ins.left + ins.right) * m), availH / (srcH + (ins.top + ins.bottom) * m))
  const u = m * scale
  const w = srcW * scale
  const h = srcH * scale
  const outerW = w + (ins.left + ins.right) * u
  const outerH = h + (ins.top + ins.bottom) * u
  return { x: (outW - outerW) / 2 + ins.left * u, y: (outH - outerH) / 2 + ins.top * u, w, h }
}

export function webcamRect(outW: number, outH: number, settings: Pick<WebcamSettings, 'corner' | 'size'>): Rect {
  const size = Math.min(outW, outH) * settings.size
  const margin = Math.min(outW, outH) * 0.04
  const corner: Corner = settings.corner
  const x = corner.endsWith('left') ? margin : outW - margin - size
  const y = corner.startsWith('top') ? margin : outH - margin - size
  return { x, y, w: size, h: size }
}
