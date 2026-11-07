import { describe, expect, it, vi } from 'vitest'
import type { Annotation, CaptionSegment, CursorTrack, Project, Shape, TitleCard, ZoomSegment } from '../src/shared/types'
import { digest } from './verticalFixtures'

/*
 * Drawing animated callouts (docs/design/editing-polish.md §7.2-7.4, §19.1 tests 37, 38, 39, 41,
 * 42, 43, 44 and 78): what drawFrame draws for texts, shapes and title cards with and without the
 * new fields, step badges and speech bubbles, through the frame's camera. The canvases record
 * every call with the transform and the state it draws with.
 */

/* ---------- canvases that record their calls and their transform ---------- */

type M = [number, number, number, number, number, number]
interface Call {
  canvas: number
  name: string
  args: unknown[]
  m: M
  fill: unknown
  stroke: unknown
  alpha: unknown
  font: unknown
  align: unknown
  direction: unknown
}
const calls: Call[] = []
let canvases = 0
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]

function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id }
  const state: Record<string | symbol, unknown> = {}
  let m: M = [1, 0, 0, 1, 0, 0]
  const stack: { m: M; state: Record<string | symbol, unknown> }[] = []
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return (text: string) => ({ width: [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(String(text))].length * 10, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      if (prop === 'getTransform') return () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] })
      if (prop === 'getLineDash') return () => []
      return (...args: unknown[]) => {
        const n = args as number[]
        if (prop === 'save') stack.push({ m, state: { ...target } })
        else if (prop === 'restore') {
          const top = stack.pop()
          if (top) {
            m = top.m
            for (const k of Object.keys(target)) delete target[k]
            Object.assign(target, top.state)
          }
        } else if (prop === 'translate') m = mul(m, [1, 0, 0, 1, n[0], n[1]])
        else if (prop === 'scale') m = mul(m, [n[0], 0, 0, n[1], 0, 0])
        else if (prop === 'rotate') m = mul(m, [Math.cos(n[0]), Math.sin(n[0]), -Math.sin(n[0]), Math.cos(n[0]), 0, 0])
        else if (prop === 'setTransform' && args.length >= 6) m = n.slice(0, 6) as M
        else if (prop === 'resetTransform') m = [1, 0, 0, 1, 0, 0]
        calls.push({ canvas: id, name: String(prop), args, m, fill: target.fillStyle, stroke: target.strokeStyle, alpha: target.globalAlpha, font: target.font, align: target.textAlign, direction: target.direction })
      }
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = (type: string) => (type === '2d' ? ctx : null)
  c.toBlob = (cb: (b: null) => void) => cb(null)
  return c
}

vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('Path2D', class {})

/** A punch-in stands in for part P1's (the contracts' stub shows the content as it is): 1.1× about the view's centre while on. */
const punch = { on: false }
vi.mock('../src/shared/render/joins', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return { ...real, punchedCamera: (cam: { scale: number; cx: number; cy: number }) => (punch.on ? { ...cam, scale: cam.scale * 1.1 } : cam) }
})

/** The callout code swapped for the contracts' stubs while `stub.on` (test 37). */
const stub = { on: false, calls: 0 }
vi.mock('../src/renderer/src/render/calloutLayer', async (orig) => {
  const real = await orig<Record<string, (...a: unknown[]) => unknown>>()
  return {
    ...real,
    drawCallout: (...a: unknown[]) => (stub.calls++, stub.on ? false : real.drawCallout(...a)),
    shapeCalloutPose: (...a: unknown[]) => (stub.calls++, stub.on ? null : real.shapeCalloutPose(...a)),
    titleCalloutPose: (...a: unknown[]) => (stub.calls++, stub.on ? null : real.titleCalloutPose(...a))
  }
})

