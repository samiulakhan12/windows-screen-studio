import { describe, expect, it, vi } from 'vitest'
import { clipToUnit } from '../src/shared/render/shapes'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { frameView } from '../src/shared/engine/frameView'
import { toOutput } from '../src/shared/engine/outputPoint'
import { focusPathFor, type Camera } from '../src/shared/engine/zoom'
import { lensBox, lensCamera, magnifierPhase } from '../src/shared/render/magnifier'
import type { Project, Shape, Spotlight } from '../src/shared/types'
import { sceneFixtures } from './verticalFixtures'

/*
 * Drawing magnifiers (docs/design/editing-polish.md §6.4, §19.1 tests 25, 28 and 29), on canvases
 * that record their calls: the lens's shadow, the screen through the lens camera inside the lens's
 * clip, the privacy shapes and the cursor drawn again through that camera (never swept by motion
 * blur), the ring; its place in drawFrame; and the spotlight layer's dimming, which lights exactly
 * the lens as drawn.
 */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  alpha: unknown
  fill: unknown
  stroke: unknown
  lineWidth: unknown
  shadow: unknown
}
const calls: Call[] = []
let canvases = 0
function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id }
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 }
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      return (...args: unknown[]) =>
        void calls.push({ canvas: id, name: String(prop), args, alpha: target.globalAlpha, fill: target.fillStyle, stroke: target.strokeStyle, lineWidth: target.lineWidth, shadow: target.shadowColor })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = (type: string) => (type === '2d' ? ctx : null)
  return c
}
vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('Path2D', class {})

/** Each layer leaves a mark (with the camera it drew through), then draws as it does. */
const mark = (name: string, fc: { cam: Camera; options?: { blurSamples: number } }): void =>
  void calls.push({ canvas: -1, name, args: [fc.cam, fc.options?.blurSamples], alpha: null, fill: null, stroke: null, lineWidth: null, shadow: null })
type Layer = (fc: never) => void
vi.mock('../src/renderer/src/render/cursorLayer', async (orig) => {
  const real = await orig<Record<string, Layer>>()
  return { ...real, drawCursorLayer: (fc: never) => (mark('<cursor>', fc), real.drawCursorLayer(fc)) }
})
vi.mock('../src/renderer/src/render/shapesLayer', async (orig) => {
  const real = await orig<Record<string, Layer>>()
  return {
    ...real,
    drawPrivacyLayer: (fc: never) => (mark('<privacy>', fc), real.drawPrivacyLayer(fc)),
    drawShapesLayer: (fc: never) => (mark('<shapes>', fc), real.drawShapesLayer(fc))
  }
})
vi.mock('../src/renderer/src/render/spotlightLayer', async (orig) => {
  const real = await orig<Record<string, Layer>>()
  return { ...real, drawSpotlightLayer: (fc: never) => (mark('<spotlight>', fc), real.drawSpotlightLayer(fc)) }
})
vi.mock('../src/renderer/src/render/magnifierLayer', async (orig) => {
  const real = await orig<Record<string, Layer>>()
  return { ...real, drawMagnifierLayer: (fc: never) => (mark('<magnifier>', fc), real.drawMagnifierLayer(fc)) }
})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const LAYER = '../src/renderer/src/render/magnifierLayer'
type View = { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } | null
const { drawFrame, drawFramePicture, viewSource } = (await import(/* @vite-ignore */ COMPOSITOR)) as {
  drawFrame: (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: unknown, soundTime?: number) => void
  drawFramePicture: (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: unknown, soundTime?: number) => unknown
  viewSource: (c: Camera, rect: { x: number; y: number; w: number; h: number }, clip?: { x: number; y: number; w: number; h: number }) => View
}
const { activeLens, drawMagnifierLayer } = (await import(/* @vite-ignore */ LAYER)) as {
  activeLens: (fc: unknown, s: Spotlight, cursor: { x: number; y: number } | null, presence: () => number) => { alpha: number } | null
  drawMagnifierLayer: (fc: unknown) => void
}

const FX = sceneFixtures().find((f) => f.name === 'wide-auto')!
const W = FX.w
const H = FX.h
const MAG: Spotlight = { id: 'm1', mode: 'region', start: 2, end: 6, x: 0.3, y: 0.3, w: 0.2, h: 0.35, shape: 'ellipse', dim: 0, feather: 0, magnify: 2 }
const BLUR: Shape = { id: 'b1', kind: 'blur', start: 0, end: 8, x: 0.38, y: 0.43, w: 0.05, h: 0.06, color: '#ff3b30', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }

