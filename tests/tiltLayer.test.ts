import { describe, expect, it, vi } from 'vitest'

/*
 * The 3D tilt's pool of WebGL contexts (render/tiltLayer.ts), with a stand-in DOM: canvases
 * whose 2D contexts accept any drawing call and whose WebGL contexts only count what happens
 * to them. Weak references can be told their target is gone (as after garbage collection).
 */

/** A 2D context that accepts every call and property. */
function context2d(): object {
  const state: Record<string | symbol, unknown> = {}
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
      return () => undefined
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
}

interface FakeGl {
  lost: boolean
  draws: number
}
const gls: FakeGl[] = []

/** A WebGL context that compiles and links anything and counts draws and losses. */
function webgl(): object {
  const me: FakeGl = { lost: false, draws: 0 }
  gls.push(me)
  const lose = { loseContext: () => void (me.lost = true) }
  const own: Record<string, unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? lose : null),
    isContextLost: () => me.lost,
    drawArrays: () => void me.draws++,
    getAttribLocation: () => 0
  }
  return new Proxy(own, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop]
      // Constants are numbers, every other method returns a handle.
      if (typeof prop === 'string' && /^[A-Z_0-9]+$/.test(prop)) return 1
      return () => ({})
    }
  })
}

function canvas(): unknown {
  return { width: 0, height: 0, getContext: (type: string) => (type === 'webgl' ? webgl() : context2d()) }
}

/** Weak references whose target can be dropped by hand. */
const refs: { target: object | undefined }[] = []
class TestWeakRef<T extends object> {
  private ref: { target: T | undefined }
  constructor(target: T) {
    this.ref = { target }
    refs.push(this.ref)
  }
  deref(): T | undefined {
    return this.ref.target
  }
}
const collect = (target: object): void => {
  for (const r of refs) if (r.target === target) r.target = undefined
}

vi.stubGlobal('Path2D', class {})
vi.stubGlobal('WeakRef', TestWeakRef)
vi.stubGlobal('document', { createElement: () => canvas() })

const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { createProject } = await import('../src/shared/engine/project')
type Project = import('../src/shared/types').Project
type TiltSettings = import('../src/shared/types').TiltSettings

type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const TILT_LAYER = '../src/renderer/src/render/tiltLayer'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }
const STATIC_LAYER = '../src/renderer/src/render/staticLayer'
const { releaseTilt, beginTiltedCard } = (await import(/* @vite-ignore */ TILT_LAYER)) as {
  releaseTilt: (ctx: unknown) => void
  beginTiltedCard: (...args: unknown[]) => { extent: Rect; quad: { x: number; y: number }[] } | null
}
const { cardGeometry } = (await import(/* @vite-ignore */ STATIC_LAYER)) as { cardGeometry: (spec: unknown) => unknown }
const { leanFit } = await import('../src/shared/engine/tilt')
type Rect = import('../src/shared/engine/layout').Rect

const TILT: TiltSettings = { enabled: true, rotateX: 15, rotateY: -20, perspective: 0.6, animate: 'none' }

function project(tilt?: TiltSettings): Project {
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
  p.style = { background: { type: 'color', color: '#123456' }, padding: 0.1, cornerRadius: 20, shadow: 0.5, aspectRatio: 'auto' }
  p.effects.motionBlur = 0
  if (tilt) p.tilt = tilt
  else delete p.tilt
  return p
}

function draw(target: unknown, p: Project): void {
  const path = new SmoothedTrack([], 6, 0)
  const cursor = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
  const screenFrame = { image: { tag: 'frame' }, width: 1600, height: 900 }
  drawFrame(target, 640, 360, 1, { project: p, cursor, cursorPath: path, focusPath: path }, { screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame }, { blurSamples: 1 })
}

const live = (): number => gls.filter((g) => !g.lost).length

describe('tilt layer: WebGL contexts', () => {
  it('makes one context per canvas and reuses it; releaseTilt lets go of it at once', () => {
    const preview = context2d()
    const exported = context2d()
    draw(preview, project(TILT))
    draw(preview, project(TILT))
    // The probe for support is not drawn with: the warps are.
    const drawing = (): FakeGl[] => gls.filter((g) => g.draws > 0)
    expect(drawing()).toHaveLength(1)
    expect(drawing()[0].draws).toBe(2)
    draw(exported, project(TILT))
    expect(drawing()).toHaveLength(2)
    expect(live()).toBe(2)

    // The export is done: its context goes, the preview's stays.
    releaseTilt(exported)
    expect(live()).toBe(1)
    releaseTilt(exported)
    releaseTilt(context2d())
    expect(live()).toBe(1)
    draw(preview, project(TILT))
    expect(gls.filter((g) => g.draws > 0 && !g.lost)[0].draws).toBe(3)
  })

  it('frames without a tilt let go of the contexts of canvases that are gone', () => {
    const before = live()
    const old = context2d()
    draw(old, project(TILT))
    expect(live()).toBe(before + 1)
    const preview = context2d()
    // A flat frame while the old canvas is still around keeps its context.
    draw(preview, project())
    expect(live()).toBe(before + 1)
    collect(old)
    draw(preview, project())
    expect(live()).toBe(before)
  })
})

describe('tilt layer: a card leaning toward the cursor', () => {
  it('keeps its leaning size also when the lean straightens it for a moment', () => {
    // Level angles and no padding: leaning, the card must shrink to stay inside the frame.
    const p = project({ enabled: true, rotateX: 0, rotateY: 0, perspective: 0.8, animate: 'cursor' })
    p.style = { ...p.style, padding: 0, shadow: 0, cornerRadius: 0 }
    const body = { x: 0, y: 0, w: 640, h: 360 }
    const spec = { style: p.style, rect: body, radius: 0, k: 1, title: '' }
    const geom = cardGeometry(spec)
    const target = context2d()
    const rest = { scale: 1, cx: 0.5, cy: 0.5 }
    const at = (x: number, focus = true) => beginTiltedCard(target, 640, 360, 0, p, rest, focus ? { at: () => ({ x, y: 0.5 }) } : null, spec, geom)
    const fit = leanFit({ rotateX: 0, rotateY: 0, perspective: 0.8 }, body, 640, 360, 0)
    expect(fit).toBeLessThan(0.99)
    // The cursor in the middle: no lean, but the card is as large as while it leans.
    const still = at(0.5)!
    expect(still).not.toBeNull()
    expect((still.quad[1].x - still.quad[0].x) / still.extent.w).toBeCloseTo(fit, 9)
    expect((still.quad[3].y - still.quad[0].y) / still.extent.h).toBeCloseTo(fit, 9)
    expect(at(0.9)).not.toBeNull()
    // Without a cursor to follow, a level card is simply flat.
    expect(at(0.5, false)).toBeNull()
  })
})