const { createProject, migrateProject } = await import('../src/shared/engine/project')
const { cropView } = await import('../src/shared/engine/crop')
const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { focusPathFor } = await import('../src/shared/engine/zoom')
const { outputSize } = await import('../src/shared/engine/layout')
const { frameView } = await import('../src/shared/engine/frameView')
const { toOutput } = await import('../src/shared/engine/outputPoint')
const { titlePhase, titleEm, titleMotionPose } = await import('../src/shared/render/titleCards')
const { EASE } = await import('../src/shared/captions/motion')
const { studioPreset } = await import('../src/shared/captions/studioPresets')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { annotationMetrics } = await import('../src/shared/render/overlays')
const { calloutPlace, calloutPose, ellipsePerimeter, rectPerimeter, badgeLabels } = await import('../src/shared/render/callouts')

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number; frameInterval?: number }, soundTime?: number) => void
const R = '../src/renderer/src/render/'
const { drawFrame } = (await import(/* @vite-ignore */ `${R}compositor`)) as { drawFrame: DrawFrame }
const layer = (await import(/* @vite-ignore */ `${R}calloutLayer`)) as {
  shapeCalloutPose: (fc: unknown, s: Shape) => unknown
  calloutFrame: (fc: unknown) => Parameters<typeof calloutPlace>[2]
}

/* ---------- projects and frames ---------- */

const track: CursorTrack = { valid: false, samples: [], clicks: [], keys: [] } as unknown as CursorTrack

function project(patch: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p3',
    name: 'Callouts',
    duration: 30,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  return { ...p, ...patch }
}

function sceneOf(p: Project): { scene: Record<string, unknown>; w: number; h: number; src: Record<string, unknown> } {
  const view = cropView(p, track)
  const scene = {
    project: view.project,
    cursor: view.cursor,
    cursorPath: new SmoothedTrack(view.cursor.samples, p.duration, p.cursor.smoothing),
    focusPath: focusPathFor(view.cursor.samples, p.duration),
    ...(view.crop ? { crop: view.crop } : {})
  }
  const { width: w, height: h } = outputSize(p.style.aspectRatio, p.width, p.height, 1080)
  const src = { screen: { readyState: 4, videoWidth: p.width, videoHeight: p.height }, webcam: null, background: null, screenFrame: { image: { tag: 'screen' }, width: p.width, height: p.height } }
  return { scene, w, h, src }
}

/** The calls drawFrame makes on the frame's canvas at source time `t`. */
function frame(p: Project, t: number): Call[] {
  const { scene, w, h, src } = sceneOf(p)
  const target = canvas()
  const ctx = (target.getContext as (t: string) => unknown)('2d')
  calls.length = 0
  drawFrame(ctx, w, h, t, scene, src, { blurSamples: 1 }, t)
  return calls.filter((c) => c.canvas === target.id)
}

/** Every call drawFrame makes at source time `t`, on the frame and on the canvases it paints sprites on. */
function frameAll(p: Project, t: number): Call[] {
  const { scene, w, h, src } = sceneOf(p)
  const target = canvas()
  const ctx = (target.getContext as (t: string) => unknown)('2d')
  calls.length = 0
  drawFrame(ctx, w, h, t, scene, src, { blurSamples: 1 }, t)
  return calls.slice()
}

/** Where a pin of the recording shows at `t`, as the compositor works it out (frameView's camera, the punch-in, toOutput). */
function pinAt(p: Project, t: number, pin: { x: number; y: number }): { x: number; y: number } {
  const { scene, w, h } = sceneOf(p)
  const v = frameView(scene as never, w, h, p.width, p.height, t)
  const cam = punch.on ? { ...v.cam, scale: v.cam.scale * 1.1 } : v.cam
  return toOutput(v.layout.screen, cam)(pin.x, pin.y)
}

const apply = (m: M, x: number, y: number): { x: number; y: number } => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })
/** The calls without the canvases' own ids (a frame's cached layers are made afresh for each new target canvas). */
const stripped = (list: Call[]): unknown[] =>
  list.map(({ canvas: _c, args, ...rest }) => ({ ...rest, args: args.map((a) => (a && typeof a === 'object' && 'id' in a && 'width' in a ? { width: (a as unknown as { width: number }).width, height: (a as unknown as { height: number }).height } : a)) }))

