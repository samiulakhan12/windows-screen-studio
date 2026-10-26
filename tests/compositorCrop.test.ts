import { describe, expect, it, vi } from 'vitest'

/*
 * Drawing a cropped recording (docs/design/crop-in-editor.md §4.3): the crop's pixels are copied
 * 1:1 out of each frame into a canvas of their own and drawn from there, positions are in the
 * crop's view, and privacy blur keeps the strength of the whole frame. Drawn on canvases that
 * record every call (with the smoothing in effect).
 */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  quality: unknown
  smoothing: unknown
}
const calls: Call[] = []
let canvases = 0

/** A canvas whose 2D context records its calls. */
function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id }
  const state: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
      return (...args: unknown[]) => void calls.push({ canvas: id, name: String(prop), args, quality: target.imageSmoothingQuality, smoothing: target.imageSmoothingEnabled })
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

const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { cropView } = await import('../src/shared/engine/crop')
const { sceneContentRect } = await import('../src/shared/engine/layout')
const { createProject } = await import('../src/shared/engine/project')
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }

import type { ClickEvent, CursorTrack, NormRect, Project, Shape } from '../src/shared/types'

/** The bottom 48 px of 1280×720 (a Windows taskbar at 100%). */
const TASKBAR: NormRect = { x: 0, y: 0, w: 1, h: 672 / 720 }
const FRAME = { tag: 'screen frame' }
const W = 1280
const H = 720

function project(extra: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 4,
    width: W,
    height: H,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' }
  })
  p.cursor.hideWhenIdle = false
  p.effects.motionBlur = 0
  return { ...p, ...extra }
}

function track(clicks: ClickEvent[] = []): CursorTrack {
  return { samples: [{ t: 0, x: 0.5, y: 0.5 }, { t: 4, x: 0.5, y: 0.5 }], clicks, keys: [], shapes: [], scale: 1, valid: true }
}

/** Draws `p` with `cursor` at t through its view (cropView) on a recording canvas; the calls made on it, and every other canvas's. */
function draw(p: Project, cursor: CursorTrack, t: number, decoded = true) {
  const view = cropView(p, cursor)
  const path = new SmoothedTrack(view.cursor.samples, p.duration, 0)
  const scene = { project: view.project, cursor: view.cursor, cursorPath: path, focusPath: path, ...(view.crop ? { crop: view.crop } : {}) }
  const target = canvas()
  const ctx = (target.getContext as (t: string) => unknown)('2d')
  const screen = decoded ? { readyState: 4, videoWidth: W, videoHeight: H } : { readyState: 0, videoWidth: 0, videoHeight: 0 }
  const src = { screen, webcam: null, background: null, ...(decoded ? { screenFrame: { image: FRAME, width: W, height: H } } : {}) }
  calls.length = 0
  drawFrame(ctx, W, H, t, scene, src, { blurSamples: 1 })
  const all = calls.slice()
  return { view, all, mine: all.filter((c) => c.canvas === target.id), rect: sceneContentRect(view.project, W, H, view.project.width, view.project.height, t) }
}

