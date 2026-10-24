import { afterEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import type { CursorTrack, Project, TiltSettings, ZoomSegment } from '../src/shared/types'

type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }

/** A 2D context that records every call (name and arguments). */
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
      calls.push({ name: `set ${String(prop)}`, args: [value] })
      return true
    }
  })
  return { ctx, calls }
}

function project(tilt: TiltSettings | undefined, zooms: ZoomSegment[] = []): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 6,
    width: 1600,
    height: 900,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms,
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  p.style = { background: { type: 'color', color: '#123456' }, padding: 0.1, cornerRadius: 20, shadow: 0.5, aspectRatio: 'auto' }
  p.effects.motionBlur = 0
  if (tilt) p.tilt = tilt
  else delete p.tilt
  return p
}

function draw(p: Project, t = 3) {
  const cursor: CursorTrack = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
  const path = new SmoothedTrack([], 6, 0)
  const { ctx, calls } = recordingContext()
  const screenFrame = { image: { tag: 'frame' }, width: 1600, height: 900 }
  drawFrame(ctx, 1920, 1080, t, { project: p, cursor, cursorPath: path, focusPath: path }, { screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame }, { blurSamples: 1 })
  return JSON.stringify(calls)
}

const TILT: TiltSettings = { enabled: true, rotateX: 15, rotateY: -20, perspective: 0.6, animate: 'none' }

afterEach(() => vi.restoreAllMocks())

describe('drawFrame with a 3D tilt', () => {
  it('a tilt that is off draws exactly what a project without one draws', () => {
    expect(draw(project({ ...TILT, enabled: false }))).toBe(draw(project(undefined)))
  })

  it("a 'zoom' tilt flattened by a zoom draws the flat frame (no warp needed)", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const zooms: ZoomSegment[] = [{ id: 'z', start: 1, end: 5, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }]
    expect(draw(project({ ...TILT, animate: 'zoom' }, zooms), 3)).toBe(draw(project(undefined, zooms), 3))
    expect(warn).not.toHaveBeenCalled()
  })

  it('without WebGL the card is drawn flat, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const flat = draw(project(undefined))
    expect(draw(project(TILT))).toBe(flat)
    expect(draw(project(TILT), 4)).toBe(draw(project(undefined), 4))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/3D tilt.*WebGL.*flat/)
  })
})
