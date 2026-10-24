import { describe, expect, it, vi } from 'vitest'

// Cursor sprites are Path2D shapes; only the click effects matter here.
vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import type { ClickStyle, Clip, CursorSample, CursorTrack } from '../src/shared/types'

type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }

/** A 2D context that records each arc and each stroke or fill with the style it is drawn in. */
function recordingContext() {
  const calls: string[] = []
  const state: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return (...args: number[]) => {
          const stops: string[] = []
          return { addColorStop: (o: number, c: string) => void stops.push(`${o}:${c}`), toString: () => `gradient(${args.join(',')};${stops.join(',')})` }
        }
      }
      if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
      return (...args: unknown[]) => {
        if (prop === 'arc') calls.push(`arc(${args.join(',')})`)
        if (prop === 'stroke') calls.push(`stroke(${String(target.strokeStyle)},${String(target.lineWidth)})`)
        if (prop === 'fill') calls.push(`fill(${String(target.fillStyle)})`)
      }
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  return { ctx, calls }
}

const samples: CursorSample[] = [
  { t: 0, x: 0.5, y: 0.5 },
  { t: 2, x: 0.5, y: 0.5 }
]

/** The click-effect drawing of the frame at source time `t`, for a click at 0.5 s in a Chromium recording (OS cursor in the video). */
function drawAt(style: ClickStyle, speed: number, t: number): string[] {
  const project = createProject({
    id: 'p',
    name: 'p',
    duration: 2,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  const clips: Clip[] = [{ id: 'c0', start: 0, end: 2, speed }]
  const q = { ...project, clips, cursor: { ...project.cursor, show: false, clickEffect: true, clickStyle: style, clickColor: '#ff0000' } }
  const cursor: CursorTrack = { samples, clicks: [{ t: 0.5, x: 0.5, y: 0.5, button: 'left' }], keys: [], shapes: [], scale: 1, valid: true }
  const path = new SmoothedTrack(samples, 2, 0)
  const { ctx, calls } = recordingContext()
  // No decoded frame yet: only the overlays are drawn.
  const screen = { readyState: 0, videoWidth: 0, videoHeight: 0 }
  drawFrame(ctx, 1280, 720, t, { project: q, cursor, cursorPath: path, focusPath: path }, { screen, webcam: null, background: null }, { blurSamples: 1 })
  return calls
}

describe('click effects', () => {
  it('play in viewing time: a 2x clip shows the same picture the same output time after the click', () => {
    for (const style of ['ripple', 'ring', 'pulse'] as const) {
      // 0.15 s after the click on screen: source 0.65 s at 1x, source 0.8 s at 2x.
      const at1x = drawAt(style, 1, 0.65)
      expect(at1x.filter((c) => c.startsWith('arc(')).length).toBeGreaterThan(0)
      expect(drawAt(style, 2, 0.8)).toEqual(at1x)
      // Not trivially: the 1x effect 0.3 s after the click (where a source-timed 2x effect would be) looks different.
      expect(drawAt(style, 1, 0.8)).not.toEqual(at1x)
      // Both end 0.45 s after the click on screen.
      const arcs = (calls: string[]): number => calls.filter((c) => c.startsWith('arc(')).length
      expect(arcs(drawAt(style, 1, 0.5 + 0.44))).toBeGreaterThan(0)
      expect(arcs(drawAt(style, 2, 0.5 + 0.88))).toBeGreaterThan(0)
      expect(arcs(drawAt(style, 1, 0.5 + 0.46))).toBe(0)
      expect(arcs(drawAt(style, 2, 0.5 + 0.92))).toBe(0)
    }
  })
})