describe('drawFrame with a crop', () => {
  it('draws a project without a crop exactly as before: the whole frame, straight from the video', () => {
    const p = project()
    const r = draw(p, track(), 1)
    expect(r.view.project).toBe(p)
    const frames = r.mine.filter((c) => c.name === 'drawImage' && c.args[0] === FRAME)
    expect(frames).toHaveLength(1)
    expect(frames[0].args.slice(1, 5)).toEqual([0, 0, W, H])
    expect(frames[0].quality).toBe('high')
    // No crop copy is made.
    expect(r.all.filter((c) => c.name === 'drawImage' && c.args[0] === FRAME)).toHaveLength(1)
    // The same calls as a scene built without the view at all.
    const path = new SmoothedTrack(track().samples, p.duration, 0)
    const target = canvas()
    calls.length = 0
    drawFrame((target.getContext as (t: string) => unknown)('2d'), W, H, 1, { project: p, cursor: track(), cursorPath: path, focusPath: path }, { screen: { readyState: 4, videoWidth: W, videoHeight: H }, webcam: null, background: null, screenFrame: { image: FRAME, width: W, height: H } }, { blurSamples: 1 })
    // Canvases made for each target (the static layer's) are told apart by their id only.
    const strip = (cs: Call[]) => cs.map((c) => ({ name: c.name, args: JSON.stringify(c.args, (_k, v: unknown) => (v && typeof v === 'object' && 'getContext' in v ? 'canvas' : v)), quality: c.quality }))
    expect(strip(calls.filter((c) => c.canvas === target.id))).toEqual(strip(r.mine))
  })

  it('copies the crop 1:1 out of the frame and draws the card from the copy, smoothed as before', () => {
    const r = draw(project({ crop: TASKBAR }), track(), 1)
    const copies = r.all.filter((c) => c.name === 'drawImage' && c.args[0] === FRAME)
    expect(copies).toHaveLength(1)
    expect(copies[0].args.slice(1)).toEqual([0, 0, 1280, 672, 0, 0, 1280, 672])
    expect(copies[0].smoothing).toBe(false)
    expect(copies[0].canvas).not.toBe(r.mine[0].canvas)
    const card = r.mine.filter((c) => c.name === 'drawImage' && (c.args[0] as { id?: number }).id === copies[0].canvas)
    expect(card).toHaveLength(1)
    expect(card[0].args.slice(1, 5)).toEqual([0, 0, 1280, 672])
    expect(card[0].args.slice(5)).toEqual([r.rect.x, r.rect.y, r.rect.w, r.rect.h])
    expect(card[0].quality).toBe('high')
    // The card has the crop's shape.
    expect(r.rect.w / r.rect.h).toBeCloseTo(1280 / 672, 6)
  })

  it('draws no ripple for a click under the crop, and one for a click inside it', () => {
    const ripples = (y: number): number => draw(project({ crop: TASKBAR }), track([{ t: 1, x: 0.5, y, button: 'left' }]), 1.1).mine.filter((c) => c.name === 'arc').length
    expect(ripples(0.97)).toBe(0)
    expect(ripples(0.5)).toBe(1)
  })

  it('lays the overlays out at the crop size while no frame is decoded (never 1×1)', () => {
    // The cursor at the view's bottom-right corner (the crop's), drawn where that corner is.
    const cursor: CursorTrack = { ...track(), samples: [{ t: 0, x: 1, y: 672 / 720 }, { t: 4, x: 1, y: 672 / 720 }] }
    const r = draw(project({ crop: TASKBAR }), cursor, 1, false)
    expect(r.view.project.width).toBe(1280)
    expect(r.view.project.height).toBe(672)
    const at = r.mine.find((c) => c.name === 'translate')
    expect(at).toBeDefined()
    expect(at!.args[0]).toBeCloseTo(r.rect.x + r.rect.w, 6)
    expect(at!.args[1]).toBeCloseTo(r.rect.y + r.rect.h, 6)
    expect(r.rect.w / r.rect.h).toBeCloseTo(1280 / 672, 6)
  })

  it('blurs a privacy box with the strength of the whole frame, from the crop pixels only', () => {
    const blur: Shape = { id: 'b', start: 0, end: 4, kind: 'blur', x: 0.3, y: 0.3, w: 0.2, h: 0.2, color: '#000000', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }
    // The scratch draws that read the screen picture (the frame, or the crop's copy), arguments only.
    const grabs = (p: Project): unknown[][] => {
      const r = draw(p, track(), 1)
      const copy = r.all.find((c) => c.name === 'drawImage' && c.args[0] === FRAME && c.canvas !== r.mine[0].canvas && c.args.length === 9 && c.args[5] === 0 && c.args[6] === 0 && c.args[7] === 1280)
      const pictures = new Set<unknown>([FRAME])
      if (copy) for (const c of r.all) if (c.name === 'drawImage' && (c.args[0] as { id?: number }).id === copy.canvas) pictures.add(c.args[0])
      return r.all
        .filter((c) => c.name === 'drawImage' && pictures.has(c.args[0]) && c.canvas !== r.mine[0].canvas && c !== copy)
        .map((c) => c.args.slice(1).map((v) => +(v as number).toFixed(9)))
    }
    const whole = grabs(project({ shapes: [blur] }))
    const cropped = grabs(project({ crop: TASKBAR, shapes: [blur] }))
    expect(whole.length).toBeGreaterThan(0)
    // The crop starts at the frame's corner, so the box covers the same pixels: the same blur.
    expect(cropped).toEqual(whole)
  })
})