let ids = 0
const text = (patch: Partial<Annotation> & Record<string, unknown> = {}): Annotation => ({ id: `t${++ids}`, start: 2, end: 8, text: 'Save it', x: 0.5, y: 0.4, size: 0.05, style: 'pill', ...patch }) as Annotation
const badge = (patch: Partial<Annotation> & Record<string, unknown> = {}): Annotation => text({ text: '', size: 0.045, style: 'badge', number: 'auto', ...patch })
const bubble = (patch: Partial<Annotation> & Record<string, unknown> = {}): Annotation => text({ text: 'Click here', size: 0.045, style: 'bubble', ...patch })
const shape = (kind: Shape['kind'], patch: Partial<Shape> = {}): Shape => ({ id: `s${++ids}`, kind, start: 2, end: 8, x: 0.2, y: 0.2, w: 0.3, h: 0.25, color: '#ff3b30', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5, ...patch })
const card = (patch: Partial<TitleCard> = {}): TitleCard => ({ id: `c${++ids}`, start: 4, end: 9, title: 'Chapter one', style: 'centered', background: 'solid', ...patch }) as TitleCard

/* ---------- test 37 ---------- */

describe('old texts, shapes and title cards (test 37)', () => {
  it('draw exactly as with the contracts stubs, and never reach the callout code', () => {
    const p = project({
      annotations: [text(), text({ style: 'title', x: 0.3, y: 0.7, text: 'Two\nlines' })],
      shapes: [shape('arrow'), shape('rect', { fill: true }), shape('ellipse'), shape('highlight', { color: '#ffe14d' }), shape('line'), shape('blur')],
      titles: [card(), card({ style: 'lower-third', start: 10, end: 14 })]
    })
    for (const t of [2.05, 2.1, 3, 4.1, 5, 7.95, 8.5, 10.1, 12, 13.9]) {
      stub.on = false
      // Once first, so the title cards' cached sprites exist for both drawings.
      frame(p, t)
      stub.calls = 0
      const real = digest(stripped(frame(p, t)))
      // drawAnnotations asks no badge or text with no new field; the shape and card layers ask nothing either.
      expect(stub.calls).toBe(0)
      stub.on = true
      const stubbed = digest(stripped(frame(p, t)))
      stub.on = false
      expect(real).toBe(stubbed)
    }
  })

  it('a text with a motion of its own is drawn by the callout code, with its pose', () => {
    const moving = text({ enter: { kind: 'rise', duration: 0.25, strength: 1 } })
    const p = project({ annotations: [moving] })
    const at = 2.1
    const list = frame(p, at)
    const fill = list.find((c) => c.name === 'fillText' && c.args[0] === 'Save it')!
    const pose = calloutPose(2, 8, at, p.clips, moving.enter, undefined, 0.05 * 1080, false, 0.15)!
    expect(fill.alpha).toBeCloseTo(pose.alpha, 9)
    // Moved down by the rise, about the box's centre at x, y.
    expect(fill.m[5]).toBeCloseTo(0.4 * 1080 + pose.dy, 6)
    stub.on = true
    const old = frame(p, at).find((c) => c.name === 'fillText' && c.args[0] === 'Save it')!
    stub.on = false
    expect(old.alpha).not.toBeCloseTo(pose.alpha, 3)
  })
})

/* ---------- test 38 ---------- */

