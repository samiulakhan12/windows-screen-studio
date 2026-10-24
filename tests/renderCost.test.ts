import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import type { CursorTrack, Project, ZoomSegment } from '../src/shared/types'

type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }

interface Call {
  /** Which context: 'frame' (the output) or the index of a canvas the code created. */
  on: string
  name: string
  args: unknown[]
  state: Record<string, unknown>
}

/**
 * Canvases and 2D contexts that only record what is done with them, plus a `document` that makes
 * them, so the layers take their cached (browser) paths.
 */
function fakeCanvas() {
  const calls: Call[] = []
  let made = 0
  const context = (on: string, canvas: unknown) => {
    const state: Record<string | symbol, unknown> = { canvas }
    return new Proxy(state, {
      get(target, prop) {
        if (prop in target) return target[prop]
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ gradient: true, addColorStop() {} })
        if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
        return (...args: unknown[]) =>
          void calls.push({
            on,
            name: String(prop),
            args,
            state: { fillStyle: target.fillStyle, shadowBlur: target.shadowBlur, globalAlpha: target.globalAlpha, imageSmoothingQuality: target.imageSmoothingQuality }
          })
      },
      set(target, prop, value) {
        target[prop] = value
        return true
      }
    })
  }
  const createElement = (): unknown => {
    const canvas: Record<string, unknown> = { width: 300, height: 150, id: `canvas${made++}` }
    let ctx: unknown = null
    canvas.getContext = () => (ctx ??= context(canvas.id as string, canvas))
    return canvas
  }
  return { calls, frame: context('frame', { width: 1920, height: 1080 }), document: { createElement } }
}

let fake: ReturnType<typeof fakeCanvas>

beforeEach(() => {
  fake = fakeCanvas()
  vi.stubGlobal('document', fake.document)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal(
    'Path2D',
    class {
      constructor(_d?: string) {}
    }
  )
})

const W = 1920
const H = 1080
const FRAME_IMAGE = { tag: 'video frame' }

function project(edit: (p: Project) => void): Project {
  const p = createProject({
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
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  p.effects.motionBlur = 0
  edit(p)
  return p
}

function draw(p: Project, t: number, blurSamples = 1): void {
  const cursor: CursorTrack = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
  const path = new SmoothedTrack([], 6, 0)
  const screenFrame = { image: FRAME_IMAGE, width: 1600, height: 900 }
  drawFrame(fake.frame, W, H, t, { project: p, cursor, cursorPath: path, focusPath: path }, { screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame }, { blurSamples })
}

const zoom = (scale: number): ZoomSegment => ({ id: 'z', start: 1, end: 5, scale, focus: { mode: 'fixed', x: 0.4, y: 0.4 }, auto: false })

describe('per-frame drawing cost', () => {
  it('scales the animated background up with bilinear smoothing (F1)', () => {
    draw(project((p) => (p.style.background = { type: 'animated', preset: 'aurora' })), 0.5)
    const upscale = fake.calls.find((c) => c.on === 'frame' && c.name === 'drawImage' && c.args[7] === W && c.args[8] === H)
    expect(upscale).toBeDefined()
    expect(upscale!.state.imageSmoothingQuality).toBe('low')
  })

  it('converts the video frame once for all motion-blur sub-frames (F3)', () => {
    const p = project((p) => {
      p.zooms = [zoom(2)]
      p.effects.motionBlur = 1
    })
    // Mid zoom-in: the camera moves fast, so several sub-frames are averaged.
    draw(p, 1.35, 10)
    const frameDraws = fake.calls.filter((c) => c.name === 'drawImage' && c.args[0] === FRAME_IMAGE)
    const subFrames = fake.calls.filter((c) => c.on === 'frame' && c.name === 'drawImage' && c.state.globalAlpha !== undefined && (c.state.globalAlpha as number) < 1)
    expect(subFrames.length).toBeGreaterThan(1)
    expect(frameDraws).toHaveLength(1)
    expect(frameDraws[0].on).not.toBe('frame')
    // A still frame keeps drawing the video itself, with high-quality smoothing.
    fake.calls.length = 0
    draw(p, 3, 10)
    const still = fake.calls.filter((c) => c.name === 'drawImage' && c.args[0] === FRAME_IMAGE)
    expect(still).toHaveLength(1)
    expect(still[0].on).toBe('frame')
    expect(still[0].state.imageSmoothingQuality).toBe('high')
  })

  it('does not repaint the shadow of a card that stays pulled back (F4)', () => {
    const p = project((p) => (p.zooms = [zoom(0.7)]))
    const shadowed = (): number => fake.calls.filter((c) => c.on === 'frame' && c.name === 'fill' && (c.state.shadowBlur as number) > 0).length
    draw(p, 3)
    draw(p, 3.1)
    fake.calls.length = 0
    draw(p, 3.2)
    expect(shadowed()).toBe(0)
    expect(fake.calls.some((c) => c.on === 'frame' && c.name === 'drawImage' && String((c.args[0] as { id?: string }).id).startsWith('canvas'))).toBe(true)
    // While it moves (the zoom transition), it is painted as vectors at every size.
    fake.calls.length = 0
    draw(p, 1.2)
    expect(shadowed()).toBeGreaterThan(0)
  })

  it('paints the spotlight gradient only around the lit area (F5)', () => {
    draw(
      project((p) => {
        p.spotlights = [{ id: 's', start: 0, end: 6, mode: 'region', x: 0.3, y: 0.3, w: 0.3, h: 0.25, shape: 'ellipse', dim: 0.6, feather: 0.5 }]
      }),
      0.5
    )
    const fills = fake.calls.filter((c) => c.on === 'frame' && c.name === 'fillRect')
    const gradient = fills.filter((c) => (c.state.fillStyle as { gradient?: boolean })?.gradient)
    expect(gradient).toHaveLength(1)
    // In the gradient's space the ellipse is the unit circle: the box stays near it (soft edge + a pixel).
    const [x, y, w, h] = gradient[0].args as number[]
    expect(x).toBeGreaterThan(-2)
    expect(y).toBeGreaterThan(-2)
    expect(w).toBeLessThan(4)
    expect(h).toBeLessThan(4)
    // The rest of the frame is dimmed with the solid unlit colour.
    expect(fills.filter((c) => c.state.fillStyle === 'rgba(0,0,0,0.6000)').length).toBeGreaterThan(0)
  })
})
