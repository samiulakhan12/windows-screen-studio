import { describe, expect, it, vi } from 'vitest'

// Cursor sprites are Path2D shapes; only whether they are drawn matters here.
vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import type { ClickEvent, CursorSample, CursorTrack } from '../src/shared/types'

type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }

/** A 2D context that records the drawing calls made on it. */
function recordingContext() {
  const calls: { name: string; args: unknown[] }[] = []
  const state: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
      return (...args: unknown[]) => void calls.push({ name: String(prop), args })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  return { ctx, calls }
}

function draw(samples: CursorSample[], clicks: ClickEvent[], t: number) {
  const project = createProject({
    id: 'p',
    name: 'p',
    duration: 4,
    width: 800,
    height: 400,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'window' }
  })
  project.cursor.hideWhenIdle = false
  const cursor: CursorTrack = { samples, clicks, keys: [], shapes: [], scale: 1, valid: true }
  const path = new SmoothedTrack(samples, 4, 0)
  const { ctx, calls } = recordingContext()
  // No decoded frame yet: only the overlays are drawn.
  const screen = { readyState: 0, videoWidth: 0, videoHeight: 0 }
  drawFrame(ctx, 800, 400, t, { project, cursor, cursorPath: path, focusPath: path }, { screen, webcam: null, background: null }, { blurSamples: 1 })
  return { ripples: calls.filter((c) => c.name === 'arc').length, cursorDrawn: calls.some((c) => c.name === 'translate') }
}

const still = (x: number, y: number): CursorSample[] => [
  { t: 0, x, y },
  { t: 4, x, y }
]

describe('drawFrame: cursor and ripples outside the recorded video', () => {
  it('draws the cursor and a ripple inside the video', () => {
    expect(draw(still(0.5, 0.5), [{ t: 1, x: 0.5, y: 0.5, button: 'left' }], 1.1)).toEqual({ ripples: 1, cursorDrawn: true })
  })

  it('draws neither where a window recording maps the cursor outside the video (over another window)', () => {
    for (const [x, y] of [
      [1.3, 0.5],
      [-0.05, 0.5],
      [0.5, 1.2],
      [0.5, -0.4]
    ]) {
      expect(draw(still(x, y), [{ t: 1, x, y, button: 'left' }], 1.1)).toEqual({ ripples: 0, cursorDrawn: false })
    }
  })
})