describe('draw-on (test 38)', () => {
  const draw = { kind: 'draw' as const, duration: 0.35, strength: 1 }

  it("an arrow's shaft runs from the tail to tail + (tip − tail) · drawn, its head from drawn = 0.8", () => {
    const arrow = shape('arrow', { enter: draw, exit: { kind: 'fade', duration: 0.18, strength: 1 } })
    const p = project({ shapes: [arrow] })
    for (const p01 of [0.2, 0.5, 0.7, 0.9]) {
      const t = 2 + 0.35 * p01
      const drawn = EASE.out(p01)
      const list = frame(p, t)
      const i = list.findIndex((c) => c.name === 'moveTo')
      const from = apply(list[i].m, ...(list[i].args as [number, number]))
      const to = apply(list[i + 1].m, ...(list[i + 1].args as [number, number]))
      const a = pinAt(p, t, { x: arrow.x, y: arrow.y })
      const b = pinAt(p, t, { x: arrow.x + arrow.w, y: arrow.y + arrow.h })
      expect(from.x).toBeCloseTo(a.x, 4)
      expect(to.x).toBeCloseTo(a.x + (b.x - a.x) * drawn, 4)
      expect(to.y).toBeCloseTo(a.y + (b.y - a.y) * drawn, 4)
      const head = list.some((c) => c.name === 'closePath')
      expect(head).toBe(drawn >= 0.8)
    }
  })

  it("a rectangle's dash is [L · drawn, L] with L = 2(w + h); an ellipse's by Ramanujan", () => {
    const rect = shape('rect', { enter: { kind: 'draw', duration: 0.45, strength: 1 } })
    const ell = shape('ellipse', { enter: { kind: 'draw', duration: 0.45, strength: 1 }, start: 2, end: 8, x: 0.55, y: 0.5, w: 0.3, h: 0.2 })
    const p = project({ shapes: [rect, ell] })
    const t = 2 + 0.45 * 0.4
    const drawn = EASE.out(0.4)
    const dashes = frame(p, t).filter((c) => c.name === 'setLineDash').map((c) => c.args[0] as number[])
    const a = pinAt(p, t, { x: rect.x, y: rect.y })
    const b = pinAt(p, t, { x: rect.x + rect.w, y: rect.y + rect.h })
    const L = rectPerimeter(b.x - a.x, b.y - a.y)
    expect(dashes[0][0]).toBeCloseTo(L * drawn, 6)
    expect(dashes[0][1]).toBeCloseTo(L, 6)
    const ea = pinAt(p, t, { x: ell.x, y: ell.y })
    const eb = pinAt(p, t, { x: ell.x + ell.w, y: ell.y + ell.h })
    const E = ellipsePerimeter((eb.x - ea.x) / 2, (eb.y - ea.y) / 2)
    expect(dashes[1][0]).toBeCloseTo(E * drawn, 6)
    expect(dashes[1][1]).toBeCloseTo(E, 6)
    // The ellipse starts at half past ten, clockwise.
    const arc = frame(p, t).find((c) => c.name === 'ellipse')!
    expect(arc.args[5]).toBeCloseTo((-3 * Math.PI) / 4, 9)
  })

  it("a filled box reveals its fill left to right; a highlight's wipe is w · reveal wide", () => {
    const box = shape('rect', { fill: true, enter: { kind: 'draw', duration: 0.45, strength: 1 } })
    const mark = shape('highlight', { color: '#ffe14d', x: 0.5, y: 0.6, w: 0.3, h: 0.08, enter: { kind: 'wipe', duration: 0.28, strength: 1 } })
    const p = project({ shapes: [box, mark] })
    const t = 2.12
    const list = frame(p, t)
    const rects = list.filter((c) => c.name === 'rect').map((c) => c.args as number[])
    const a = pinAt(p, t, { x: box.x, y: box.y })
    const b = pinAt(p, t, { x: box.x + box.w, y: box.y + box.h })
    const fillShare = EASE.out(0.12 / 0.45)
    expect(rects.some((r) => Math.abs(r[2] - (b.x - a.x) * fillShare) < 1e-6 && Math.abs(r[0] - a.x) < 1e-6)).toBe(true)
    const ma = pinAt(p, t, { x: mark.x, y: mark.y })
    const mb = pinAt(p, t, { x: mark.x + mark.w, y: mark.y + mark.h })
    const reveal = EASE.emphDecel(0.12 / 0.28)
    expect(rects.some((r) => Math.abs(r[2] - (mb.x - ma.x) * reveal) < 1e-6 && Math.abs(r[0] - ma.x) < 1e-6)).toBe(true)
  })
})

