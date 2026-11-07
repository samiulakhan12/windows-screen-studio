/**
 * Composing A*, the outgoing still of a cut (docs/design/editing-polish.md §5.6; §19.1 tests 19 and
 * 76): the picture only, sharp, at the still's instant, on the scratch target, then one drawImage
 * into a plain canvas; one scratch target and at most one extra tilt WebGL context whatever the
 * number of cuts; releaseScratch lets go of the layers' copies.
 */
import { describe, expect, it, vi } from 'vitest'

interface Call {
  canvas: number
  name: string
  args: unknown[]
}
const calls: Call[] = []
const webgl: number[] = []
let canvases = 0
const lost = vi.fn()

/** A fake WebGL context: every call works, shaders compile, the context is never lost. */
function fakeGl(): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'getExtension') return (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: lost } : null)
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true
        if (prop === 'isContextLost') return () => false
        return () => ({})
      }
    }
  )
}

/** A canvas whose 2D context records its calls and keeps a save/restore stack. */
function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id, tag: `canvas${id}` }
  const state: Record<string | symbol, unknown> = {}
  const stack: Record<string | symbol, unknown>[] = []
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return (s: string) => ({ width: String(s).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      if (prop === 'getLineDash') return () => []
      if (prop === 'save')
        return () => {
          stack.push({ ...target })
          calls.push({ canvas: id, name: 'save', args: [] })
        }
      if (prop === 'restore')
        return () => {
          const back = stack.pop()
          if (back) {
            for (const k of Object.keys(target)) delete target[k]
            Object.assign(target, back)
          }
          calls.push({ canvas: id, name: 'restore', args: [] })
        }
      return (...args: unknown[]) => void calls.push({ canvas: id, name: String(prop), args })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = (type: string) => {
    if (type === '2d') return ctx
    if (type === 'webgl') {
      webgl.push(id)
      return fakeGl()
    }
    return null
  }
  return c
}

vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('Path2D', class {})
vi.stubGlobal('WeakRef', class {
  constructor(private readonly v: unknown) {}
  deref(): unknown {
    return this.v
  }
})

const releasedGrade: unknown[] = []
const releasedTilt: unknown[] = []
vi.mock('../src/renderer/src/render/gradeLayer', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return { ...real, releaseGrade: (t: unknown) => void releasedGrade.push(t) }
})
vi.mock('../src/renderer/src/render/tiltLayer', async (orig) => {
  const real = await orig<{ releaseTilt: (t: unknown) => void }>()
  return {
    ...real,
    releaseTilt: (t: unknown) => {
      releasedTilt.push(t)
      real.releaseTilt(t)
    }
  }
})

const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { createProject } = await import('../src/shared/engine/project')
const { joinPlan } = await import('../src/shared/render/joins')
type Ctx = { canvas: { id: number; width: number; height: number } }
type Picture = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }, soundTime?: number) => unknown
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const JOIN_LAYER = '../src/renderer/src/render/joinLayer'
const COMPOSITOR = '../src/renderer/src/render/compositor'
const layer = (await import(/* @vite-ignore */ JOIN_LAYER)) as {
  scratchTarget(raster: 'gpu' | 'cpu', w: number, h: number): Ctx
  releaseScratch(): void
  composeJoinStill(scratch: Ctx, out: unknown, w: number, h: number, window: unknown, scene: unknown, stills: unknown, background: null): void
}
const { drawFramePicture } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFramePicture: Picture }

import type { Project } from '../src/shared/types'

const W = 1280
const H = 720
const CLIPS = Array.from({ length: 51 }, (_, i) => ({ id: `c${i}`, start: i * 2, end: i * 2 + 1.5, speed: 1 }))

function project(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 102,
    width: 1600,
    height: 900,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [{ id: 'z', start: 0.5, end: 1.8, scale: 2, focus: { mode: 'fixed', x: 0.2, y: 0.7 }, auto: false }],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  p.effects.motionBlur = 1
  return {
    ...p,
    clips: CLIPS,
    joins: { all: { kind: 'crossfade' } },
    annotations: [{ id: 't', start: 0, end: 102, text: 'Never in A*', x: 0.5, y: 0.85, size: 0.05, style: 'pill' }],
    ...over
  }
}

