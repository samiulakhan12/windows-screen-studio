import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

import { SmoothedTrack } from '../src/shared/engine/cursor'
import { deviceFrameDrawing } from '../src/shared/engine/deviceFrames'
import { styleContentRect } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import type { CursorTrack, Project, StyleSettings, ZoomSegment } from '../src/shared/types'

type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }

interface Call {
  name: string
  args: unknown[]
  state: Record<string, unknown>
}

function recordingContext() {
  const calls: Call[] = []
  const state: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
        return (...args: unknown[]) => {
          calls.push({ name: String(prop), args, state: {} })
          return { addColorStop() {} }
        }
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
      return (...args: unknown[]) =>
        void calls.push({ name: String(prop), args, state: { fillStyle: target.fillStyle, shadowBlur: target.shadowBlur, shadowColor: target.shadowColor, globalAlpha: target.globalAlpha, font: target.font } })
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

function makeProject(style: Partial<StyleSettings>, zooms: ZoomSegment[] = []): Project {
  const project = createProject({
    id: 'p',
    name: 'Demo project',
    duration: 30,
    width: 1600,
    height: 900,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms,
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  project.style = { background: { type: 'color', color: '#123456' }, padding: 0.1, cornerRadius: 20, shadow: 0.5, aspectRatio: 'auto', ...style }
  project.effects.motionBlur = 0
  return project
}

function draw(project: Project, t = 3) {
  const cursor: CursorTrack = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
  const path = new SmoothedTrack([], project.duration, 0)
  const { ctx, calls } = recordingContext()
  const screenFrame = { image: { tag: 'frame' }, width: 1600, height: 900 }
  drawFrame(ctx, W, H, t, { project, cursor, cursorPath: path, focusPath: path }, { screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame }, { blurSamples: 1 })
  return calls
}

const frameDraw = (calls: Call[]) => calls.find((c) => c.name === 'drawImage' && (c.args[0] as { tag?: string }).tag === 'frame')!
const nums = (args: unknown[]) => args.map((a) => +Number(a).toFixed(4))

describe('device frames in the compositor', () => {
  it('draws the browser chrome, then clips the recording to its window shape', () => {
    const project = makeProject({ frame: { kind: 'browser', theme: 'dark' } })
    const calls = draw(project)
    const rect = styleContentRect(W, H, 1600, 900, project.style)
    const dots = calls.filter((c) => c.name === 'arc')
    expect(dots.map((c) => c.state.fillStyle)).toEqual(['#ff5f57', '#febc2e', '#28c840'])
    const title = calls.find((c) => c.name === 'fillText')!
    expect(title.args[0]).toBe('Demo project')
    // The clip right before the recording: square top corners, rounded bottom ones.
    const i = calls.indexOf(frameDraw(calls))
    const clip = calls.slice(0, i).filter((c) => c.name === 'roundRect').at(-1)!
    expect(nums(clip.args.slice(0, 4))).toEqual(nums([rect.x, rect.y, rect.w, rect.h]))
    expect(clip.args[4]).toEqual([0, 0, 20, 20])
    expect(nums(frameDraw(calls).args.slice(5))).toEqual(nums([rect.x, rect.y, rect.w, rect.h]))
  })

  it('a frame title of its own replaces the project name', () => {
    const calls = draw(makeProject({ frame: { kind: 'browser', theme: 'light', title: 'acme.dev/pricing' } }))
    expect(calls.find((c) => c.name === 'fillText')!.args[0]).toBe('acme.dev/pricing')
  })

  it('the laptop frame shrinks and moves with a pulled-back card', () => {
    const zoom: ZoomSegment = { id: 'z', start: 1, end: 5, scale: 0.5, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }
    const style: Partial<StyleSettings> = { frame: { kind: 'laptop', theme: 'light' } }
    const still = draw(makeProject(style), 0.2)
    const pulled = draw(makeProject(style, [zoom]), 3)
    const camera = (calls: Call[]) => calls.filter((c) => c.name === 'arc')[0].args.map(Number)
    const [x0, y0, r0] = camera(still)
    const [x1, y1, r1] = camera(pulled)
    expect(r1).toBeCloseTo(r0 / 2, 6)
    const rect = styleContentRect(W, H, 1600, 900, makeProject(style).style)
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    expect(x1 - cx).toBeCloseTo((x0 - cx) / 2, 6)
    expect(y1 - cy).toBeCloseTo((y0 - cy) / 2, 6)
    // The recording keeps its own small device corners, scaled too.
    const clipRadii = (calls: Call[]) => (calls.slice(0, calls.indexOf(frameDraw(calls))).filter((c) => c.name === 'roundRect').at(-1)!.args[4] as number[])[0]
    expect(clipRadii(pulled)).toBeCloseTo(clipRadii(still) / 2, 6)
  })

  it('every device draws something outside the recording, and nothing outside its box', () => {
    for (const kind of ['browser', 'laptop', 'monitor', 'phone'] as const) {
      const project = makeProject({ frame: { kind, theme: 'dark' } })
      const calls = draw(project)
      const rect = styleContentRect(W, H, 1600, 900, project.style)
      const outer = deviceFrameDrawing({ kind, theme: 'dark' }, rect, { radius: 20, title: '' }).outer
      const rr = calls.filter((c) => c.name === 'roundRect').map((c) => c.args.map(Number))
      expect(rr.some(([x, y, w, h]) => x < rect.x - 1 || y < rect.y - 1 || x + w > rect.x + rect.w + 1 || y + h > rect.y + rect.h + 1)).toBe(true)
      for (const [x, y, w, h] of rr) {
        expect(x).toBeGreaterThanOrEqual(outer.x - 1e-6)
        expect(y + h).toBeLessThanOrEqual(outer.y + outer.h + 1e-6)
        expect(x + w).toBeLessThanOrEqual(outer.x + outer.w + 1e-6)
      }
    }
  })
})

describe('card looks', () => {
  it('hard shadows are a solid offset copy in the shadow colour, with no blur', () => {
    const calls = draw(makeProject({ shadowStyle: 'hard', shadowColor: '#ff0000', shadow: 1 }))
    const fill = calls.find((c) => c.name === 'fill' && c.state.fillStyle === '#ff0000')!
    expect(fill).toBeDefined()
    expect(fill.state.shadowBlur ?? 0).toBe(0)
    const rect = styleContentRect(W, H, 1600, 900, { padding: 0.1 })
    const offset = calls[calls.indexOf(fill) - 1]
    expect(offset.name).toBe('roundRect')
    expect(nums(offset.args.slice(0, 2))).toEqual(nums([rect.x + 26, rect.y + 26]))
  })

  it('glows are coloured and blurred all around', () => {
    const calls = draw(makeProject({ shadowStyle: 'glow', shadowColor: '#00ff00', shadow: 1 }))
    const glow = calls.find((c) => c.name === 'fill' && Number(c.state.shadowBlur) > 0)!
    expect(glow.state.shadowColor).toBe('rgba(0,255,0,1)')
    expect(Number(glow.state.shadowBlur)).toBeCloseTo(110)
  })

  it('a solid border is a ring around the card in its colour', () => {
    const calls = draw(makeProject({ border: { width: 8, color: '#ff00ff', glass: false } }))
    const ring = calls.find((c) => c.name === 'fill' && c.state.fillStyle === '#ff00ff')!
    expect(ring.args[0]).toBe('evenodd')
    const rect = styleContentRect(W, H, 1600, 900, { padding: 0.1 })
    const rr = calls.slice(0, calls.indexOf(ring)).filter((c) => c.name === 'roundRect').slice(-2)
    expect(nums(rr[0].args.slice(0, 4))).toEqual(nums([rect.x - 8, rect.y - 8, rect.w + 16, rect.h + 16]))
    expect(nums(rr[1].args.slice(0, 4))).toEqual(nums([rect.x, rect.y, rect.w, rect.h]))
  })

  it('a glass border keeps the shadow off the card (it shows through)', () => {
    const calls = draw(makeProject({ border: { width: 10, color: '#ffffff', glass: true } }))
    const clipIdx = calls.findIndex((c) => c.name === 'clip' && c.args[0] === 'evenodd')
    const shadowIdx = calls.findIndex((c) => c.name === 'fill' && Number(c.state.shadowBlur) > 0)
    expect(clipIdx).toBeGreaterThanOrEqual(0)
    expect(clipIdx).toBeLessThan(shadowIdx)
  })
})

describe('animated backgrounds', () => {
  it('draw a different picture at different times, and the same one a loop later', () => {
    const style: Partial<StyleSettings> = { background: { type: 'animated', preset: 'ocean', speed: 1 } }
    const gradients = (t: number) => JSON.stringify(draw(makeProject(style), t).filter((c) => c.name === 'createRadialGradient').map((c) => nums(c.args)))
    expect(gradients(1)).not.toEqual(gradients(4))
    expect(gradients(1)).toEqual(gradients(21))
  })
})

describe('watermark', () => {
  it('stamps text in the chosen corner, over everything, at its opacity', () => {
    const project = makeProject({})
    project.watermark = { show: true, kind: 'text', text: 'ACME', position: 'top-left', size: 0.05, opacity: 0.6, margin: 0.03 }
    const calls = draw(project)
    const text = calls.filter((c) => c.name === 'fillText').at(-1)!
    expect(text.args[0]).toBe('ACME')
    expect(text.state.globalAlpha).toBe(0.6)
    expect(Number(text.args[1])).toBeCloseTo(0.03 * 1080)
    expect(Number(text.args[2])).toBeCloseTo(0.03 * 1080 + (0.05 * 1080) / 2)
    // Drawn last: after the recording.
    expect(calls.indexOf(text)).toBeGreaterThan(calls.indexOf(frameDraw(calls)))
  })

  it('draws nothing when hidden or empty', () => {
    const project = makeProject({})
    project.watermark = { show: false, kind: 'text', text: 'ACME', position: 'top-left', size: 0.05, opacity: 0.6, margin: 0.03 }
    expect(draw(project).some((c) => c.name === 'fillText')).toBe(false)
    project.watermark = { ...project.watermark, show: true, text: ' ' }
    expect(draw(project).some((c) => c.name === 'fillText')).toBe(false)
  })
})
