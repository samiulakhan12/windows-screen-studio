/**
 * Transparent frames through the one drawing path (docs/design/output-and-languages.md §6.1, §6.2;
 * §23.1 test 25), with a context that records its calls. With scene.alpha 'background' the frame
 * starts cleared instead of painted: no background, the card (from its own layer, with no backdrop)
 * and the recording on it as always, then the camera and the overlays. With 'overlays' only the
 * camera and the overlays are drawn: no card, no recording, nothing inside the card's clip. Without
 * scene.alpha the frame is drawn as before (test 4 pins its call logs in outputEquivalence.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

// The static layers, wrapped so a test can see which of them a frame asked for (they still draw).
vi.mock('../src/renderer/src/render/staticLayer', async (importOriginal) => {
  const m = await importOriginal<Record<string, unknown>>()
  const wrap = (name: string) => vi.fn(m[name] as (...a: unknown[]) => unknown)
  return { ...m, paintStaticLayer: wrap('paintStaticLayer'), paintBackgroundLayer: wrap('paintBackgroundLayer'), paintCardLayer: wrap('paintCardLayer'), paintStillCard: wrap('paintStillCard') }
})

import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import type { CursorTrack, Project, ZoomSegment } from '../src/shared/types'

type Src = { screen: unknown; webcam: null; background: null; screenFrame: unknown; webcamFrame?: unknown }
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: Src, options?: { blurSamples?: number }, soundTime?: number) => void
type Spy = ReturnType<typeof vi.fn>
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const STATIC_LAYER = '../src/renderer/src/render/staticLayer'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }
const LAYERS = ['paintStaticLayer', 'paintBackgroundLayer', 'paintCardLayer', 'paintStillCard'] as const
const layers = (await import(/* @vite-ignore */ STATIC_LAYER)) as Record<(typeof LAYERS)[number], Spy>

interface Call {
  name: string
  args: unknown[]
  alpha: unknown
  fill: unknown
  composite: unknown
}

