import { describe, expect, it, vi } from 'vitest'
import { sceneCameraBox } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * The camera's background blur in the webcam layer (render/webcamLayer.ts), drawn on canvases
 * that record every call with the state it was made in: the soft pictures (the mask, the blurred
 * background) are scaled up with 'low' smoothing, and the blurred background and the person are
 * put together once per camera frame, so a fading camera is one draw at its opacity.
 */

interface Call {
  canvas: string
  name: string
  args: unknown[]
  alpha: number
  quality: string
  op: string
}
const calls: Call[] = []
let made = 0

/** A canvas whose 2D context records its calls (and keeps save/restore state). */
function recordingCanvas(name: string): Record<string, unknown> {
  const canvas: Record<string, unknown> = { width: 0, height: 0, name }
  let state = { globalAlpha: 1, imageSmoothingQuality: 'low', globalCompositeOperation: 'source-over' }
  const stack: (typeof state)[] = []
  const ctx: Record<string | symbol, unknown> = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'canvas') return canvas
      if (prop in state) return state[prop as keyof typeof state]
      if (prop in target) return target[prop]
      return (...args: unknown[]) => {
        if (prop === 'save') stack.push({ ...state })
        if (prop === 'restore') state = stack.pop() ?? state
        calls.push({ canvas: name, name: String(prop), args, alpha: state.globalAlpha, quality: state.imageSmoothingQuality, op: state.globalCompositeOperation })
      }
    },
    set(target, prop, value) {
      if (prop in state) (state as Record<string, unknown>)[prop as string] = value
      else target[prop] = value
      return true
    }
  })
  canvas.getContext = () => ctx
  return canvas
}

// The blur canvases are made in this order: person (the finished picture), tmp, blurred, rawMask, mask.
const NAMES = ['person', 'tmp', 'blurred', 'rawMask', 'mask']
vi.stubGlobal('document', { createElement: () => recordingCanvas(made < NAMES.length ? NAMES[made++] : `canvas ${made++}`) })
vi.stubGlobal('Path2D', class {})

/** A decoded camera frame with its person mask prepared (as the export does before drawing). */
const MASK = { pixels: { width: 4, height: 4, data: new Uint8ClampedArray(64) } }
vi.mock('../src/renderer/src/render/segmentation/cameraMasks', () => ({
  maskOf: (image: { mask?: unknown }) => image.mask,
  livePicture: () => null,
  releaseLivePicture: () => undefined
}))

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const LAYER = '../src/renderer/src/render/webcamLayer'
const { drawWebcamLayer } = (await import(/* @vite-ignore */ LAYER)) as { drawWebcamLayer: (fc: unknown, camera: unknown) => void }

/** A camera with its background fully blurred, hidden by 'screen-only' from 2 to 8 s (fading out from 2 to 2.4 s). */
function project(): Project {
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
  p.webcam = { ...p.webcam, show: true, backgroundBlur: 1 }
  p.layouts = [{ id: 'l', start: 2, end: 8, layout: 'screen-only' }]
  return p
}

describe('webcam layer: background blur', () => {
  const p = project()
  const out = recordingCanvas('out')
  const ctx = (out.getContext as () => unknown)()
  const frame = (i: number) => ({ image: { tag: `camera ${i}`, mask: MASK }, width: 1280, height: 720 })
  const draw = (t: number, camera: unknown): Call[] => {
    calls.length = 0
    drawWebcamLayer({ ctx, project: p, w: 1920, h: 1080, k: 1, vw: 1920, vh: 1080, t }, camera)
    return [...calls]
  }

  it('fades the blurred camera as one picture: one draw at the camera opacity, no person drawn over its own background', () => {
    const opacity = sceneCameraBox(p, 1920, 1080, 1920, 1080, 2.2)!.opacity
    expect(opacity).toBeGreaterThan(0.2)
    expect(opacity).toBeLessThan(0.8)
    const c = draw(2.2, frame(0))
    const onFrame = c.filter((x) => x.canvas === 'out' && x.name === 'drawImage')
    expect(onFrame).toHaveLength(1)
    expect((onFrame[0].args[0] as { name: string }).name).toBe('person')
    expect(onFrame[0].alpha).toBeCloseTo(opacity, 9)
    // The sharp picture is scaled into the box at full quality.
    expect(onFrame[0].quality).toBe('high')
    // Settled (its shadow now a sprite), the camera is the same single draw.
    const camera = (x: Call): boolean => x.canvas === 'out' && x.name === 'drawImage' && ['person', 'blurred'].includes((x.args[0] as { name: string }).name)
    expect(draw(1, frame(1)).filter(camera).map((x) => (x.args[0] as { name: string }).name)).toEqual(['person'])
  })

  it("scales the soft pictures (the mask, the blurred background) up with 'low' smoothing, once per camera frame", () => {
    const f = frame(2)
    const c = draw(1, f)
    const person = c.filter((x) => x.canvas === 'person' && x.name === 'drawImage')
    const source = (x: Call): string => (x.args[0] as { name?: string; tag?: string }).name ?? (x.args[0] as { tag: string }).tag
    // The picture, cut out along the mask, the blurred background behind it.
    expect(person.map((x) => [source(x), x.op])).toEqual([
      ['camera 2', 'copy'],
      ['mask', 'destination-in'],
      ['blurred', 'destination-over']
    ])
    for (const x of person.slice(1)) expect(x.quality).toBe('low')
    // The next output frame shows the same camera frame: nothing is made again.
    const again = draw(1.01, f)
    expect(again.filter((x) => x.canvas !== 'out')).toEqual([])
  })

  it('draws nothing, and prepares nothing, where the layout hides the camera', () => {
    expect(draw(5, frame(3))).toEqual([])
  })
})
