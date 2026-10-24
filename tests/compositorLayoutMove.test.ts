import { describe, expect, it, vi } from 'vitest'

/*
 * The card while a camera layout change moves it (compositor.ts, staticLayer.ts paintStillCard):
 * it is drawn where it is in every frame, but its large soft shadow is not blurred again in every
 * frame: it is made once on a small sprite and stretched onto the card in nine slices. Drawn on
 * canvases that record every call.
 */

interface Call {
  canvas: number
  name: string
  args: unknown[]
}
const calls: Call[] = []
let canvases = 0

/** A canvas whose 2D context records its calls and property sets. */
function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 0, height: 0, id }
  const state: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
      return (...args: unknown[]) => void calls.push({ canvas: id, name: String(prop), args })
    },
    set(target, prop, value) {
      target[prop] = value
      calls.push({ canvas: id, name: `set ${String(prop)}`, args: [value] })
      return true
    }
  })
  c.getContext = (type: string) => (type === '2d' ? ctx : null)
  return c
}

vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('Path2D', class {})

const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { createProject } = await import('../src/shared/engine/project')
const { layoutMoving } = await import('../src/shared/engine/layout')
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }

describe('a card moved by a camera layout change', () => {
  it('stretches its soft shadow from a sprite made once, instead of blurring the card again every frame', () => {
    const p = createProject({
      id: 'p',
      name: 'p',
      duration: 10,
      width: 1920,
      height: 1080,
      hasWebcam: true,
      hasAudio: false,
      webcamOffset: 0,
      zooms: [],
      cursorValid: false,
      capture: { method: 'native', cursorInVideo: false, region: null }
    })
    p.style = { ...p.style, background: { type: 'color', color: '#203040' } }
    p.effects.motionBlur = 0
    p.webcam = { ...p.webcam, show: true }
    p.layouts = [{ id: 'l', start: 2, end: 8, layout: 'side-by-side' }]
    const path = new SmoothedTrack([], 10, 0)
    const scene = { project: p, cursor: { samples: [], clicks: [], valid: false }, cursorPath: path, focusPath: path }
    const frame = canvas()
    const ctx = (frame.getContext as (t: string) => unknown)('2d')
    const src = { screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame: { image: { tag: 'screen' }, width: 1920, height: 1080 } }
    // The card's shadow: 70 px at full strength, scaled by the style's 0.6.
    const cardBlur = (c: Call): boolean => c.name === 'set shadowBlur' && Math.abs((c.args[0] as number) - 42) < 1e-9
    const moving = [2.05, 2.1, 2.15, 2.2, 2.25]
    let sprite: number | null = null
    for (const t of moving) {
      expect(layoutMoving(p, t)).toBe(true)
      calls.length = 0
      drawFrame(ctx, 1920, 1080, t, scene, src, { blurSamples: 1 })
      // No shadow blur on the frame itself.
      expect(calls.filter((c) => c.canvas === frame.id && cardBlur(c))).toEqual([])
      const blurs = calls.filter(cardBlur)
      if (sprite === null) {
        // The first moving frame makes the sprite: the one blur.
        expect(blurs).toHaveLength(1)
        sprite = blurs[0].canvas
      } else {
        expect(blurs).toEqual([])
      }
      // Nine slices of it on the frame, on whole pixels.
      const slices = calls.filter((c) => c.canvas === frame.id && c.name === 'drawImage' && (c.args[0] as { id: number }).id === sprite)
      expect(slices).toHaveLength(9)
      for (const s of slices) for (const v of s.args.slice(5)) expect(Number.isInteger(v)).toBe(true)
    }
  })
})