function sceneOf(extra: Partial<Project>): { scene: Record<string, unknown>; src: Record<string, unknown>; project: Project } {
  const project: Project = { ...FX.drawn, zooms: [], ...extra }
  const scene = {
    project,
    cursor: FX.cursor,
    cursorPath: new SmoothedTrack(FX.cursor.samples, project.duration, project.cursor.smoothing),
    focusPath: focusPathFor(FX.cursor.samples, project.duration)
  }
  const src = {
    screen: { readyState: 4, videoWidth: FX.vw, videoHeight: FX.vh },
    webcam: null,
    background: null,
    screenFrame: { image: { tag: 'screen' }, width: FX.vw, height: FX.vh }
  }
  return { scene, src, project }
}

/** The calls of one frame on the main canvas (id 0), with the layers' marks. */
function frameCalls(run: (ctx: unknown) => void): Call[] {
  canvases = 0
  const c = canvas()
  calls.length = 0
  run((c.getContext as (t: string) => unknown)('2d'))
  return calls.filter((k) => k.canvas === 0 || k.canvas === -1)
}

/** The frame's camera and layout at `t`, as drawFrame asks them. */
function frameAt(scene: Record<string, unknown>, t: number): { cam: Camera; rect: { x: number; y: number; w: number; h: number } } {
  const v = frameView(scene as never, W, H, FX.vw, FX.vh, t)
  return { cam: v.cam, rect: v.layout.screen }
}

const near = (a: unknown, b: number): boolean => typeof a === 'number' && Math.abs(a - b) < 1e-6