/* ---------- test 39 ---------- */

describe('privacy shapes never move (test 39)', () => {
  it('a blur shape with enter in the file reads without it and covers fully from its first frame', () => {
    const raw = { ...shape('blur'), enter: { kind: 'fade', duration: 0.5, strength: 1 }, exit: { kind: 'pop', duration: 0.3, strength: 1 }, sound: 'sfx:soft-pop' }
    const read = migrateProject({ ...project(), shapes: [raw] } as unknown as Record<string, unknown>).shapes![0]
    expect(read.enter).toBeUndefined()
    expect(read.exit).toBeUndefined()
    expect(read.sound).toBeUndefined()
    // Drawn from the file as it is (enter and all), the blur is the same as without the motion at its very first frame.
    const plain = project({ shapes: [shape('blur', { id: 'b' })] })
    const moving = project({ shapes: [{ ...shape('blur', { id: 'b' }), enter: { kind: 'fade', duration: 0.5, strength: 1 } }] })
    for (const t of [2, 2.05, 2.25]) expect(digest(stripped(frame(moving, t)))).toBe(digest(stripped(frame(plain, t))))
    expect(layer.shapeCalloutPose({ toOut: (x: number, y: number) => ({ x, y }), t: 2, project: moving } as never, moving.shapes![0])).toBeNull()
  })
})

/* ---------- badges, bubbles and their boxes (tests 41, 42) ---------- */

const fillTexts = (list: Call[]): Call[] => list.filter((c) => c.name === 'fillText')
/** The rounded rectangles filled with `color` (a badge's circle or pill): the roundRect before each such fill. */
function filledRects(list: Call[], color: string): Call[] {
  const out: Call[] = []
  list.forEach((c, i) => {
    if (c.name !== 'fill' || c.fill !== color) return
    for (let k = i - 1; k >= 0; k--)
      if (list[k].name === 'roundRect') {
        out.push(list[k])
        break
      }
  })
  return out
}

describe('speech bubbles drawn (test 41)', () => {
  it('Arabic text is right to left and right-aligned; Latin is left to right', () => {
    const p = project({ annotations: [bubble({ text: 'انقر هنا للحفظ', x: 0.3 }), bubble({ text: 'Click here', x: 0.7 })] })
    const list = fillTexts(frame(p, 5))
    const ar = list.find((c) => c.args[0] === 'انقر هنا للحفظ')!
    const en = list.find((c) => c.args[0] === 'Click here')!
    expect(ar.direction).toBe('rtl')
    expect(ar.align).toBe('right')
    expect(en.direction).toBe('ltr')
    expect(en.align).toBe('left')
  })

  it('a white or light fill gets the thin outline, a dark one does not', () => {
    const outlines = (color: string | undefined): number => {
      const p = project({ annotations: [bubble({ color })] })
      return frame(p, 5).filter((c) => c.name === 'stroke' && c.stroke === 'rgba(0, 0, 0, 0.15)').length
    }
    expect(outlines(undefined)).toBe(1)
    expect(outlines('#f6f6f9')).toBe(1)
    expect(outlines('#1d1d24')).toBe(0)
  })

  it('wraps a long text inside the body; dark text on white, white on dark', () => {
    const long = 'Open the File menu and choose Export to save your video, then pick a folder and press Save to finish'
    const p = project({ annotations: [bubble({ text: long }), bubble({ text: 'Dark', color: '#1d1d24', y: 0.8 })] })
    const list = fillTexts(frame(p, 5))
    const lines = list.filter((c) => c.args[0] !== 'Dark')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.map((c) => c.args[0]).join(' ')).toBe(long)
    expect(lines.every((c) => c.fill === '#111111')).toBe(true)
    expect(list.find((c) => c.args[0] === 'Dark')!.fill).toBe('#ffffff')
  })
})

