/**
 * Blurring from the Guide panel (docs/design/smart-tools.md §5.5.8): test 106 of §22.1. *Blur an
 * area…* adds a blur one frame before the step's shot, which the export's own drawing (drawFrame,
 * through drawPrivacyLayer) draws on the shot's frame at 30 and 60 fps; *Blur the typed text* adds
 * one shape over the typing place until the next settled page change, in one update, and the
 * marked step's shot is made again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import { focusPathFor } from '../src/shared/engine/zoom'
import type { SceneScan } from '../src/shared/api/projects'
import { blurBoxes, guideProject, planShot, shotTime } from '../src/shared/guide/shots'
import type { GuideStep } from '../src/shared/guide/steps'
import type { CursorTrack, Project } from '../src/shared/types'
import { testStore } from './studioHarness'

interface Call {
  canvas: number
  name: string
  args: unknown[]
}
const calls: Call[] = []
let canvases = 0
/** A canvas whose 2D context records every call. */
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
      return (...args: unknown[]) => void calls.push({ canvas: id, name: String(prop), args })
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

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const RUN = '../src/renderer/src/guide/guideRun'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as {
  drawFrame: (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: unknown, soundTime?: number) => void
}
const { blurArea, blurTypedText } = (await import(/* @vite-ignore */ RUN)) as {
  blurArea: (services: unknown, step: GuideStep, opts: { after: boolean; scale: number; onSelect(sel: unknown): void }) => { id: string; start: number }
  blurTypedText: (store: unknown, typing: GuideStep, marked: { t: number }, scan: SceneScan | null, scale: number) => void
}

const W = 1920
const H = 1080

function project(fps: number): Project {
  return createProject({
    id: 'p',
    name: 'Secret',
    duration: 40,
    width: W,
    height: H,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps }
  })
}

const cursor: CursorTrack = { samples: [{ t: 0, x: 0.5, y: 0.5 }, { t: 40, x: 0.5, y: 0.5 }], clicks: [{ t: 3, x: 0.5, y: 0.5, button: 'left' }], valid: true }

/** The drawImage calls that put a blurred copy of the screen over `box` when the shot's frame of `p` is drawn at `t`. */
function blurredAt(p: Project, t: number, box: { x: number; y: number; w: number; h: number }): Call[] {
  const shot = guideProject(p)
  const scene = { project: shot, cursor, cursorPath: new SmoothedTrack(cursor.samples, shot.duration, shot.cursor.smoothing), focusPath: focusPathFor(cursor.samples, shot.duration) }
  const src = { screen: { readyState: 4, videoWidth: W, videoHeight: H }, webcam: null, background: null, screenFrame: { image: { tag: 'screen' }, width: W, height: H } }
  canvases = 0
  const c = canvas()
  calls.length = 0
  drawFrame((c.getContext as (t: string) => unknown)('2d'), W, H, t, scene, src, { blurSamples: 1 }, t)
  return calls.filter(
    (k) => k.canvas === 0 && k.name === 'drawImage' && k.args.length === 9 && Math.abs((k.args[5] as number) - box.x * W) < 1 && Math.abs((k.args[6] as number) - box.y * H) < 1 && Math.abs((k.args[7] as number) - box.w * W) < 1
  )
}

function scanWith(duration: number, changes: Record<number, number>): SceneScan {
  const t: number[] = []
  const changed: number[] = []
  for (let i = 0; i * 0.25 <= duration; i++) {
    t.push(i * 0.25)
    changed.push(changes[i * 0.25] ?? 0)
  }
  return { step: 0.25, t, changed, stills: [] }
}

