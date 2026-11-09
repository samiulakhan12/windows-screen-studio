/**
 * Cut styles in a transparent export (docs/design/output-and-languages.md §6.4; §23.1 test 28), with
 * canvases that record their calls. A crossfade's middle frame is drawn the same for the export
 * dialog's preview and for the export; A* is composed with the scene's alpha on a scratch target
 * with alpha, kept apart from the opaque one, and copied into a canvas with alpha; a dip fades the
 * picture to transparent ('destination-out' at the dip's alpha) and leaves the overlays; a punch-in
 * still scales the content only.
 */
import { describe, expect, it, vi } from 'vitest'

interface Call {
  canvas: number
  name: string
  args: unknown[]
  alpha: unknown
  fill: unknown
  composite: unknown
}
const calls: Call[] = []
let canvases = 0
/** The options each canvas's 2D context was asked for, by canvas id. */
const contextOptions = new Map<number, unknown>()

/** A canvas whose 2D context records its calls with the state they draw with. */
function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id }
  const state: Record<string | symbol, unknown> = {}
  const stack: Record<string | symbol, unknown>[] = []
  const record = (target: Record<string | symbol, unknown>, name: string, args: unknown[]): void =>
    void calls.push({ canvas: id, name, args, alpha: target.globalAlpha, fill: target.fillStyle, composite: target.globalCompositeOperation })
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      if (prop === 'getLineDash') return () => []
      if (prop === 'save')
        return () => {
          stack.push({ ...target })
          record(target, 'save', [])
        }
      if (prop === 'restore')
        return () => {
          const back = stack.pop()
          if (back) {
            for (const k of Object.keys(target)) delete target[k]
            Object.assign(target, back)
          }
          record(target, 'restore', [])
        }
      return (...args: unknown[]) => record(target, String(prop), args)
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = (type: string, options?: unknown) => {
    if (type !== '2d') return null
    if (!contextOptions.has(id)) contextOptions.set(id, options ?? null)
    return ctx
  }
  return c
}

vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { createProject } = await import('../src/shared/engine/project')
const { joinAt, joinPlan } = await import('../src/shared/render/joins')
const { DEFAULT_EXPORT_OPTIONS } = await import('../src/shared/render/exportPresets')
const { alphaOf, alphaScene } = await import('../src/shared/render/alpha')
import type { CursorTrack, Project, ProjectJoins } from '../src/shared/types'
import type { JoinAt, JoinWindow } from '../src/shared/render/joins'

type Canvas = Record<string, unknown> & { id: number; width: number; height: number; getContext(type: string, options?: unknown): unknown }
type Ctx = { canvas: Canvas; save(): void }
type Extras = { video?: number; join?: { at: JoinAt; still: unknown } | null }
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const JOIN_LAYER = '../src/renderer/src/render/joinLayer'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as {
  drawFrame: (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }, soundTime?: number, extras?: Extras) => void
}
const joinLayer = (await import(/* @vite-ignore */ JOIN_LAYER)) as {
  scratchTarget(raster: 'gpu' | 'cpu', w: number, h: number, alpha?: boolean): Ctx
  composeJoinStill(scratch: unknown, out: unknown, w: number, h: number, window: JoinWindow, scene: unknown, stills: unknown, background: null, alpha?: 'background' | 'overlays'): void
  endJoin(ctx: unknown, w: number, h: number, join: unknown, alpha?: 'background' | 'overlays'): void
  releaseScratch(): void
}

const W = 1920
const H = 1080
const CLIPS = [
  { id: 'a', start: 0, end: 4, speed: 1 },
  { id: 'b', start: 5, end: 10, speed: 1 }
]

function project(joins: ProjectJoins | undefined): Project {
  const p = createProject({ id: 'p', name: 'p', duration: 10, width: 1600, height: 900, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'native', cursorInVideo: false, region: null } })
  p.style = { background: { type: 'color', color: '#123456' }, padding: 0.1, cornerRadius: 20, shadow: 0.5, aspectRatio: 'auto' }
  p.effects.motionBlur = 0
  return { ...p, clips: CLIPS, annotations: [{ id: 't', start: 0, end: 10, text: 'Open the billing page', x: 0.5, y: 0.85, size: 0.05, style: 'pill' }], ...(joins ? { joins } : {}) }
}