/** The frame calloutPlace is given for project `p` at `t`, as the compositor builds it. */
function frameOf(p: Project, t: number): Parameters<typeof calloutPlace>[2] {
  const { scene, w, h } = sceneOf(p)
  const v = frameView(scene as never, w, h, p.width, p.height, t)
  const cam = punch.on ? { ...v.cam, scale: v.cam.scale * 1.1 } : v.cam
  return layer.calloutFrame({ w, h, t, rect: v.layout.screen, cam, layout: v.layout, project: v.project, textArea: null, scene, toOut: toOutput(v.layout.screen, cam) })
}
const measure = (s: string, px: number): number => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length * 10 * (px / px)

describe('annotationMetrics and calloutPlace are the drawn boxes (test 42)', () => {
  it('badges: metrics, and the circle and pill where they are drawn, pinned or not', () => {
    const m = annotationMetrics({ size: 0.045, style: 'badge' }, 1920, 1080)
    expect(m.px).toBeCloseTo(48.6, 9)
    expect(m.weight).toBe(700)
    expect(m.px + 2 * m.padY).toBeCloseTo(1.75 * m.px, 9)
    const pinned = badge({ id: 'one', pin: { x: 0.3, y: 0.6 } })
    const free = badge({ id: 'two', start: 3, x: 0.8, y: 0.2 })
    const own = badge({ id: 'own', number: undefined, text: 'Go!', x: 0.5, y: 0.8 })
    const zoom: ZoomSegment = { id: 'z', start: 1, end: 9, scale: 2, focus: { mode: 'fixed', x: 0.35, y: 0.55 }, auto: false }
    const p = project({ annotations: [pinned, free, own], zooms: [zoom] })
    const t = 5
    const drawn = filledRects(frame(p, t), '#0060df')
    const labels = badgeLabels(p)
    for (const a of [pinned, free, own]) {
      const place = calloutPlace(a, labels.get(a.id) ?? null, frameOf(p, t), (s) => measure(s, 1))!
      const r = drawn.find((c) => Math.abs((c.args[0] as number) - place.box.x) < 1e-6 && Math.abs((c.args[1] as number) - place.box.y) < 1e-6)
      expect(r, a.id).toBeDefined()
      expect(r!.args[2]).toBeCloseTo(place.box.w, 9)
      expect(r!.args[3]).toBeCloseTo(place.box.h, 9)
    }
    // The pinned badge is centred on its pin through the zoom.
    const at = pinAt(p, t, pinned.pin!)
    const place = calloutPlace(pinned, '1', frameOf(p, t), (s) => measure(s, 1))!
    expect(place.box.x + place.box.w / 2).toBeCloseTo(at.x, 6)
    expect(place.box.y + place.box.h / 2).toBeCloseTo(at.y, 6)
  })

  it('bubbles: metrics, and the body (with its tail) where it is drawn', () => {
    const m = annotationMetrics({ size: 0.045, style: 'bubble', text: 'সেভ করুন' }, 1920, 1080)
    expect(m.lineHeight).toBeCloseTo(1.4 * 48.6, 9)
    expect(m.padX / m.px).toBeCloseTo(0.7, 12)
    expect(m.padY / m.px).toBeCloseTo(0.45, 12)
    expect(m.weight).toBe(600)
    const pinned = bubble({ id: 'b1', pin: { x: 0.4, y: 0.6 }, body: { dx: 0.12, dy: -0.1 } })
    const free = bubble({ id: 'b2', x: 0.75, y: 0.25, text: 'No tail' })
    const p = project({ annotations: [pinned, free] })
    const list = frame(p, 5)
    const place = calloutPlace(pinned, null, frameOf(p, 5), (s) => measure(s, 1))!
    expect(place.tail).not.toBeNull()
    // The contour: moveTo at the top-left corner's end, the tail's tip among its points.
    const move = list.find((c) => c.name === 'moveTo' && Math.abs((c.args[0] as number) - (place.box.x + place.radius)) < 1e-6)!
    expect(move.args[1]).toBeCloseTo(place.box.y, 9)
    expect(list.some((c) => c.name === 'lineTo' && Math.abs((c.args[0] as number) - place.tail!.tip.x) < 1e-6 && Math.abs((c.args[1] as number) - place.tail!.tip.y) < 1e-6)).toBe(true)
    const freePlace = calloutPlace(free, null, frameOf(p, 5), (s) => measure(s, 1))!
    const r = list.find((c) => c.name === 'roundRect' && Math.abs((c.args[0] as number) - freePlace.box.x) < 1e-6)!
    expect(r.args.slice(1, 4)).toEqual([freePlace.box.y, freePlace.box.w, freePlace.box.h])
  })
})