describe('drawMagnifierLayer (test 28)', () => {
  it('draws nothing without magnify', () => {
    const { scene, src } = sceneOf({ spotlights: [{ ...MAG, magnify: undefined, dim: 0.5 }] })
    let top: unknown
    frameCalls((ctx) => (top = drawFramePicture(ctx, W, H, 4, scene, src, { blurSamples: 1 }, 4)))
    const log = frameCalls((ctx) => drawMagnifierLayer({ ...(top as object), ctx }))
    expect(log.filter((k) => k.canvas === 0)).toEqual([])
  })

  it('draws the shadow, the screen through the lens camera, privacy and cursor through it, then the ring', () => {
    const { scene, src, project } = sceneOf({ spotlights: [MAG] })
    const t = 4
    const log = frameCalls((ctx) => drawFrame(ctx, W, H, t, scene, src, { blurSamples: 1 }, t))
    const { cam, rect } = frameAt(scene, t)
    const phase = magnifierPhase(MAG, t, project.clips, false)!
    expect(phase).toEqual({ r: 1, z: 2, alpha: 1 })
    const P = { x: MAG.x + MAG.w / 2, y: MAG.y + MAG.h / 2 }
    const lens = lensCamera(cam, P, 2)
    const box = lensBox(MAG, P, rect, cam, 1, toOutput(rect, cam))
    const from = log.findIndex((k) => k.name === '<magnifier>')
    const to = log.findIndex((k) => k.name === '<shapes>')
    expect(from).toBeGreaterThan(0)
    const mine = log.slice(from + 1, to)
    // The shadow: outside the lens only (an even-odd clip), black at 0.35.
    const shadowClip = mine.findIndex((k) => k.name === 'clip' && k.args[0] === 'evenodd')
    expect(shadowClip).toBeGreaterThanOrEqual(0)
    const shadowFill = mine.findIndex((k, i) => i > shadowClip && k.name === 'fill')
    expect(mine[shadowFill].shadow).toBe('rgba(0, 0, 0, 0.3500)')
    // The lens clip, then the screen through the lens camera.
    const clip = mine.findIndex((k, i) => i > shadowFill && k.name === 'clip' && k.args.length === 0)
    const ellipse = mine[clip - 1]
    expect(ellipse.name).toBe('ellipse')
    expect(ellipse.args.slice(0, 4).every((v, i) => near(v, [box.cx, box.cy, box.rx, box.ry][i]))).toBe(true)
    const draw = mine.findIndex((k, i) => i > clip && k.name === 'drawImage')
    expect((mine[draw].args[0] as { tag: string }).tag).toBe('screen')
    const v = viewSource(lens, rect, { x: box.cx - box.rx, y: box.cy - box.ry, w: 2 * box.rx, h: 2 * box.ry })!
    const want = [v.sx * FX.vw, v.sy * FX.vh, v.sw * FX.vw, v.sh * FX.vh, v.dx, v.dy, v.dw, v.dh]
    mine[draw].args.slice(1).forEach((a, i) => expect(a as number).toBeCloseTo(want[i], 9))
    // Privacy and cursor again, through the lens camera, without a shutter.
    const privacy = mine.findIndex((k) => k.name === '<privacy>')
    const cursor = mine.findIndex((k) => k.name === '<cursor>')
    expect(privacy).toBeGreaterThan(draw)
    expect(cursor).toBeGreaterThan(privacy)
    for (const i of [privacy, cursor]) {
      expect(mine[i].args[0]).toEqual(lens)
      expect(mine[i].args[1]).toBe(1)
    }
    // The ring: white, max(2 px, 0.004 S) wide; then a 1 px line just outside it.
    const strokes = mine.filter((k, i) => i > cursor && k.name === 'stroke').slice(-2)
    expect(mine.slice(cursor).filter((k) => k.name === 'restore').length).toBeGreaterThan(0)
    expect(strokes.map((k) => [k.stroke, k.lineWidth])).toEqual([
      ['#ffffff', Math.max(2, 0.004 * 1080)],
      ['rgba(0, 0, 0, 0.25)', 1]
    ])
    const outer = mine.filter((k) => k.name === 'ellipse').at(-1)!
    expect(outer.args[2] as number).toBeCloseTo(box.rx + (0.004 * 1080) / 2 + 0.5, 9)
  })

  it('comes after the cursor and before the shapes in drawFrame', () => {
    const { scene, src } = sceneOf({ spotlights: [MAG], shapes: [BLUR] })
    const names = frameCalls((ctx) => drawFrame(ctx, W, H, 4, scene, src, { blurSamples: 1 }, 4))
      .filter((k) => k.canvas === -1)
      .map((k) => k.name)
    expect(names).toEqual(['<privacy>', '<cursor>', '<magnifier>', '<privacy>', '<cursor>', '<shapes>', '<spotlight>'])
  })

  it('a rounded-rectangle lens has corners of 0.18 of its shorter side', () => {
    const { scene, src, project } = sceneOf({ spotlights: [{ ...MAG, shape: 'rect' }] })
    const log = frameCalls((ctx) => drawFrame(ctx, W, H, 4, scene, src, { blurSamples: 1 }, 4))
    const { cam, rect } = frameAt(scene, 4)
    const box = lensBox(MAG, { x: 0.4, y: 0.475 }, rect, cam, magnifierPhase(MAG, 4, project.clips, false)!.r, toOutput(rect, cam))
    const rr = log.slice(log.findIndex((k) => k.name === '<magnifier>')).find((k) => k.name === 'roundRect')!
    expect(rr.args[4] as number).toBeCloseTo(0.18 * Math.min(2 * box.rx, 2 * box.ry), 9)
  })

  it('the dimming lights exactly the lens, scaled by r, at its opacity (the spotlight layer)', () => {
    const spot = { ...MAG, dim: 0.3 }
    const { scene, src, project } = sceneOf({ spotlights: [spot] })
    const t = 2.01
    const phase = magnifierPhase(spot, t, project.clips, false)!
    expect(phase.r).toBeLessThan(1)
    expect(phase.alpha).toBeLessThan(1)
    const log = frameCalls((ctx) => drawFrame(ctx, W, H, t, scene, src, { blurSamples: 1 }, t))
    const { cam, rect } = frameAt(scene, t)
    const box = lensBox(spot, { x: 0.4, y: 0.475 }, rect, cam, phase.r, toOutput(rect, cam))
    const mine = log.slice(log.findIndex((k) => k.name === '<spotlight>'))
    const fill = mine.findIndex((k) => k.name === 'fill' && k.args[0] === 'evenodd')
    expect(fill).toBeGreaterThan(0)
    expect(mine[fill].fill).toBe(`rgba(0,0,0,${(0.3 * phase.alpha).toFixed(4)})`)
    const hole = mine.slice(0, fill).filter((k) => k.name === 'ellipse').at(-1)!
    expect(hole.args.slice(0, 4).every((v, i) => near(v, [box.cx, box.cy, box.rx, box.ry][i]))).toBe(true)
    expect(mine.slice(0, fill).some((k) => k.name === 'rect' && k.args.join() === `0,0,${W},${H}`)).toBe(true)
    // No feathered gradient: the lens is lit with no soft edge.
    expect(mine.slice(0, fill).some((k) => k.name === 'createRadialGradient')).toBe(false)
  })
})

