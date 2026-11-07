/**
 * Drawing a cut's join (docs/design/editing-polish.md §5.5, §5.6; §19.1 test 18), with a context
 * that records its calls: A* after the picture and before the overlays, which are drawn once and
 * the same; a slide's offsets; a dip's fill; a punch-in that scales only the content (the frame's
 * camera, its motion-blur sub-frames, the camera's framing in a camera layout); a null still draws
 * a hard cut.
 */
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

import { SmoothedTrack } from '../src/shared/engine/cursor'
import { planOf } from '../src/shared/engine/freeze'
import { cameraSourceRect, type Rect } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import { joinAt, joinPlan, type JoinAt } from '../src/shared/render/joins'
import type { CursorTrack, LayoutSegment, Project, ProjectJoins, ZoomSegment } from '../src/shared/types'

type Src = { screen: unknown; webcam: null; background: null; screenFrame: unknown; webcamFrame?: unknown }
type Extras = { video?: number; join?: { at: JoinAt; still: unknown } | null }
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: Src, options?: { blurSamples?: number }, soundTime?: number, extras?: Extras) => void
type DrawPicture = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: Src, options?: { blurSamples?: number }, soundTime?: number) => unknown
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame, drawFramePicture } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame; drawFramePicture: DrawPicture }

interface Call {
  name: string
  args: unknown[]
  alpha: unknown
  fill: unknown
  shadow: unknown
}