/* ---------- test 43 ---------- */

describe('title cards with a motion (test 43)', () => {
  it("the background keeps titlePhase's opacity; the text takes the pose", () => {
    const moving = card({ enter: { kind: 'rise', duration: 0.35, strength: 1 }, exit: { kind: 'fade', duration: 0.35, strength: 1 } })
    const p = project({ titles: [moving] })
    for (const t of [4.05, 4.15, 4.3, 6, 8.8]) {
      const list = frame(p, t)
      const phase = titlePhase(moving, t, p.clips)!
      const pose = titleMotionPose(moving, t, p.clips, titleEm(moving, 1920, 1080), false)!
      // The solid background: a fill at the phase's opacity.
      const bg = list.filter((c) => (c.name === 'fillRect' || c.name === 'fill') && typeof c.alpha === 'number' && Math.abs((c.alpha as number) - phase.background) < 1e-9)
      expect(bg.length, `background at ${t}`).toBeGreaterThan(0)
      // The text: its sprite at the pose's opacity, moved by the pose.
      // (The last image drawn: the card's text sprite, over the frame's cached layers.)
      const sprite = list.filter((c) => c.name === 'drawImage').at(-1)!
      expect(sprite.alpha).toBeCloseTo(pose.alpha, 9)
      if (Math.abs(pose.alpha - phase.text) > 1e-3) expect(sprite.alpha).not.toBeCloseTo(phase.text, 3)
    }
  })
})

/* ---------- test 44 ---------- */

describe("Captions Studio's Speech Bubble look (test 44)", () => {
  it('draws the same calls with bubblePath moved to its own file', () => {
    const words = (id: string, start: number, s: string): CaptionSegment => ({
      id,
      start,
      end: start + s.split(' ').length * 0.4,
      text: s,
      words: s.split(' ').map((w, i) => ({ text: w, start: start + i * 0.4, end: start + i * 0.4 + 0.35 }))
    })
    const p = project({
      transcript: { language: 'en', provider: 'local', model: 'speech-small', createdAt: '2026-11-01T09:00:00.000Z', segments: [words('k1', 2, 'Click the Save button now'), words('k2', 6, 'Then open the Export dialog')] },
      captions: { ...DEFAULT_CAPTIONS, show: true, studio: studioPreset('bubble-speech')!.look }
    } as Partial<Project>)
    const logs = [2.2, 3, 4.1, 6.5, 7.9].map((t) => frameAll(p, t))
    // The bubble and its tail were drawn.
    expect(logs.some((l) => l.some((c) => c.name === 'roundRect') && l.some((c) => c.name === 'closePath'))).toBe(true)
    // Pinned against the drawing before the move (d746e5e).
    expect(digest(logs.map(stripped))).toBe(SPEECH_BUBBLE)
  })
})
/** The digest of those calls drawn by d746e5e's studioLayer.ts, before bubblePath moved. */
const SPEECH_BUBBLE = 'f41b0a26ab9d6fb48445a70df0e60633'

