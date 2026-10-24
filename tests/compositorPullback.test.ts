import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import type { Camera } from '../src/shared/engine/zoom'
import type { CursorTrack, ZoomSegment } from '../src/shared/types'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame, cardRect, viewSource } = (await import(/* @vite-ignore */ COMPOSITOR)) as {
  drawFrame: DrawFrame
  cardRect: (r: Rect, c: Camera) => Rect
  viewSource: (c: Camera, r: Rect) => { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } | null
}

function recordingContext() {
  const calls: { name: string; args: unknown[]; state: Record<string, unknown> }[] = []
  const state: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
      return (...args: unknown[]) => void calls.push({ name: String(prop), args, state: { shadowBlur: target.shadowBlur, globalAlpha: target.globalAlpha } })
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

/** Draws one 1920x1080 frame of an 1600x900 recording (padding 10%) with `zooms` at time t. */
function draw(zooms: ZoomSegment[], t: number, blur = 1) {
  const project = createProject({
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
  project.style = { background: { type: 'color', color: '#123456' }, padding: 0.1, cornerRadius: 20, shadow: 0.5, aspectRatio: 'auto' }
  project.effects.motionBlur = blur
  const cursor: CursorTrack = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
  const path = new SmoothedTrack([], 6, 0)
  const { ctx, calls } = recordingContext()
  const screenFrame = { image: { tag: 'frame' }, width: 1600, height: 900 }
  drawFrame(ctx, W, H, t, { project, cursor, cursorPath: path, focusPath: path }, { screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame }, { blurSamples: blur > 0 ? 8 : 1 })
  return calls
}

// contentRect for 1600x900 in 1920x1080 with 108 px padding: fitted into 1704 x 864.
const LAYOUT = { x: (1920 - 1536) / 2, y: 108, w: 1536, h: 864 }

const zoom = (scale: number, extra: Partial<ZoomSegment> = {}): ZoomSegment => ({ id: 'z', start: 1, end: 5, scale, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false, ...extra })

describe('pull back draws a smaller, crisp card over the background', () => {
  it('without a zoom the card fills the layout rectangle (cached static layer path)', () => {
    const calls = draw([], 3)
    const rr = calls.filter((c) => c.name === 'roundRect')
    expect(rr.at(-1)!.args.slice(0, 4).map(Number)).toEqual([LAYOUT.x, LAYOUT.y, LAYOUT.w, LAYOUT.h])
    const img = calls.find((c) => c.name === 'drawImage' && (c.args[0] as { tag?: string }).tag === 'frame')!
    expect(img.args.slice(1).map(Number)).toEqual([0, 0, 1600, 900, LAYOUT.x, LAYOUT.y, LAYOUT.w, LAYOUT.h])
  })

  it('at 0.5x the card, its corners and its shadow shrink around the centre', () => {
    const calls = draw([zoom(0.5)], 3)
    const card = { x: LAYOUT.x + LAYOUT.w / 4, y: LAYOUT.y + LAYOUT.h / 4, w: LAYOUT.w / 2, h: LAYOUT.h / 2 }
    // Background, then shadow + well, then the clip, all at the card's size with half the radius.
    expect(calls.some((c) => c.name === 'fillRect' && c.args.map(Number).join() === `0,0,${W},${H}`)).toBe(true)
    const rr = calls.filter((c) => c.name === 'roundRect')
    expect(rr.length).toBeGreaterThanOrEqual(3)
    for (const c of rr) {
      expect(c.args.slice(0, 4).map(Number)).toEqual([card.x, card.y, card.w, card.h])
      expect(Number(c.args[4])).toBeCloseTo(10)
    }
    const shadowed = calls.find((c) => c.name === 'fill' && Number(c.state.shadowBlur) > 0)!
    expect(Number(shadowed.state.shadowBlur)).toBeCloseTo(70 * 0.5 * 0.5)
    // The whole recording is drawn into the card.
    const img = calls.find((c) => c.name === 'drawImage' && (c.args[0] as { tag?: string }).tag === 'frame')!
    expect(img.args.slice(1).map((n) => +Number(n).toFixed(6))).toEqual([0, 0, 1600, 900, card.x, card.y, card.w, card.h])
  })

  it('a fixed-point pull-back shrinks towards that point', () => {
    const calls = draw([zoom(0.8, { focus: { mode: 'fixed', x: 1, y: 0 } })], 3)
    const rr = calls.filter((c) => c.name === 'roundRect').at(-1)!.args.map(Number)
    // The top-right corner stays where it was.
    expect(rr[0] + rr[2]).toBeCloseTo(LAYOUT.x + LAYOUT.w)
    expect(rr[1]).toBeCloseTo(LAYOUT.y)
    expect(rr[2]).toBeCloseTo(LAYOUT.w * 0.8)
  })

  it('zoomed in, the card stays put and only the view inside it changes', () => {
    const calls = draw([zoom(2, { focus: { mode: 'region', x: 0.1, y: 0.2, w: 0.25, h: 0.25 } })], 3)
    const rr = calls.filter((c) => c.name === 'roundRect').at(-1)!.args.map(Number)
    expect(rr.slice(0, 4)).toEqual([LAYOUT.x, LAYOUT.y, LAYOUT.w, LAYOUT.h])
    const img = calls.find((c) => c.name === 'drawImage' && (c.args[0] as { tag?: string }).tag === 'frame')!
    // Region (0.1, 0.2, 0.25 x 0.25) -> 4x on exactly that part of the recording.
    expect(img.args.slice(1, 5).map((n) => +Number(n).toFixed(4))).toEqual([160, 180, 400, 225])
  })

  it('motion blur sub-frames during a pull-back average the largest view first', () => {
    const calls = draw([zoom(0.5, { transition: 0.5 })], 1.25)
    const frames = calls.filter((c) => c.name === 'drawImage' && (c.args[0] as { tag?: string }).tag === 'frame')
    expect(frames.length).toBeGreaterThan(1)
    expect(frames[0].state.globalAlpha).toBe(1)
    const widths = frames.map((f) => Number(f.args[7]))
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThanOrEqual(widths[i - 1] + 1e-9)
  })
})

describe('card geometry helpers', () => {
  it('cardRect is the layout rectangle unless pulled back', () => {
    expect(cardRect(LAYOUT, { scale: 2, cx: 0.3, cy: 0.3 })).toBe(LAYOUT)
    expect(cardRect(LAYOUT, { scale: 0.5, cx: 0.5, cy: 0.5 })).toEqual({ x: LAYOUT.x + LAYOUT.w / 4, y: LAYOUT.y + LAYOUT.h / 4, w: LAYOUT.w / 2, h: LAYOUT.h / 2 })
  })

  it('viewSource clips a pulled-back viewport to the recording', () => {
    const v = viewSource({ scale: 0.5, cx: 0.5, cy: 0.5 }, { x: 0, y: 0, w: 100, h: 100 })!
    expect(v).toEqual({ sx: 0, sy: 0, sw: 1, sh: 1, dx: 25, dy: 25, dw: 50, dh: 50 })
    const z = viewSource({ scale: 2, cx: 0.25, cy: 0.75 }, { x: 10, y: 10, w: 100, h: 100 })!
    expect(z).toEqual({ sx: 0, sy: 0.5, sw: 0.5, sh: 0.5, dx: 10, dy: 10, dw: 100, dh: 100 })
  })
})