const FRAME = { image: { tag: 'frame' }, width: 1600, height: 900 }
const STILLS = { screen: { image: { tag: 'still' }, width: 1600, height: 900 }, camera: null }
const cursor: CursorTrack = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
const path = new SmoothedTrack([], 10, 0)
const baseScene = (p: Project) => ({ project: p, cursor, cursorPath: path, focusPath: path })
const src = () => ({ screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame: FRAME })
/** A transparent WebM's options, and the opaque MP4 of before. */
const TRANSPARENT = { ...DEFAULT_EXPORT_OPTIONS, format: 'webm' as const, alpha: 'background' as const }
/** The source time of video time `v` (B starts at 5 s). */
const sourceOf = (v: number): number => (v < 4 ? v : 5 + (v - 4))

/** The calls made from `from` on, with canvases numbered by first use and canvas arguments named. */
function stripped(from: number): unknown[] {
  const order = new Map<number, number>()
  const local = (id: number): number => {
    if (!order.has(id)) order.set(id, order.size)
    return order.get(id)!
  }
  return calls.slice(from).map((c) => ({
    ...c,
    canvas: local(c.canvas),
    args: JSON.stringify(c.args, (_k, v: unknown) => (v && typeof v === 'object' && 'getContext' in v ? `canvas${local((v as unknown as { id: number }).id)}` : v))
  }))
}

/** Draws video time `v` of `p` onto a new canvas with the given context options (A* composed by `compose` when the frame needs one). */
function drawn(p: Project, scene: unknown, v: number, contextAlpha: boolean, compose: (window: JoinWindow) => unknown): { calls: unknown[]; frame: Canvas } {
  const at = joinAt(joinPlan(p), v)
  const from = calls.length
  const still = at?.window.still ? compose(at.window) : null
  const frame = canvas() as Canvas
  const ctx = frame.getContext('2d', { alpha: contextAlpha })
  drawFrame(ctx, W, H, sourceOf(v), scene, src(), { blurSamples: 1 }, sourceOf(v), { video: v, join: at ? { at, still } : null })
  return { calls: stripped(from), frame }
}