/* ---------- test 78 ---------- */

describe('pins (test 78)', () => {
  const zooms: ZoomSegment[] = [{ id: 'z', start: 3, end: 9, scale: 2.2, focus: { mode: 'fixed', x: 0.62, y: 0.38 }, transition: 1.2, auto: false }]

  it('a pinned badge is drawn at toOut(pin) on every frame of a moving zoom, and of a punch-in', () => {
    const pinned = badge({ id: 'pin', start: 2, end: 10, pin: { x: 0.6, y: 0.4 }, x: 0.6, y: 0.4 })
    const p = project({ annotations: [pinned], zooms })
    for (const on of [false, true]) {
      punch.on = on
      for (const t of [2.5, 3.1, 3.4, 3.8, 4.2, 6, 8.3, 8.8]) {
        const at = pinAt(p, t, pinned.pin!)
        const r = filledRects(frame(p, t), '#0060df')[0]
        const centre = apply(r.m, (r.args[0] as number) + (r.args[2] as number) / 2, (r.args[1] as number) + (r.args[3] as number) / 2)
        expect(centre.x, `${on} ${t}`).toBeCloseTo(at.x, 4)
        expect(centre.y, `${on} ${t}`).toBeCloseTo(at.y, 4)
      }
    }
    punch.on = false
  })

  it('is not drawn while the pin is outside the card', () => {
    const away = badge({ id: 'away', start: 2, end: 10, pin: { x: 0.05, y: 0.9 } })
    const p = project({ annotations: [away], zooms })
    expect(filledRects(frame(p, 2.5), '#0060df')).toHaveLength(1)
    // Zoomed in on the top right, the bottom-left corner is out of the picture.
    expect(filledRects(frame(p, 6), '#0060df')).toHaveLength(0)
  })

  it("a bubble's body stays inside the text area and its tail is left out while the tip is outside", () => {
    const b = bubble({ id: 'tip', start: 2, end: 10, pin: { x: 0.05, y: 0.9 }, body: { dx: 0.12, dy: -0.1 } })
    const p = project({ annotations: [b], zooms })
    const shown = calloutPlace(b, null, frameOf(p, 2.5), (s) => measure(s, 1))!
    expect(shown.tail).not.toBeNull()
    const hidden = calloutPlace(b, null, frameOf(p, 6), (s) => measure(s, 1))!
    expect(hidden.tail).toBeNull()
    expect(hidden.box.x).toBeGreaterThanOrEqual(0)
    expect(hidden.box.y).toBeGreaterThanOrEqual(0)
    expect(hidden.box.x + hidden.box.w).toBeLessThanOrEqual(1920)
    expect(hidden.box.y + hidden.box.h).toBeLessThanOrEqual(1080)
    // Drawn without the tail: a plain rounded body.
    const body = filledRects(frame(p, 6), '#ffffff')
    expect(body).toHaveLength(1)
    expect(body[0].args.slice(0, 4)).toEqual([hidden.box.x, hidden.box.y, hidden.box.w, hidden.box.h])
  })

  it('Follows the zoom off (no pin): the badge stays at x, y through the zoom', () => {
    const still = badge({ id: 'still', start: 2, end: 10, x: 0.25, y: 0.75 })
    const p = project({ annotations: [still], zooms })
    for (const t of [2.5, 3.5, 6]) {
      const r = filledRects(frame(p, t), '#0060df')[0]
      const centre = apply(r.m, (r.args[0] as number) + (r.args[2] as number) / 2, (r.args[1] as number) + (r.args[3] as number) / 2)
      expect(centre.x).toBeCloseTo(0.25 * 1920, 6)
      expect(centre.y).toBeCloseTo(0.75 * 1080, 6)
    }
  })
})