const cursor = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
const path = new SmoothedTrack([], 102, 0)
const scene = (p: Project) => ({ project: p, cursor, cursorPath: path, focusPath: path })
const FRAME = { image: { tag: 'still frame' }, width: 1600, height: 900 }

describe('composeJoinStill (test 19)', () => {
  it('draws the picture only, sharp, at the still\'s instant, on the scratch target, then one copy', () => {
    const p = project()
    const [w] = joinPlan(p)
    expect(w.still!.screen).toBeCloseTo(1.5, 5)
    const scratch = layer.scratchTarget('cpu', W, H)
    const out = canvas()
    calls.length = 0
    layer.composeJoinStill(scratch, out, W, H, w, scene(p), { screen: FRAME, camera: null }, null)
    const onScratch = calls.filter((c) => c.canvas === scratch.canvas.id)
    const onOut = calls.filter((c) => c.canvas === out.id)
    // The picture as drawFramePicture draws it at A*'s instant with one motion-blur sample.
    calls.length = 0
    const ref = canvas()
    const refCtx = (ref.getContext as (t: string) => unknown)('2d')
    drawFramePicture(refCtx, W, H, w.still!.screen, scene(p), { screen: {}, webcam: null, background: null, screenFrame: FRAME, webcamFrame: null }, { blurSamples: 1 }, 1.5 - 1e-6)
    const picture = calls.filter((c) => c.canvas === ref.id)
    // Canvases the layers keep per target (the cached background) differ between the two targets: named alike.
    const plain = (c: Call[]) => JSON.stringify(c.map((x) => [x.name, x.args.map((a) => (a && typeof a === 'object' && 'getContext' in a ? 'a canvas' : a))]))
    expect(plain(onScratch.slice(0, picture.length))).toBe(plain(picture))
    // Its one save is restored; nothing else is drawn on the scratch target: no text, no overlay.
    expect(onScratch.slice(picture.length).map((c) => c.name)).toEqual(['restore'])
    expect(onScratch.some((c) => c.name === 'fillText')).toBe(false)
    // Sharp: the moving zoom's frame is drawn once (no motion-blur sub-frames).
    expect(onScratch.filter((c) => c.name === 'drawImage' && c.args[0] === FRAME.image)).toHaveLength(1)
    // One drawImage into `out`, of the scratch canvas, at the frame's size.
    expect(onOut.map((c) => [c.name, c.args])).toEqual([['drawImage', [scratch.canvas, 0, 0]]])
    expect([out.width, out.height]).toEqual([W, H])
  })
})

describe('composing memory (test 76)', () => {
  it('uses one scratch target and at most one extra tilt context for 50 stills, never passes `out` to a layer, and releases them', () => {
    const p = project({ tilt: { enabled: true, rotateX: 15, rotateY: -20, perspective: 0.6, animate: 'none' } })
    const windows = joinPlan(p)
    expect(windows).toHaveLength(50)
    webgl.length = 0
    releasedGrade.length = 0
    releasedTilt.length = 0
    const scratches = new Set<Ctx>()
    const outs: Record<string, unknown>[] = []
    calls.length = 0
    for (const w of windows) {
      const scratch = layer.scratchTarget('gpu', W, H)
      scratches.add(scratch)
      const out = canvas()
      outs.push(out)
      layer.composeJoinStill(scratch, out, W, H, w, scene(p), { screen: FRAME, camera: null }, null)
    }
    expect(scratches.size).toBe(1)
    // The tilt drew (its warp copied onto the scratch), with one WebGL context for the scratch target.
    const [scratch] = scratches
    expect(webgl.length).toBeLessThanOrEqual(1)
    expect(webgl.length).toBe(1)
    // Each `out` canvas gets exactly one call, the copy: no layer ever draws on it.
    for (const out of outs) expect(calls.filter((c) => c.canvas === out.id).map((c) => c.name)).toEqual(['drawImage'])
    layer.releaseScratch()
    // Both raster modes' scratch targets (the CPU one of the test before) are let go.
    expect(releasedTilt).toContain(scratch)
    expect(releasedTilt).toHaveLength(2)
    expect(releasedGrade).toHaveLength(2)
    releasedGrade.forEach((t, i) => expect(t).toBe(releasedTilt[i]))
    expect(lost).toHaveBeenCalled()
    // A new scratch target afterwards.
    expect(layer.scratchTarget('gpu', W, H)).not.toBe(scratch)
  })
})