describe('test 106: Blur an area…', () => {
  const click: GuideStep = { key: 'c3000', t: 3, kind: 'click', x: 0.5, y: 0.5 }
  let seeks: number[]
  let selected: unknown[]
  beforeEach(() => {
    seeks = []
    selected = []
  })

  for (const fps of [30, 60]) {
    it(`at ${fps} fps: one blur starting one frame before the shot, over 30% × 10% of the frame at the click, selected, the playhead at the shot; the shot’s frame draws it`, () => {
      const store = testStore(project(fps))
      const player = { time: 0, seek: (t: number) => void seeks.push(t), subscribe: () => () => undefined }
      const t = shotTime(click, store.state.clips, fps, false)
      expect(t).toBeCloseTo(3 - 1 / fps, 9)
      const shape = blurArea({ store, player }, click, { after: false, scale: 1, onSelect: (s) => selected.push(s) })
      expect(store.steps).toBe(1)
      const shapes = store.state.shapes ?? []
      expect(shapes).toHaveLength(1)
      const s = shapes[0]
      expect(s.kind).toBe('blur')
      expect(s.start).toBeCloseTo(t - 1 / fps, 9)
      expect(s.end - s.start).toBeCloseTo(3, 9)
      const { area } = blurBoxes(click, { w: W, h: H }, 1)
      expect({ x: s.x, y: s.y, w: s.w, h: s.h }).toEqual(area)
      expect(area).toEqual({ x: 0.35, y: 0.45, w: 0.3, h: 0.1 })
      expect(selected).toEqual([{ kind: 'shape', id: shape.id }])
      expect(seeks.at(-1)).toBeCloseTo(t, 9)
      // The export's drawing of the shot's frame covers the box with the blurred screen.
      expect(blurredAt(store.state, t, area)).toHaveLength(1)
      // And so does the frame after the shot's (the frame the preview may show there).
      expect(blurredAt(store.state, t + 1 / fps, area)).toHaveLength(1)
    })
  }

  it('after the typing (`after`): the blur starts one frame before the later shot', () => {
    const typing: GuideStep = { key: 'c20500', t: 20.5, kind: 'click', x: 0.4, y: 0.6, typing: { t: 21, end: 23, place: { x: 0.4, y: 0.6 } } }
    const store = testStore(project(60))
    const player = { time: 0, seek: (t: number) => void seeks.push(t), subscribe: () => () => undefined }
    blurArea({ store, player }, typing, { after: true, scale: 1, onSelect: () => undefined })
    expect(store.state.shapes![0].start).toBeCloseTo(23.2 - 1 / 60, 9)
    expect(seeks.at(-1)).toBeCloseTo(23.2, 9)
  })
})

describe('test 106: Blur the typed text', () => {
  const typing: GuideStep = { key: 'c20500', t: 20.5, kind: 'click', x: 0.4, y: 0.6, typing: { t: 21, end: 23, place: { x: 0.4, y: 0.6 } } }
  const marked: GuideStep = { key: 'c24500', t: 24.5, kind: 'click', x: 0.45, y: 0.6 }
  const elsewhere: GuideStep = { key: 'c10000', t: 10, kind: 'click', x: 0.45, y: 0.6 }

  it('one shape over the typing place from the burst’s start to the next settled page change, in one update; the marked shot is made again', () => {
    const store = testStore(project(60))
    const before = planShot(marked, store.state, undefined, 1, 'guide').sig
    const untouched = planShot(elsewhere, store.state, undefined, 1, 'guide').sig
    const markedT = shotTime(marked, store.state.clips, 60, false)
    blurTypedText(store, typing, { t: markedT }, scanWith(40, { 26: 62, 30: 5 }), 1)
    expect(store.steps).toBe(1)
    const shapes = store.state.shapes ?? []
    expect(shapes).toHaveLength(1)
    const s = shapes[0]
    expect(s.kind).toBe('blur')
    expect(s.start).toBe(21)
    expect(s.end).toBe(26)
    // 360 × 48 px, from 40 px left of the place (a field grows to the right).
    expect(s.x * W).toBeCloseTo(0.4 * W - 40, 6)
    expect(s.w * W).toBeCloseTo(360, 6)
    expect(s.h * H).toBeCloseTo(48, 6)
    expect(s.y + s.h / 2).toBeCloseTo(0.6, 9)
    // The marked step's shot depends on it, and is drawn with it; a step outside its time is not made again.
    expect(planShot(marked, store.state, undefined, 1, 'guide').sig).not.toBe(before)
    expect(planShot(elsewhere, store.state, undefined, 1, 'guide').sig).toBe(untouched)
    expect(blurredAt(store.state, markedT, s)).toHaveLength(1)
  })

  it('without a scene scan, until the end of the video; with the display scale, a bigger box', () => {
    const store = testStore(project(60))
    blurTypedText(store, typing, { t: 24.48 }, null, 1.5)
    const s = store.state.shapes![0]
    expect([s.start, s.end]).toEqual([21, 40])
    expect(s.w * W).toBeCloseTo(540, 6)
    expect(s.h * H).toBeCloseTo(72, 6)
  })

  it('a page change before the marked shot does not end it: the next one after the shot does', () => {
    const store = testStore(project(60))
    blurTypedText(store, typing, { t: 24.48 }, scanWith(40, { 22: 62, 31: 70 }), 1)
    expect(store.state.shapes![0].end).toBe(31)
  })
})
