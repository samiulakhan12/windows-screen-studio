import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import { exportFrameTimes } from '../src/shared/engine/timeline'
import { planFeed } from '../src/shared/render/feedPlan'
import { frameIndexAt } from '../src/shared/render/frameTiming'
import type { VideoSample } from '../src/shared/render/mp4'
import type { CursorTrack, Shape } from '../src/shared/types'

type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }

const FPS = 60
/** Painted over a privacy box when there is no frame to blur (shapesLayer's PRIVACY_FALLBACK). */
const FALLBACK = '#24242e'

/** Whether a frame drawn at source time t covers the privacy box (no document here: the fallback fill). */
function covered(t: number, shape: Partial<Shape>, fps = FPS): boolean {
  const project = createProject({
    id: 'p',
    name: 'p',
    duration: 6,
    width: 1600,
    height: 900,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps }
  })
  project.shapes = [{ id: 's', kind: 'blur', x: 0.4, y: 0.4, w: 0.2, h: 0.1, color: '#ff3b30', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5, start: 2, end: 4, ...shape }]
  const cursor: CursorTrack = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
  const path = new SmoothedTrack([], 6, 0)
  let fills = 0
  const state: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
      if (prop === 'fillRect') return () => void (target.fillStyle === FALLBACK && fills++)
      return () => {}
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  const screenFrame = { image: { tag: 'frame' }, width: 1600, height: 900 }
  drawFrame(ctx, 1920, 1080, t, { project, cursor, cursorPath: path, focusPath: path }, { screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame }, { blurSamples: 1 })
  return fills > 0
}

describe('privacy shapes cover the frame the export shows (RE-3)', () => {
  it('covers the first frame of a blur when the export samples just before its start', () => {
    // A 60 fps proxy; a secret appears in frame 120 (2.000 s) and a blur starts there. The edit
    // starts at 0.995 s, so the export samples source times 5 ms off the proxy's frame grid.
    const samples: VideoSample[] = Array.from({ length: 360 }, (_, i) => ({ offset: 0, size: 0, time: i / FPS, duration: 1 / FPS, key: i % 15 === 0 }))
    const times = exportFrameTimes([{ id: 'c', start: 0.995, end: 6, speed: 1 }], FPS)
    const { wanted } = planFeed(samples, times)
    const out = wanted.indexOf(120)
    const t = times[out]
    // Both export frame sources draw proxy frame 120 for a time before the blur starts.
    expect(t).toBeLessThan(2)
    expect(frameIndexAt(t, FPS)).toBe(120)
    expect(covered(t, {})).toBe(true)
    expect(covered(t, { kind: 'pixelate' })).toBe(true)
  })

  it('still leaves frames well before and after the shape alone', () => {
    expect(covered(1.95, {})).toBe(false)
    expect(covered(4.05, {})).toBe(false)
    expect(covered(3, {})).toBe(true)
  })

  it('uses the recording frame rate', () => {
    // At 30 fps, t = 1.985 already shows frame 60 (2.000 s); at 60 fps it shows 1.983 s, before the secret.
    expect(frameIndexAt(1.985, 30)).toBe(60)
    expect(covered(1.985, {}, 30)).toBe(true)
    expect(frameIndexAt(1.985, 60)).toBe(119)
    expect(covered(1.985, {}, 60)).toBe(false)
  })
})