describe('privacy inside the lens (test 29)', () => {
  /** The blur's draws on the main canvas after each privacy mark: [frame's, lens's]. */
  function blurDraws(log: Call[]): { out: number[]; alpha: unknown }[] {
    const out: { out: number[]; alpha: unknown }[] = []
    let inPrivacy = false
    for (const k of log) {
      if (k.canvas === -1) inPrivacy = k.name === '<privacy>'
      else if (inPrivacy && k.name === 'drawImage' && k.args.length === 9) out.push({ out: (k.args as number[]).slice(5), alpha: k.alpha })
    }
    return out
  }

  it('a blur box under a lens is drawn again inside it, at the box the lens camera gives, fully opaque', () => {
    const { scene, src, project } = sceneOf({ spotlights: [MAG], shapes: [BLUR] })
    for (const t of [2.004, 4]) {
      const log = frameCalls((ctx) => drawFrame(ctx, W, H, t, scene, src, { blurSamples: 1 }, t))
      const { cam, rect } = frameAt(scene, t)
      const phase = magnifierPhase(MAG, t, project.clips, false)!
      if (t < 3) expect(phase.alpha).toBeLessThan(1)
      const lens = lensCamera(cam, { x: 0.4, y: 0.475 }, phase.z)
      const b = clipToUnit(BLUR)!
      const a = toOutput(rect, lens)(b.x, b.y)
      const c = toOutput(rect, lens)(b.x + b.w, b.y + b.h)
      const draws = blurDraws(log)
      expect(draws).toHaveLength(2)
      draws[1].out.forEach((v, i) => expect(v).toBeCloseTo([a.x, a.y, c.x - a.x, c.y - a.y][i], 9))
      // While the lens grows in, the blur inside it is still fully opaque.
      expect(draws[1].alpha).toBe(1)
    }
  })

  it('with motion blur during a moving zoom, the box inside the lens is not swept', () => {
    const zooms = [{ id: 'z1', start: 3.6, end: 9, scale: 2.5, focus: { mode: 'fixed' as const, x: 0.6, y: 0.6 }, auto: false }]
    const { scene, src } = sceneOf({ spotlights: [MAG], shapes: [BLUR], zooms, effects: { ...FX.drawn.effects, motionBlur: 1 } })
    const t = 3.9
    const log = frameCalls((ctx) => drawFrame(ctx, W, H, t, scene, src, { blurSamples: 10, frameInterval: 1 / 30 }, t))
    const { cam, rect } = frameAt(scene, t)
    const plain = toOutput(rect, cam)(BLUR.x, BLUR.y)
    const draws = blurDraws(log)
    expect(draws).toHaveLength(2)
    // The frame's layers have the export's shutter; the lens's none.
    const marks = log.filter((k) => k.canvas === -1).map((k) => [k.name, k.args[1]])
    expect(marks).toEqual([
      ['<privacy>', 10],
      ['<cursor>', 10],
      ['<magnifier>', 10],
      ['<privacy>', 1],
      ['<cursor>', 1],
      ['<shapes>', 10],
      ['<spotlight>', 10]
    ])
    // The frame's own box is swept over the shutter (so the camera moves here) ...
    expect(Math.abs(draws[0].out[0] - plain.x) + Math.abs(draws[0].out[1] - plain.y)).toBeGreaterThan(0.5)
    // ... the lens's is exactly the box through the lens camera.
    const lens = lensCamera(cam, { x: 0.4, y: 0.475 }, 2)
    const a = toOutput(rect, lens)(BLUR.x, BLUR.y)
    const c = toOutput(rect, lens)(BLUR.x + BLUR.w, BLUR.y + BLUR.h)
    draws[1].out.forEach((v, i) => expect(v).toBeCloseTo([a.x, a.y, c.x - a.x, c.y - a.y][i], 9))
  })
})

describe('a cursor magnifier fades with the cursor (test 25)', () => {
  it('multiplies its opacity by the cursor presence; a region magnifier does not', () => {
    const rect = { x: 0, y: 0, w: 1920, h: 1080 }
    const cam = { scale: 1, cx: 0.5, cy: 0.5 }
    const fc = { t: 4, project: { clips: [{ id: 'c', start: 0, end: 10, speed: 1 }], effects: { motionBlur: 0 } }, rect, cam, toOut: toOutput(rect, cam) }
    const cursor = { x: 0.7, y: 0.2 }
    expect(activeLens(fc, { ...MAG, mode: 'cursor' }, cursor, () => 0.4)!.alpha).toBeCloseTo(0.4, 12)
    expect(activeLens(fc, MAG, cursor, () => 0.4)!.alpha).toBe(1)
    // Without a known cursor, the box's own place, at full opacity.
    expect(activeLens(fc, { ...MAG, mode: 'cursor' }, null, () => 0.4)!.alpha).toBe(1)
  })
})