/** A context that records its calls with the state they draw with, and keeps a save/restore stack as a canvas does. */
function recordingContext() {
  const calls: Call[] = []
  const state: Record<string | symbol, unknown> = {}
  const stack: Record<string | symbol, unknown>[] = []
  const push = (target: Record<string | symbol, unknown>, name: string, args: unknown[]): void =>
    void calls.push({ name, args, alpha: target.globalAlpha, fill: target.fillStyle, composite: target.globalCompositeOperation })
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'save')
        return () => {
          stack.push({ ...target })
          push(target, 'save', [])
        }
      if (prop === 'restore')
        return () => {
          const back = stack.pop()
          if (back) {
            for (const k of Object.keys(target)) delete target[k]
            Object.assign(target, back)
          }
          push(target, 'restore', [])
        }
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return (s: string) => ({ width: String(s).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      if (prop === 'getLineDash') return () => []
      return (...args: unknown[]) => push(target, String(prop), args)
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  return { ctx, calls }
}

const W = 1920
const H = 1080
const BACKGROUND = '#123456'

function project(over: Partial<Project> = {}): Project {
  const p = createProject({ id: 'p', name: 'p', duration: 10, width: 1600, height: 900, hasWebcam: true, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'native', cursorInVideo: false, region: null } })
  p.style = { background: { type: 'color', color: BACKGROUND }, padding: 0.1, cornerRadius: 20, shadow: 0.5, aspectRatio: 'auto' }
  p.effects.motionBlur = 0
  return {
    ...p,
    webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    annotations: [{ id: 't', start: 0, end: 10, text: 'Open the billing page', x: 0.5, y: 0.85, size: 0.05, style: 'pill' }],
    shapes: [{ id: 's', start: 0, end: 10, kind: 'blur', x: 0.1, y: 0.1, w: 0.2, h: 0.1, color: '#000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.5 }],
    ...over
  } as Project
}

const FRAME = { image: { tag: 'frame' }, width: 1600, height: 900 }
const CAM = { image: { tag: 'cam' }, width: 1280, height: 720 }
const cursor: CursorTrack = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
const path = new SmoothedTrack([], 10, 0)
const scene = (p: Project, alpha?: 'background' | 'overlays') => ({ project: p, cursor, cursorPath: path, focusPath: path, ...(alpha ? { alpha } : {}) })
const src = (): Src => ({ screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame: FRAME, webcamFrame: CAM })

function frame(p: Project, alpha?: 'background' | 'overlays', t = 5, sceneOf = scene): Call[] {
  const { ctx, calls } = recordingContext()
  drawFrame(ctx, W, H, t, sceneOf(p, alpha), src(), { blurSamples: 1 }, t)
  return calls
}

const tagOf = (c: Call): string | undefined => (c.name === 'drawImage' ? (c.args[0] as { tag?: string }).tag : undefined)
const isFrame = (c: Call): boolean => tagOf(c) === 'frame'
const isCam = (c: Call): boolean => tagOf(c) === 'cam'
const isBackground = (c: Call): boolean => c.name === 'fillRect' && c.fill === BACKGROUND
/** A path around the card (its well, or its clip): padding 0.1 of 1080 around the 1600×900 recording, radius 20. */
const isCardPath = (c: Call): boolean => c.name === 'roundRect' && JSON.stringify(c.args) === JSON.stringify([192, 108, 1536, 864, 20])
/** The privacy shape, covered (no DOM here to blur it with: shapesLayer's fallback fill). */
const isPrivacy = (c: Call): boolean => c.name === 'fillRect' && c.fill === '#24242e'
const PAINTS = new Set(['fill', 'fillRect', 'fillText', 'stroke', 'strokeRect', 'strokeText', 'drawImage'])
/** The calls as drawn: a save or restore keeps no colour (the opaque frame's background colour is still set at the card's restore). */
const strip = (c: Call[]): string => JSON.stringify(c.map((x) => [x.name, x.args, x.alpha, PAINTS.has(x.name) ? x.fill : null, x.composite]))
/** The overlays' text (the annotation). */
const overlays = (c: Call[]): Call[] => c.filter((x) => x.name === 'fillText')
const balanced = (c: Call[]): boolean => c.filter((x) => x.name === 'save').length === c.filter((x) => x.name === 'restore').length

beforeEach(() => {
  for (const name of LAYERS) layers[name].mockClear()
})

describe('a transparent frame through drawFrame (test 25)', () => {
  it("'background': cleared first, no background, the card and the recording on it, then the camera and the overlays", () => {
    const calls = frame(project(), 'background')
    // The whole frame is cleared, whatever transform is set, before anything is drawn (after the picture's own save).
    expect(calls.slice(0, 5).map((c) => c.name)).toEqual(['save', 'save', 'setTransform', 'clearRect', 'restore'])
    expect(calls[2].args).toEqual([1, 0, 0, 1, 0, 0])
    expect(calls[3].args).toEqual([0, 0, W, H])
    expect(calls.filter((c) => c.name === 'clearRect')).toHaveLength(1)
    // No background: neither cached layer that paints one, and no fill of its colour.
    expect(layers.paintStaticLayer).not.toHaveBeenCalled()
    expect(layers.paintBackgroundLayer).not.toHaveBeenCalled()
    expect(calls.some(isBackground)).toBe(false)
    // The card from its own layer, with no backdrop; its black well, then the recording clipped to it.
    expect(layers.paintCardLayer).toHaveBeenCalledTimes(1)
    expect(layers.paintCardLayer.mock.calls[0][5]).toBeNull()
    expect(calls.some((c) => c.name === 'fill' && c.fill === '#000')).toBe(true)
    const recording = calls.findIndex(isFrame)
    expect(calls.filter(isFrame)).toHaveLength(1)
    expect(calls.slice(0, recording).filter((c) => c.name === 'clip')).toHaveLength(1)
    expect(calls.slice(0, recording).filter(isCardPath).length).toBeGreaterThanOrEqual(2)
    // The privacy shape covers the recording, the camera and the overlays come after.
    expect(calls.filter(isPrivacy)).toHaveLength(1)
    const camAt = calls.findIndex(isCam)
    expect(calls.findIndex(isPrivacy)).toBeGreaterThan(calls.findIndex(isFrame))
    expect(camAt).toBeGreaterThan(calls.findIndex(isPrivacy))
    expect(calls.findIndex((c) => c.name === 'fillText')).toBeGreaterThan(camAt)
    expect(balanced(calls)).toBe(true)
  })

  it("'background': everything after the background is drawn as in the opaque frame", () => {
    const opaque = frame(project())
    const clear = frame(project(), 'background')
    // The opaque frame's background fill and the transparent frame's clear differ; from the card on, the calls are the same.
    const fromCard = (c: Call[]) => c.slice(c.findIndex((x) => x.name === 'fill' && x.fill === '#000') - 1)
    expect(fromCard(clear).length).toBeGreaterThan(10)
    expect(strip(fromCard(clear))).toBe(strip(fromCard(opaque)))
    expect(strip(overlays(clear))).toBe(strip(overlays(opaque)))
  })

  it("'background' with a moving card (a zoom pulling back): the card painted as it moves, still no background", () => {
    const pull: ZoomSegment = { id: 'z', start: 4, end: 8, scale: 0.7, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }
    const calls = frame(project({ zooms: [pull] }), 'background', 6)
    expect(layers.paintStillCard).toHaveBeenCalledTimes(1)
    expect(layers.paintStillCard.mock.calls[0][5]).toBeNull()
    expect(layers.paintBackgroundLayer).not.toHaveBeenCalled()
    expect(layers.paintStaticLayer).not.toHaveBeenCalled()
    expect(calls.some(isBackground)).toBe(false)
    expect(calls.filter(isFrame)).toHaveLength(1)
    // The same frame opaque paints the background behind the moving card.
    layers.paintBackgroundLayer.mockClear()
    expect(frame(project({ zooms: [pull] }), undefined, 6).some(isBackground)).toBe(true)
    expect(layers.paintBackgroundLayer).toHaveBeenCalledTimes(1)
  })

  it("'background' with an animated background: neither the gradient nor its cached layers", () => {
    const animated = project()
    animated.style = { ...animated.style, background: { type: 'animated', preset: 'aurora' } as Project['style']['background'] }
    const calls = frame(animated, 'background')
    expect(layers.paintStaticLayer).not.toHaveBeenCalled()
    expect(layers.paintBackgroundLayer).not.toHaveBeenCalled()
    expect(layers.paintCardLayer).toHaveBeenCalledTimes(1)
    expect(calls.filter(isFrame)).toHaveLength(1)
  })

  it("'overlays': no card, no recording, nothing inside the card's clip; the camera and the overlays", () => {
    const calls = frame(project(), 'overlays')
    expect(calls.slice(0, 5).map((c) => c.name)).toEqual(['save', 'save', 'setTransform', 'clearRect', 'restore'])
    for (const name of LAYERS) expect(layers[name]).not.toHaveBeenCalled()
    expect(calls.some(isBackground)).toBe(false)
    // No well, no card clip, no recording, and no privacy shape (it blurs the recording, which is not there).
    expect(calls.some(isCardPath)).toBe(false)
    expect(frame(project()).some(isCardPath)).toBe(true)
    expect(calls.some(isFrame)).toBe(false)
    expect(calls.some(isPrivacy)).toBe(false)
    expect(frame(project()).some(isPrivacy)).toBe(true)
    expect(calls.filter(isCam)).toHaveLength(1)
    // The overlays are the opaque frame's own calls.
    expect(overlays(calls).length).toBeGreaterThan(0)
    expect(strip(overlays(calls))).toBe(strip(overlays(frame(project()))))
    expect(balanced(calls)).toBe(true)
  })

  it("'overlays': the camera is drawn where the opaque frame draws it", () => {
    const cam = (c: Call[]) => c.find(isCam)!.args.slice(1)
    expect(cam(frame(project(), 'overlays'))).toEqual(cam(frame(project())))
  })

  it('without alpha: the frame of before (the cached static layer, no clear), the same calls as alpha absent', () => {
    const calls = frame(project())
    expect(layers.paintStaticLayer).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.name === 'clearRect' || c.name === 'setTransform')).toBe(false)
    expect(calls.some(isBackground)).toBe(true)
    const undefinedAlpha = (p: Project) => ({ ...scene(p), alpha: undefined })
    expect(strip(frame(project(), undefined, 5, undefinedAlpha))).toBe(strip(calls))
  })
})