describe('joins in a transparent export (test 28)', () => {
  it("a crossfade's middle frame is drawn the same for the dialog's preview and for the export", () => {
    const p = project({ all: { kind: 'crossfade' } })
    const window = joinPlan(p)[0]
    const mid = (window.from + window.to) / 2
    joinLayer.releaseScratch()
    // The export: the scene withAlpha gives, A* composed on the scratch target of its raster mode (the CPU one here).
    const exportScene = { ...baseScene(p), alpha: alphaOf(TRANSPARENT) }
    const exported = drawn(p, exportScene, mid, true, (w) => {
      const out = canvas()
      joinLayer.composeJoinStill(joinLayer.scratchTarget('cpu', W, H), out, W, H, w, exportScene, STILLS, null)
      return out
    })
    // The dialog's preview: its scene from the export's options, A* composed as JoinStills does (on the GPU scratch target).
    const previewScene = alphaScene(baseScene(p), TRANSPARENT)
    const previewed = drawn(p, previewScene, mid, true, (w) => {
      const out = canvas()
      joinLayer.composeJoinStill(joinLayer.scratchTarget('gpu', W, H), out, W, H, w, previewScene, STILLS, null)
      return out
    })
    expect(previewScene.alpha).toBe('background')
    expect(previewed.calls).toEqual(exported.calls)
    // The frame holds A* at half its alpha over the live picture, and the picture starts cleared.
    const frameCalls = (c: unknown[]) => (c as { canvas: number; name: string; args: string; alpha: unknown }[]).filter((x) => x.canvas === (c[c.length - 1] as { canvas: number }).canvas)
    const onFrame = frameCalls(exported.calls)
    expect(onFrame.some((x) => x.name === 'clearRect')).toBe(true)
    // A* is the canvas drawn at the crossfade's alpha (the card's own layer is drawn at full alpha).
    const still = onFrame.filter((x) => x.name === 'drawImage' && x.args.startsWith('["canvas') && x.alpha !== undefined)
    expect(still).toHaveLength(1)
    expect(still[0].alpha).toBeCloseTo(0.5, 9)
    // The opaque export of the same frame is another drawing (its background, an opaque A*).
    const opaque = drawn(p, baseScene(p), mid, false, (w) => {
      const out = canvas()
      joinLayer.composeJoinStill(joinLayer.scratchTarget('cpu', W, H), out, W, H, w, baseScene(p), STILLS, null)
      return out
    })
    expect(opaque.calls).not.toEqual(exported.calls)
  })

  it('A* is drawn on a scratch target with alpha, kept apart from the opaque one, and copied into a canvas with alpha', () => {
    const p = project({ all: { kind: 'crossfade' } })
    const window = joinPlan(p)[0]
    joinLayer.releaseScratch()
    const opaque = joinLayer.scratchTarget('gpu', W, H)
    const clear = joinLayer.scratchTarget('gpu', W, H, true)
    expect(clear).not.toBe(opaque)
    expect(joinLayer.scratchTarget('gpu', W, H, true)).toBe(clear)
    expect(joinLayer.scratchTarget('gpu', W, H)).toBe(opaque)
    expect(contextOptions.get(opaque.canvas.id)).toEqual({ alpha: false, willReadFrequently: false })
    expect(contextOptions.get(clear.canvas.id)).toEqual({ alpha: true, willReadFrequently: false })
    expect(contextOptions.get(joinLayer.scratchTarget('cpu', W, H, true).canvas.id)).toEqual({ alpha: true, willReadFrequently: true })

    // The exporter hands the opaque target; a transparent scene is composed on the one with alpha.
    const scene = { ...baseScene(p), alpha: 'background' as const }
    const out = canvas() as Canvas
    const from = calls.length
    joinLayer.composeJoinStill(opaque, out, W, H, window, scene, STILLS, null)
    const made = calls.slice(from)
    expect(made.some((c) => c.canvas === opaque.canvas.id)).toBe(false)
    const onScratch = made.filter((c) => c.canvas === clear.canvas.id)
    expect(onScratch.find((c) => c.name === 'clearRect')!.args).toEqual([0, 0, W, H])
    expect(onScratch.some((c) => c.name === 'drawImage' && (c.args[0] as { tag?: string }).tag === 'still')).toBe(true)
    expect(onScratch.some((c) => c.name === 'fillRect' && c.fill === '#123456')).toBe(false)
    // Copied into `out` with alpha: cleared, then the scratch target's pixels.
    expect(contextOptions.get(out.id)).toEqual({ alpha: true })
    expect(made.filter((c) => c.canvas === out.id).map((c) => [c.name, c.args])).toEqual([
      ['clearRect', [0, 0, W, H]],
      ['drawImage', [clear.canvas, 0, 0]]
    ])
    // The composed A* is kept in a canvas of the export's own: an opaque A* of the same window is another.
    const plain = canvas() as Canvas
    const at = calls.length
    joinLayer.composeJoinStill(opaque, plain, W, H, window, baseScene(p), STILLS, null)
    expect(calls.slice(at).some((c) => c.canvas === clear.canvas.id)).toBe(false)
    expect(contextOptions.get(plain.id)).toEqual({ alpha: false })
    // The alpha argument overrides the scene's (an explicit transparent A* of an opaque scene).
    const forced = canvas() as Canvas
    joinLayer.composeJoinStill(opaque, forced, W, H, window, baseScene(p), STILLS, null, 'background')
    expect(contextOptions.get(forced.id)).toEqual({ alpha: true })
    // Releasing lets go of both.
    joinLayer.releaseScratch()
    expect([opaque.canvas.width, clear.canvas.width]).toEqual([0, 0])
    expect(joinLayer.scratchTarget('gpu', W, H, true)).not.toBe(clear)
  })

  it("a dip at alpha 0.5 halves the picture's alpha ('destination-out') and leaves the overlays", () => {
    const p = project({ all: { kind: 'dip', color: '#ffffff' } })
    const v = 3.875
    const none = () => null
    const clear = drawn(p, { ...baseScene(p), alpha: 'background' }, v, true, none).calls as { name: string; args: string; alpha: number; fill: unknown; composite: unknown }[]
    const out = clear.filter((c) => c.name === 'fillRect' && c.composite === 'destination-out')
    expect(out).toHaveLength(1)
    expect(out[0].args).toBe(JSON.stringify([0, 0, W, H]))
    expect(out[0].alpha).toBeCloseTo(0.5, 9)
    // An opaque fill: destination-out keeps 1 - 1 × 0.5 of each pixel's alpha.
    expect(out[0].fill).toBe('#000')
    const kept = (a: number) => a * (1 - 1 * out[0].alpha)
    expect(kept(1)).toBeCloseTo(0.5, 9)
    expect(kept(0.6)).toBeCloseTo(0.3, 9)
    // No dip colour, and the overlays after it are drawn normally (not cut out).
    expect(clear.some((c) => c.fill === '#ffffff' && c.name === 'fillRect')).toBe(false)
    const after = clear.slice(clear.indexOf(out[0]) + 1)
    const text = after.filter((c) => c.name === 'fillText')
    expect(text.length).toBeGreaterThan(0)
    expect(text.every((c) => c.composite !== 'destination-out')).toBe(true)
    // The opaque frame fills the dip's colour as before.
    const opaque = drawn(p, baseScene(p), v, false, none).calls as { name: string; fill: unknown; composite: unknown; alpha: number }[]
    const fill = opaque.filter((c) => c.name === 'fillRect' && c.fill === '#ffffff')
    expect(fill).toHaveLength(1)
    expect(fill[0].alpha).toBeCloseTo(0.5, 9)
    expect(opaque.some((c) => c.composite === 'destination-out')).toBe(false)
  })

  it('endJoin without alpha draws the dip as before; with it, the colour is never used', () => {
    const p = project({ all: { kind: 'dip', color: '#ff0000' } })
    const window = joinPlan(p)[0]
    const join = { at: { window, p: 0.5 }, still: null }
    const run = (alpha?: 'background' | 'overlays') => {
      const c = canvas() as Canvas
      const ctx = c.getContext('2d') as Ctx
      const from = calls.length
      ctx.save()
      joinLayer.endJoin(ctx, W, H, join, alpha)
      return calls.slice(from).filter((x) => x.name === 'fillRect')
    }
    expect(run().map((c) => [c.fill, c.composite])).toEqual([['#ff0000', undefined]])
    expect(run('background').map((c) => [c.fill, c.composite])).toEqual([['#000', 'destination-out']])
    expect(run('overlays').map((c) => [c.fill, c.composite])).toEqual([['#000', 'destination-out']])
  })

  it('a punch-in still scales the content in a transparent frame', () => {
    const p = project({ all: { kind: 'punch' } })
    const plain = project(undefined)
    const recording = (proj: Project, alpha?: 'background') =>
      (drawn(proj, alpha ? { ...baseScene(proj), alpha } : baseScene(proj), 6, !!alpha, () => null).calls as { name: string; args: string }[]).find(
        (c) => c.name === 'drawImage' && c.args.includes('"tag":"frame"')
      )!.args
    const punched = JSON.parse(recording(p, 'background')) as number[]
    const flat = JSON.parse(recording(plain, 'background')) as number[]
    // The same source rectangle as the opaque punched frame, 1.1 times smaller than without the punch.
    expect(recording(p, 'background')).toBe(recording(p))
    expect(punched[3]).toBeCloseTo(flat[3] / 1.1, 9)
    expect(punched[4]).toBeCloseTo(flat[4] / 1.1, 9)
    punched.slice(5).forEach((v, i) => expect(v).toBeCloseTo(flat[5 + i], 9))
  })
})