/** A context that records its calls with the state they draw with, and keeps a save/restore stack as a canvas does. */
function recordingContext() {
  const calls: Call[] = []
  const state: Record<string | symbol, unknown> = {}
  const stack: Record<string | symbol, unknown>[] = []
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'save')
        return () => {
          stack.push({ ...target })
          calls.push({ name: 'save', args: [], alpha: target.globalAlpha, fill: target.fillStyle, shadow: target.shadowBlur })
        }
      if (prop === 'restore')
        return () => {
          const back = stack.pop()
          if (back) {
            for (const k of Object.keys(target)) delete target[k]
            Object.assign(target, back)
          }
          calls.push({ name: 'restore', args: [], alpha: target.globalAlpha, fill: target.fillStyle, shadow: target.shadowBlur })
        }
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return (s: string) => ({ width: String(s).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      if (prop === 'getLineDash') return () => []
      return (...args: unknown[]) => void calls.push({ name: String(prop), args, alpha: target.globalAlpha, fill: target.fillStyle, shadow: target.shadowBlur })
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
const CLIPS = [
  { id: 'a', start: 0, end: 4, speed: 1 },
  { id: 'b', start: 5, end: 10, speed: 1 }
]

function project(joins: ProjectJoins | undefined, over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 10,
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
  return {
    ...p,
    clips: CLIPS,
    annotations: [{ id: 't', start: 0, end: 10, text: 'Open the billing page', x: 0.5, y: 0.85, size: 0.05, style: 'pill' }],
    ...(joins ? { joins } : {}),
    ...over
  }
}

const STILL = { tag: 'A*' }
const FRAME = { image: { tag: 'frame' }, width: 1600, height: 900 }
const CAM = { image: { tag: 'cam' }, width: 1280, height: 720 }
const cursor: CursorTrack = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
const path = new SmoothedTrack([], 10, 0)
const scene = (p: Project) => ({ project: p, cursor, cursorPath: path, focusPath: path })
const src = (camera = false): Src => ({ screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame: FRAME, ...(camera ? { webcamFrame: CAM } : {}) })

/** The frame at video time `v` (source time 5 + v − 4 in B), with its join. */
function frame(p: Project, v: number, still: unknown = STILL, opts = { blurSamples: 1 }, camera = false): Call[] {
  const at = joinAt(joinPlan(p), v)
  const t = v < 4 ? v : 5 + (v - 4)
  const { ctx, calls } = recordingContext()
  drawFrame(ctx, W, H, t, scene(p), src(camera), opts, t, at ? { video: v, join: { at, still } } : undefined)
  return calls
}

/** The calls the picture alone makes for the same frame (without the join). */
function pictureCalls(p: Project, t: number, camera = false): number {
  const { ctx, calls } = recordingContext()
  drawFramePicture(ctx, W, H, t, scene(p), src(camera), { blurSamples: 1 }, t)
  return calls.length
}

const strip = (c: Call[]): string => JSON.stringify(c.map((x) => [x.name, x.args, x.alpha, x.fill]))
const isStill = (c: Call): boolean => c.name === 'drawImage' && c.args[0] === STILL
const isFrame = (c: Call): boolean => c.name === 'drawImage' && (c.args[0] as { tag?: string }).tag === 'frame'
const isCam = (c: Call): boolean => c.name === 'drawImage' && (c.args[0] as { tag?: string }).tag === 'cam'

describe('drawing a join (test 18)', () => {
  it('draws A* over the picture at 1 − p and before the overlays, which are drawn once and the same', () => {
    const p = project({ all: { kind: 'crossfade' } })
    const plain = project(undefined)
    const v = 4.05
    const n = pictureCalls(p, 5.05)
    const joined = frame(p, v)
    const without = frame(plain, v)
    expect(n).toBe(pictureCalls(plain, 5.05))
    // The picture first, exactly as without the join; then A*; then the overlays, exactly as without it.
    expect(strip(joined.slice(0, n))).toBe(strip(without.slice(0, n)))
    expect(joined.slice(n, n + 3).map((c) => c.name)).toEqual(['save', 'drawImage', 'restore'])
    const still = joined[n + 1]
    expect(isStill(still)).toBe(true)
    expect(still.args.slice(1)).toEqual([0, 0, W, H])
    expect(still.alpha).toBeCloseTo(1 - 0.05 / 0.15, 12)
    expect(strip(joined.slice(n + 3))).toBe(strip(without.slice(n)))
    // The text is drawn once.
    expect(joined.filter((c) => c.name === 'fillText').length).toBe(without.filter((c) => c.name === 'fillText').length)
    expect(joined.filter((c) => c.name === 'fillText').length).toBeGreaterThan(0)
    expect(joined.filter(isStill)).toHaveLength(1)
  })

  it('draws a hard cut for a null still', () => {
    const p = project({ all: { kind: 'crossfade' } })
    expect(strip(frame(p, 4.05, null))).toBe(strip(frame(project(undefined), 4.05)))
    const slide = project({ all: { kind: 'slide' } })
    expect(strip(frame(slide, 4.1, null))).toBe(strip(frame(project(undefined), 4.1)))
  })

  it('moves the live picture and A* by the slide\'s offsets, the overlays not at all', () => {
    const p = project({ all: { kind: 'slide', from: 'left' } })
    const v = 4.1
    const at = joinAt(joinPlan(p), v)!
    const calls = frame(p, v)
    // Saved and moved before anything of the picture is drawn.
    expect(calls[0].name).toBe('save')
    expect(calls[1].name).toBe('translate')
    const [dx, dy] = calls[1].args as number[]
    expect(dy).toBe(0)
    expect(dx).toBeLessThan(0)
    expect(dx).toBeGreaterThan(-W)
    const still = calls.find(isStill)!
    expect(still.alpha).toBe(1)
    expect((still.args[1] as number) - dx).toBeCloseTo(W, 9)
    // The picture's own save and the slide's are restored before A*, and one save is left for drawFrame.
    const i = calls.indexOf(still)
    expect(calls.slice(i - 4, i).map((c) => c.name)).toEqual(['restore', 'restore', 'save', 'save'])
    const saves = calls.filter((c) => c.name === 'save').length
    const restores = calls.filter((c) => c.name === 'restore').length
    expect(saves).toBe(restores)
    // The overlays are the same calls as without the slide.
    const without = frame(project(undefined), v)
    const text = (c: Call[]) => strip(c.filter((x) => x.name === 'fillText'))
    expect(text(calls)).toBe(text(without))
    expect(at.window.kind).toBe('slide')
  })

  it('fills a dip\'s colour over the picture', () => {
    const p = project({ all: { kind: 'dip', color: '#ffffff' } })
    const mid = frame(p, 4)
    const fill = mid.find((c) => c.name === 'fillRect' && c.fill === '#ffffff')!
    expect(fill.args).toEqual([0, 0, W, H])
    expect(fill.alpha).toBeCloseTo(1, 9)
    const early = frame(p, 3.875)
    expect(early.find((c) => c.name === 'fillRect' && c.fill === '#ffffff')!.alpha).toBeCloseTo(0.5, 9)
    // A dip needs no still.
    expect(frame(p, 4, null).some((c) => c.name === 'fillRect' && c.fill === '#ffffff')).toBe(true)
  })
})

describe('a punch-in scales the content only (test 18)', () => {
  const punch = { all: { kind: 'punch' as const } }
  const zoom: ZoomSegment = { id: 'z', start: 5, end: 9.5, scale: 2, focus: { mode: 'fixed', x: 0.3, y: 0.6 }, auto: false }
  const withCamera = (layouts: LayoutSegment[] = []): Partial<Project> => ({
    hasWebcam: true,
    webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    layouts
  })

  it('scales the frame\'s camera by s, the card, its shadow and the camera bubble stay', () => {
    const p = project(punch, withCamera())
    const plain = project(undefined, withCamera())
    const a = frame(p, 6, null, { blurSamples: 1 }, true)
    const b = frame(plain, 6, null, { blurSamples: 1 }, true)
    const shot = (c: Call[]) => c.find(isFrame)!.args.map(Number)
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = shot(a)
    const [, , , bw, bh, ...dest] = shot(b)
    expect(sw).toBeCloseTo(bw / 1.1, 9)
    expect(sh).toBeCloseTo(bh / 1.1, 9)
    expect(sx + sw / 2).toBeCloseTo(800, 9)
    expect(sy + sh / 2).toBeCloseTo(450, 9)
    ;[dx, dy, dw, dh].forEach((v, i) => expect(v).toBeCloseTo(dest[i], 9))
    // Everything that is not the screen's picture is drawn exactly as without the punch.
    const rest = (c: Call[]) => strip(c.filter((x) => !isFrame(x)))
    expect(rest(a)).toBe(rest(b))
    expect(a.filter(isCam)).toHaveLength(1)
    // Clip a (before the punched cut) is not punched.
    expect(strip(frame(p, 2, null, { blurSamples: 1 }, true))).toBe(strip(frame(plain, 2, null, { blurSamples: 1 }, true)))
  })

  it('scales every motion-blur sub-frame\'s camera by s', () => {
    const moving = { zooms: [zoom], effects: { ...project(undefined).effects, motionBlur: 1 } }
    const p = project(punch, moving)
    const plain = project(undefined, moving)
    // In the zoom's way in: the camera moves, so the frame is averaged from sub-frames.
    const a = frame(p, 4.2, null, { blurSamples: 8 }).filter(isFrame)
    const b = frame(plain, 4.2, null, { blurSamples: 8 }).filter(isFrame)
    expect(a.length).toBeGreaterThan(1)
    expect(a.length).toBe(b.length)
    const widths = (c: Call[]) => c.map((x) => Number(x.args[3])).sort((m, n) => m - n)
    const wa = widths(a)
    const wb = widths(b)
    wa.forEach((w, i) => expect(w).toBeCloseTo(wb[i] / 1.1, 6))
  })

  it('zooms the camera\'s framing by s about its crop centre in a camera-only layout, not the screen', () => {
    const layouts = [{ id: 'L', start: 0, end: 10, layout: 'camera-only' as const }]
    const p = project(punch, withCamera(layouts))
    const plain = project(undefined, withCamera(layouts))
    const a = frame(p, 6, null, { blurSamples: 1 }, true)
    const b = frame(plain, 6, null, { blurSamples: 1 }, true)
    const cam = a.find(isCam)!.args.map(Number)
    const before = b.find(isCam)!.args.map(Number)
    const box: Rect = { x: cam[5], y: cam[6], w: cam[7], h: cam[8] }
    expect(cam.slice(5)).toEqual(before.slice(5))
    const want = cameraSourceRect(1280, 720, box.w, box.h, { zoom: 1.1, cropX: 0.5, cropY: 0.5 })
    expect(cam.slice(1, 5)).toEqual([want.x, want.y, want.w, want.h].map(Number))
    expect(cam[3]).toBeCloseTo(before[3] / 1.1, 9)
    // The screen's picture is not punched there.
    const shot = (c: Call[]) => JSON.stringify(c.filter(isFrame).map((x) => x.args.slice(1)))
    expect(shot(a)).toBe(shot(b))
    expect(planOf(p).holds).toEqual([])
  })
})
