import { describe, expect, it, vi } from 'vitest'
import type { Rect, SceneLayout, SceneProject } from '../src/shared/engine/layout'
import type { Camera } from '../src/shared/engine/zoom'
import type { CaptionSettings, ClickEvent, CursorTrack, Project, ReframeSettings, Shape } from '../src/shared/types'
import { digest, sceneFixtures, seededTimes, type SceneFixture } from './verticalFixtures'

/*
 * Drawing a frame that follows the action (docs/design/vertical-video.md §5.2, §6, §8; tests 47
 * to 50), on canvases that record their calls (as tests/compositorCrop.test.ts). The compositor
 * gets the drawn project, the layout and the camera from frameView.ts, which part P1 writes: here
 * it is stood in for (vi.mock), as §9.2 says, by
 *  - for a frame that does not follow: today's sceneLayout and cameraAt, exactly (the reference
 *    of test 41), so the call logs of the equivalence guard come out again;
 *  - for a frame that follows: a hand-made layout of §5.2 (the padded frame as the slot, the base
 *    view and the virtual rectangle) and a camera this file sets per test (`follow` below).
 * layout.ts's intersectRect, bandSide and followGeometry (also P1) are stood in for the same way.
 */

const follow = vi.hoisted(() => ({
  /** Where the view is at source time t, for the frame at `at` (the compositor's sub-frames pass the frame's own time). */
  centre: (_t: number, _at: number | undefined): { x: number; y: number } => ({ x: 0.3, y: 0.5 }),
  /** The zoom scale of the view at t (relative to it). */
  scale: (_t: number): number => 1,
  /** followGain while following. */
  gain: 1.904,
  /** Whether the slot is moving (a layout change while following). */
  moving: false,
  /** Every (t, at) the follow camera was asked for. */
  asked: [] as { t: number; at: number | undefined }[]
}))

vi.mock('../src/shared/engine/layout', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/engine/layout')>()
  const padded = (p: SceneProject, w: number, h: number): Rect => {
    const pad = Math.min(w, h) * p.style.padding
    return { x: pad, y: pad, w: w - pad * 2, h: h - pad * 2 }
  }
  return {
    ...real,
    intersectRect: (a: Rect, b: Rect): Rect => {
      const x = Math.max(a.x, b.x)
      const y = Math.max(a.y, b.y)
      const w = Math.min(a.x + a.w, b.x + b.w) - x
      const h = Math.min(a.y + a.h, b.y + b.h) - y
      return w > 0 && h > 0 ? { x, y, w, h } : { x, y, w: 0, h: 0 }
    },
    // No camera bands in this file: the camera, if any, is a bubble over the padded frame.
    bandSide: () => null,
    followGeometry: (_l: unknown, p: SceneProject, w: number, h: number) => ({ slot: padded(p, w, h), camera: { rect: real.webcamRect(w, h, p.webcam), radius: 0, opacity: 1 }, band: null })
  }
})

vi.mock('../src/shared/engine/frameView', async () => {
  const { sceneLayout } = await import('../src/shared/engine/layout')
  const { cameraAt, zoomStyleOf } = await import('../src/shared/engine/zoom')
  const { followApplies } = await import('../src/shared/engine/reframeData')
  type Scene = { project: Project; cursor: CursorTrack; focusPath: { at(t: number): { x: number; y: number } } }
  const drawn = new WeakMap<Project, Project>()
  const drawnForFrame = (p: Project, w: number, h: number, vw: number, vh: number): Project => {
    if (!followApplies(p, w, h, vw, vh)) return p
    let d = drawn.get(p)
    if (!d) {
      const { frame: _frame, ...style } = p.style
      const { tilt: _tilt, ...rest } = p
      d = { ...rest, style }
      drawn.set(p, d)
    }
    return d
  }
  /** §5.2: the padded frame as the slot, the base view at level 1 and the slot enlarged by 1 / base. */
  const followLayout = (p: Project, w: number, h: number, vw: number, vh: number): SceneLayout => {
    const pad = Math.min(w, h) * p.style.padding
    const slot = { x: pad, y: pad, w: w - pad * 2, h: h - pad * 2 }
    const as = slot.w / slot.h
    const av = vw / vh
    const base = { w: Math.min(1, as / av), h: Math.min(1, av / as) }
    const screen = { x: slot.x + slot.w / 2 - slot.w / (2 * base.w), y: slot.y + slot.h / 2 - slot.h / (2 * base.h), w: slot.w / base.w, h: slot.h / base.h }
    return { screen, camera: null, moving: follow.moving, follow: { slot, base, band: null } }
  }
  const frameCamera = (scene: Scene, layout: SceneLayout, t: number, at?: number): Camera => {
    if (!layout.follow) return cameraAt(scene.project.zooms, t, scene.cursor.valid ? scene.focusPath : null, zoomStyleOf(scene.project))
    follow.asked.push({ t, at })
    const c = follow.centre(t, at)
    return { scale: follow.scale(t), cx: c.x, cy: c.y }
  }
  return {
    drawnForFrame,
    frameCamera,
    frameView: (scene: Scene, w: number, h: number, vw: number, vh: number, t: number, at?: number) => {
      const project = drawnForFrame(scene.project, w, h, vw, vh)
      const layout = project === scene.project ? sceneLayout(project, w, h, vw, vh, t) : followLayout(project, w, h, vw, vh)
      return { project, layout, cam: frameCamera(scene, layout, t, at) }
    },
    followGain: (layout: SceneLayout) => (layout.follow ? follow.gain : 1),
    narrowBoxZoom: (zoom: number, boxAspect: number) => Math.max(1, zoom * Math.min(1, boxAspect)),
    viewMagnification: () => null
  }
})

/* ---------- canvases that record their calls (as tests/verticalEquivalence.test.ts) ---------- */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  quality: unknown
  smoothing: unknown
  alpha: unknown
}
const calls: Call[] = []
let canvases = 0

function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id }
  const state: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      return (...args: unknown[]) =>
        void calls.push({ canvas: id, name: String(prop), args, quality: target.imageSmoothingQuality, smoothing: target.imageSmoothingEnabled, alpha: target.globalAlpha })
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
const { focusPathFor } = await import('../src/shared/engine/zoom')
const { createProject } = await import('../src/shared/engine/project')
const { DEFAULT_REFRAME, readReframe } = await import('../src/shared/engine/reframeData')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { blurSampleCount, cameraDisplacement } = await import('../src/shared/render/overlays')
const { COMMON_SAFE, TEXT_INSET } = await import('../src/shared/render/safeZones')

type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number; frameInterval?: number }, soundTime?: number) => void
type ViewSource = (c: Camera, rect: Rect, clip?: Rect) => { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } | null
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame, viewSource } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame; viewSource: ViewSource }

/* ---------- 9:16 frames of a 1920 x 1080 recording ---------- */

const W = 1080
const H = 1920
const VW = 1920
const VH = 1080
const FRAME = { tag: 'screen frame' }
/** The slot at padding 0 is the frame; the base view is 9/16 of 9/16 of the recording's width. */
const SLOT: Rect = { x: 0, y: 0, w: W, h: H }
const BASE_W = 0.31640625
const VIRTUAL: Rect = { x: W / 2 - W / (2 * BASE_W), y: 0, w: W / BASE_W, h: H }

/** A 9:16 project of a 1920 x 1080 recording that follows (`reframe` null: one from before following). */
function project(reframe: Partial<ReframeSettings> | null = {}, extra: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 12,
    width: VW,
    height: VH,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' }
  })
  p.cursor.hideWhenIdle = false
  p.effects.motionBlur = 0
  return {
    ...p,
    style: { ...p.style, aspectRatio: '9:16', padding: 0, cornerRadius: 24, shadow: 0.4 },
    ...(reframe ? { reframe: { ...DEFAULT_REFRAME, appSafe: false, ...reframe } } : {}),
    ...extra
  }
}

const still = (clicks: ClickEvent[] = []): CursorTrack => ({ samples: [{ t: 0, x: 0.3, y: 0.5 }, { t: 12, x: 0.3, y: 0.5 }], clicks, keys: [], shapes: [], scale: 1, valid: true })

interface Drawn {
  /** Calls on the frame's own canvas. */
  mine: Call[]
  /** Calls on every canvas. */
  all: Call[]
}

/** Draws `p` at t on a fresh recording canvas (w x h), the screen decoded unless `decoded` is false. */
function draw(p: Project, t: number, opts: { cursor?: CursorTrack; w?: number; h?: number; options?: { blurSamples?: number; frameInterval?: number }; soundTime?: number; decoded?: boolean; webcam?: boolean } = {}): Drawn {
  const cursor = opts.cursor ?? still()
  const view = cropView(p, cursor)
  const path = new SmoothedTrack(view.cursor.samples, p.duration, 0)
  const scene = { project: view.project, cursor: view.cursor, cursorPath: path, focusPath: path }
  const target = canvas()
  const ctx = (target.getContext as (t: string) => unknown)('2d')
  const decoded = opts.decoded !== false
  const webcam = opts.webcam ? { readyState: 4, videoWidth: 1280, videoHeight: 720 } : null
  const src = {
    screen: decoded ? { readyState: 4, videoWidth: VW, videoHeight: VH } : { readyState: 0, videoWidth: 0, videoHeight: 0 },
    webcam,
    background: null,
    ...(decoded ? { screenFrame: { image: FRAME, width: VW, height: VH } } : {}),
    ...(webcam ? { webcamFrame: { image: { tag: 'camera frame' }, width: 1280, height: 720 } } : {})
  }
  calls.length = 0
  drawFrame(ctx, opts.w ?? W, opts.h ?? H, t, scene, src, opts.options ?? { blurSamples: 1 }, opts.soundTime)
  const all = calls.slice()
  return { all, mine: all.filter((c) => c.canvas === target.id) }
}

/** The screen's draws on the frame's canvas: from the decoded frame, or from its RGB copy for motion blur (a canvas the whole frame was copied onto). */
function screenDraws(d: Drawn): number[][] {
  const copies = new Set(d.all.filter((c) => c.name === 'drawImage' && c.args[0] === FRAME && c.args.length === 5).map((c) => c.canvas))
  const fromScreen = (src: unknown): boolean => src === FRAME || (!!src && typeof src === 'object' && copies.has((src as { id?: number }).id ?? -1))
  return d.mine.filter((c) => c.name === 'drawImage' && c.args.length === 9 && fromScreen(c.args[0])).map((c) => c.args.slice(1) as number[])
}
/** The card's clip path: the rounded rectangle just before the first clip on the frame's canvas, and its corner radii. */
function clipPath(d: Drawn): { rect: Rect; radii: unknown } {
  const i = d.mine.findIndex((c) => c.name === 'clip')
  const r = d.mine.slice(0, i).reverse().find((c) => c.name === 'roundRect')!.args as number[]
  return { rect: { x: r[0], y: r[1], w: r[2], h: r[3] }, radii: r[4] }
}
const clipRect = (d: Drawn): Rect => clipPath(d).rect
/** The calls with their canvases told apart by first use only, as JSON. */
const strip = (log: Call[]): string[] => {
  const order = new Map<number, number>()
  return log.map((c) => {
    if (!order.has(c.canvas)) order.set(c.canvas, order.size)
    return JSON.stringify([order.get(c.canvas), c.name, c.args, c.quality, c.smoothing, c.alpha], (_k, v: unknown) => (v && typeof v === 'object' && 'getContext' in v ? 'canvas' : v))
  })
}
const expectRect = (r: Rect, e: Rect, digits = 6): void => {
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(r[k], k).toBeCloseTo(e[k], digits)
}

function reset(): void {
  follow.centre = () => ({ x: 0.3, y: 0.5 })
  follow.scale = () => 1
  follow.gain = 1.904
  follow.moving = false
  follow.asked.length = 0
}

describe('drawing a followed 9:16 frame (test 47)', () => {
  it('draws the screen into the slot from a source base.w x vw wide around the planned centre, clipped to the slot', () => {
    reset()
    const d = draw(project(), 2)
    const draws = screenDraws(d)
    expect(draws).toHaveLength(1)
    const [sx, sy, sw, sh, dx, dy, dw, dh] = draws[0]
    expect(Math.abs(sw - BASE_W * VW)).toBeLessThanOrEqual(1)
    expect((sx + sw / 2) / VW).toBeCloseTo(0.3, 9)
    expect(sy).toBeCloseTo(0, 9)
    expect(sh).toBeCloseTo(VH, 9)
    // Exactly the slot: no pixel is drawn (or sampled) outside it.
    expectRect({ x: dx, y: dy, w: dw, h: dh }, SLOT)
    expectRect(clipRect(d), SLOT)
    // What viewSource gives for the virtual rectangle clipped to the slot.
    const v = viewSource({ scale: 1, cx: 0.3, cy: 0.5 }, VIRTUAL, SLOT)!
    expect([v.sx * VW, v.sy * VH, v.sw * VW, v.sh * VH, v.dx, v.dy, v.dw, v.dh]).toEqual(draws[0])
  })

  it('draws no device frame and no 3D tilt while following: the calls of the same project without them', () => {
    reset()
    const plain = project()
    const dressed = project({}, { style: { ...plain.style, frame: { kind: 'browser', theme: 'dark', title: 'flown.app' } }, tilt: { enabled: true, rotateX: 12, rotateY: -18, perspective: 0.6, animate: 'none' } })
    const a = draw(plain, 2)
    const b = draw(dressed, 2)
    expect(strip(b.all)).toEqual(strip(a.all))
    // Not following (a 16:9 frame), the same project draws its frame and tilt.
    const wide = draw(dressed, 2, { w: 1920, h: 1080 })
    expect(strip(wide.all)).not.toEqual(strip(draw(plain, 2, { w: 1920, h: 1080 }).all))
  })

  it('keeps the screen inside the slot when zoomed in, and the card the slot itself', () => {
    reset()
    follow.scale = () => 1.4
    follow.centre = () => ({ x: 0.8, y: 0.4 })
    const d = draw(project({ appSafe: false }, { style: { ...project().style, padding: 0.07 } }), 2)
    const pad = 0.07 * W
    const slot = { x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad }
    expectRect(clipRect(d), slot)
    const [, , sw, , dx, dy, dw, dh] = screenDraws(d)[0]
    expectRect({ x: dx, y: dy, w: dw, h: dh }, slot)
    // 1.4x of a view of the slot's shape: 1/1.4 of the base view's width.
    const baseW = Math.min(1, slot.w / slot.h / (VW / VH))
    expect(sw).toBeCloseTo((baseW * VW) / 1.4, 6)
  })
})

/* ---------- test 47: old projects, mode 'fit' and 16:9 frames draw exactly as before ---------- */

/** The digests pinned by the equivalence guard (tests/verticalEquivalence.test.ts, test 47). */
const PINNED: Record<string, string> = {
  'tall-fitted': '8f051e9fb1148e2ec7d5560d8309c4f3',
  'wide-auto': 'f056572fcb8cdbfab15699ad41017b9c',
  'square-fitted': '58c0c7d92912c77ad44a0830e04410f5',
  'tall-layouts': 'f03526935a9ace920a864e1274d4ee48'
}
const SCENES = ['tall-fitted', 'wide-auto', 'square-fitted', 'tall-layouts']

/** The equivalence guard's dressing of a fixture: a caption, text, logo, lower third, shapes, a spotlight and key presses. */
function dressed(f: SceneFixture): Project {
  const p = f.project
  return {
    ...p,
    annotations: [{ id: 'a1', start: 1, end: 9, text: 'Open the billing page', x: 0.5, y: 0.85, size: 0.05, style: 'pill' }],
    shapes: [
      { id: 's1', start: 2, end: 12, kind: 'arrow', x: 0.3, y: 0.3, w: 0.2, h: -0.1, color: '#ef4444', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 },
      { id: 's2', start: 0, end: 30, kind: 'blur', x: 0.6, y: 0.1, w: 0.2, h: 0.1, color: '#000000', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }
    ],
    spotlights: [{ id: 'l1', start: 14, end: 19, mode: 'region', x: 0.2, y: 0.2, w: 0.3, h: 0.2, shape: 'rect', dim: 0.6, feather: 0.3 }],
    titles: [{ id: 't1', start: 0, end: 4, title: 'Billing demo', subtitle: 'Qbexel', style: 'lower-third', background: 'blur' }],
    watermark: { show: true, kind: 'text', text: 'qbexel.com', position: 'bottom-right', size: 0.03, opacity: 0.8, margin: 0.03 },
    transcript: {
      provider: 'local',
      model: 'speech-small',
      createdAt: '2026-10-12T10:20:00.000Z',
      segments: [
        { id: 'k1', start: 1, end: 5, text: 'Here is the billing page, with every invoice of the month.' },
        { id: 'k2', start: 12, end: 17, text: 'Invoices are listed by month.' }
      ]
    },
    captions: { ...DEFAULT_CAPTIONS, preset: 'boxed', background: 'box' },
    cursor: { ...p.cursor, hideWhenIdle: false }
  }
}

/** The equivalence guard's call log of fixture `name` (with `reframe` added), on a fresh compositor whose caches have seen `before`. */
async function guardDigest(name: string, reframe: ReframeSettings | undefined, before: string[] = []): Promise<string> {
  vi.resetModules()
  const fresh = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }
  const fixtures = sceneFixtures()
  let out = ''
  for (const n of [...before, name]) {
    const f = fixtures.find((x) => x.name === n)!
    const plain = dressed(f)
    const p: Project = n === name && reframe ? { ...plain, reframe } : plain
    const view = cropView(p, f.track)
    const scene = {
      project: view.project,
      cursor: view.cursor,
      cursorPath: new SmoothedTrack(view.cursor.samples, p.duration, p.cursor.smoothing),
      focusPath: focusPathFor(view.cursor.samples, p.duration),
      ...(view.crop ? { crop: view.crop } : {})
    }
    const webcam = p.hasWebcam ? { readyState: 4, videoWidth: 1280, videoHeight: 720 } : null
    const src = {
      screen: { readyState: 4, videoWidth: f.project.width, videoHeight: f.project.height },
      webcam,
      background: null,
      screenFrame: { image: { tag: 'screen frame' }, width: f.project.width, height: f.project.height },
      ...(webcam ? { webcamFrame: { image: { tag: 'camera frame' }, width: 1280, height: 720 } } : {})
    }
    const logs: string[] = []
    for (const [i, t] of seededTimes(4700 + SCENES.indexOf(n), 16, 30).entries()) {
      const c = canvas()
      calls.length = 0
      fresh.drawFrame((c.getContext as (t: string) => unknown)('2d'), f.w, f.h, t, scene, src, i % 4 === 3 ? { blurSamples: 10, frameInterval: 1 / 30 } : { blurSamples: 4 })
      logs.push(digest(guardStrip(calls)))
    }
    out = digest(logs)
  }
  return out
}

/** As the equivalence guard strips a log (canvases numbered by first use, canvas arguments named). */
function guardStrip(log: Call[]): unknown[] {
  const order = new Map<number, number>()
  const local = (id: number): number => {
    if (!order.has(id)) order.set(id, order.size)
    return order.get(id)!
  }
  return log.map((c) => ({
    on: local(c.canvas),
    name: c.name,
    args: JSON.stringify(c.args, (_k, v: unknown) => (v && typeof v === 'object' && 'getContext' in v ? `canvas${local((v as unknown as { id: number }).id)}` : v)),
    quality: c.quality,
    smoothing: c.smoothing,
    alpha: c.alpha
  }))
}

describe('frames that do not follow draw exactly as before (test 47)', () => {
  it('without reframe: the pinned call logs of the four fitted scenes', async () => {
    reset()
    for (const [i, name] of SCENES.entries()) expect(await guardDigest(name, undefined, SCENES.slice(0, i)), name).toBe(PINNED[name])
    expect(follow.asked).toHaveLength(0)
  })

  it("reframe { mode: 'fit' }: exactly the call logs of no reframe", async () => {
    reset()
    const fit = readReframe({ mode: 'fit' })!
    expect(fit.mode).toBe('fit')
    for (const [i, name] of SCENES.entries()) expect(await guardDigest(name, fit, SCENES.slice(0, i)), name).toBe(PINNED[name])
    expect(follow.asked).toHaveLength(0)
  })

  it("a 16:9 frame with mode 'follow' (and appSafe on): exactly the call log of no reframe", async () => {
    reset()
    expect(await guardDigest('wide-auto', { ...DEFAULT_REFRAME }, ['tall-fitted'])).toBe(PINNED['wide-auto'])
    expect(follow.asked).toHaveLength(0)
  })
})

/* ---------- test 48: motion blur while the view pans ---------- */

describe('motion blur while following (test 48)', () => {
  const blur = { blurSamples: 4, frameInterval: 1 / 60 }

  it('draws several sub-frames during a pan without zooms; not following and without zooms, one', () => {
    reset()
    // A pan of half the recording per second.
    follow.centre = (t) => ({ x: 0.2 + 0.5 * (t - 1), y: 0.5 })
    const moving = project({}, { effects: { ...project().effects, motionBlur: 1 } })
    const d = draw(moving, 1.5, { options: blur })
    expect(screenDraws(d).length).toBe(4)
    // Each sub-frame shows a different place, sampled within the frame's shutter.
    const centres = screenDraws(d).map((a) => (a[0] + a[2] / 2) / VW)
    expect(new Set(centres.map((c) => c.toFixed(6))).size).toBe(4)
    const fit = draw({ ...moving, reframe: { ...moving.reframe!, mode: 'fit' } }, 1.5, { options: blur })
    expect(screenDraws(fit)).toHaveLength(1)
    // Following but holding still: one.
    follow.centre = () => ({ x: 0.4, y: 0.5 })
    expect(screenDraws(draw(moving, 1.5, { options: blur }))).toHaveLength(1)
  })

  it("counts the sub-frames from the slot's corners, not the virtual rectangle's", () => {
    reset()
    // A zoom ramp about a still centre: the virtual rectangle's corners (3.2 slots wide) move far more than the slot's.
    follow.centre = () => ({ x: 0.5, y: 0.5 })
    follow.scale = (t) => 1 + 0.3 * t
    const options = { blurSamples: 10, frameInterval: 1 / 30 }
    const p = project({}, { effects: { ...project().effects, motionBlur: 1 } })
    const t = 1
    const shutter = 1 / 30
    const a = { scale: follow.scale(t - shutter / 2), cx: 0.5, cy: 0.5 }
    const b = { scale: follow.scale(t + shutter / 2), cx: 0.5, cy: 0.5 }
    const atSlot = blurSampleCount(cameraDisplacement(a, b, VIRTUAL, SLOT), 10)
    const atRect = blurSampleCount(cameraDisplacement(a, b, VIRTUAL), 10)
    expect(atSlot).toBeGreaterThan(1)
    expect(atRect).toBeGreaterThan(atSlot)
    expect(screenDraws(draw(p, t, { options }))).toHaveLength(atSlot)
  })

  it('reads every sub-frame of a frame whose shutter crosses a cut from its own clip (at = t)', () => {
    reset()
    // Clips 0-5 s and 8-12 s: the view pans in the first (up to 0.45 at its end) and is at 0.8 in the second,
    // the clip chosen by the frame's own time (§5.4).
    follow.centre = (t, at) => ({ x: (at ?? t) < 5 ? 0.2 + 0.05 * Math.min(t, 5) : 0.8, y: 0.5 })
    const p = project({}, { clips: [{ id: 'a', start: 0, end: 5, speed: 1 }, { id: 'b', start: 8, end: 12, speed: 1 }], effects: { ...project().effects, motionBlur: 1 } })
    const t = 4.995
    const d = draw(p, t, { options: { blurSamples: 10, frameInterval: 1 / 30 } })
    expect(follow.asked.length).toBeGreaterThan(1)
    expect(follow.asked.every((q) => q.at === undefined || q.at === t)).toBe(true)
    // The shutter reaches past the cut, yet every view drawn is the first clip's.
    expect(follow.asked.some((q) => q.t > 5)).toBe(true)
    expect(screenDraws(d).length).toBeGreaterThan(1)
    for (const a of screenDraws(d)) expect((a[0] + a[2] / 2) / VW).toBeLessThan(0.46)
  })

  it('covers a privacy box over the whole pan of the shutter, without zooms', () => {
    reset()
    follow.centre = (t) => ({ x: 0.3 + 0.5 * (t - 1), y: 0.5 })
    const secret: Shape = { id: 'b', start: 0, end: 12, kind: 'blur', x: 0.35, y: 0.4, w: 0.05, h: 0.1, color: '#000000', strokeWidth: 0, fill: false, opacity: 1, strength: 0.5 }
    const box = (motionBlur: number): number[] => {
      const p = project({}, { shapes: [secret], effects: { ...project().effects, motionBlur } })
      // Not decoded: the box is painted over (PRIVACY_FALLBACK), so its rectangle shows in the calls.
      const d = draw(p, 1.2, { decoded: false, options: { blurSamples: 4, frameInterval: 1 / 30 } })
      return d.mine.find((c) => c.name === 'fillRect' && c.args.length === 4 && (c.args[2] as number) < W)!.args as number[]
    }
    const sharp = box(0)
    const swept = box(1)
    expect(swept[2]).toBeGreaterThan(sharp[2] + 10)
    expect(swept[0]).toBeLessThanOrEqual(sharp[0] + 1e-9)
  })
})

/* ---------- test 49: pulled back while following ---------- */

describe('pulled back while following (test 49)', () => {
  it('draws the card as the recording cut to the slot: smaller than the slot, the background above and below', () => {
    reset()
    // A framed pull-back of 0.5: the whole recording across the slot.
    follow.scale = () => BASE_W
    follow.centre = () => ({ x: 0.5, y: 0.5 })
    const d = draw(project(), 2)
    const card = clipRect(d)
    expect(card.x).toBeCloseTo(0, 6)
    expect(card.w).toBeCloseTo(W, 6)
    expect(card.h).toBeCloseTo(BASE_W * H, 6)
    expect(card.y).toBeCloseTo((H - BASE_W * H) / 2, 6)
    expect(card.y).toBeGreaterThan(SLOT.y)
    expect(card.y + card.h).toBeLessThan(SLOT.y + SLOT.h)
    // The whole recording, in the card.
    const [sx, sy, sw, sh, dx, dy, dw, dh] = screenDraws(d)[0]
    expectRect({ x: sx, y: sy, w: sw, h: sh }, { x: 0, y: 0, w: VW, h: VH })
    expectRect({ x: dx, y: dy, w: dw, h: dh }, card)
    // Its corners are the style's, at full size (the recording spans the slot one way): not shrunk with the scale.
    const full = clipPath(draw(project(), 2))
    follow.scale = () => 1
    const atRest = clipPath(draw(project(), 2))
    expect(full.radii).toEqual(atRest.radii)
    expect(JSON.stringify(atRest.radii)).toContain('24')
    // At full scale the card is the slot.
    expectRect(atRest.rect, SLOT)
  })

  it('paints the card as it moves while a layout change moves the slot (layout.moving), from the static layer otherwise', () => {
    reset()
    /** Whether the card is filled on the frame itself (painted as it moves) rather than on the cached static layer. */
    const paintedOnFrame = (d: Drawn): boolean => d.mine.slice(0, d.mine.findIndex((c) => c.name === 'clip')).some((c) => c.name === 'fill')
    expect(paintedOnFrame(draw(project(), 2))).toBe(false)
    follow.moving = true
    expect(paintedOnFrame(draw(project(), 2))).toBe(true)
    // Pulled back, too.
    follow.moving = false
    follow.scale = () => 0.9
    expect(paintedOnFrame(draw(project(), 2))).toBe(true)
  })
})

/* ---------- test 50: freeze frames ---------- */

describe('freeze frames while following (test 50)', () => {
  it('draws the same screen source rectangle for every held frame (the picture time, not the sound time)', () => {
    reset()
    follow.centre = (t) => ({ x: 0.2 + 0.1 * t, y: 0.5 })
    const p = project()
    const held = [3, 3.1, 3.4, 3.9].map((sound) => screenDraws(draw(p, 2.5, { soundTime: sound }))[0])
    for (const h of held) expect(h).toEqual(held[0])
    expect(screenDraws(draw(p, 3.4))[0]).not.toEqual(held[0])
  })
})

/* ---------- the layers while following ---------- */

describe('layers while following', () => {
  it('draws click effects larger by fxGain while following, and as before otherwise', () => {
    reset()
    const click: ClickEvent = { t: 2, x: 0.3, y: 0.5, button: 'left' }
    const cursor = still([click])
    const ripple = (p: Project): number => {
      const d = draw(p, 2.1, { cursor })
      return d.mine.find((c) => c.name === 'arc')!.args[2] as number
    }
    const p = project({}, { cursor: { ...project().cursor, show: false, clickEffect: true } })
    const gained = ripple(p)
    follow.gain = 1
    expect(gained / ripple(p)).toBeCloseTo(1.904, 9)
    // Not following: the gain is not applied (the 16:9 ripple at the same camera).
    follow.gain = 1.904
    const fit = { ...p, reframe: { ...p.reframe!, mode: 'fit' as const } }
    expect(ripple(fit)).toBeCloseTo(gained / 1.904, 6)
  })

  it('frames the camera less zoomed in a box narrower than square while following', () => {
    reset()
    const base = project({}, { hasWebcam: true, layouts: [{ id: 'l', start: 0, end: 12, layout: 'camera-only' }] })
    const p = { ...base, webcam: { ...base.webcam, show: true, zoom: 1.6 } }
    const source = (q: Project): number[] => draw(q, 2, { webcam: true }).mine.find((c) => c.name === 'drawImage' && (c.args[0] as { tag?: string }).tag === 'camera frame')!.args.slice(1, 5) as number[]
    const followed = source(p)
    const fitted = source({ ...p, reframe: { ...p.reframe!, mode: 'fit' } })
    // The full-frame camera of a 9:16 frame is 0.56:1: zoom 1.6 becomes 1 there (§5.14), so 1.6x the picture shows.
    expect(followed[2] / fitted[2]).toBeCloseTo(1.6, 6)
    expect(followed[3] / fitted[3]).toBeCloseTo(1.6, 6)
  })

  it('places captions, key presses, the logo and a lower third in the text area', () => {
    reset()
    const caps: CaptionSettings = { ...DEFAULT_CAPTIONS, position: 'bottom', background: 'none' }
    const p = project(
      { appSafe: true },
      {
        effects: { motionBlur: 0, keystrokes: { show: true, position: 'top', size: 0.035 } },
        transcript: { provider: 'local', model: 'm', createdAt: '', segments: [{ id: 'k', start: 1, end: 4, text: 'Hello vertical world' }] },
        captions: caps,
        titles: [{ id: 't', start: 0, end: 6, title: 'Billing demo', style: 'lower-third', background: 'solid' }],
        watermark: { show: true, kind: 'text', text: 'qbexel.com', position: 'top-right', size: 0.03, opacity: 0.8, margin: 0.03 }
      }
    )
    const cursor: CursorTrack = { ...still(), keys: [{ t: 1.9, label: 'Ctrl + S' }] }
    const d = draw(p, 2, { cursor })
    const area = { x: COMMON_SAFE.x * W, y: COMMON_SAFE.y * H, w: COMMON_SAFE.w * W, h: COMMON_SAFE.h * H }
    const u = Math.min(W, H)
    // The caption's words: above the area's bottom.
    const words = d.all.filter((c) => c.name === 'fillText' && ['Hello', 'vertical', 'world'].includes(c.args[0] as string))
    expect(words.length).toBeGreaterThan(0)
    for (const w of words) expect(w.args[2] as number).toBeLessThan(area.y + area.h - TEXT_INSET * u)
    expect(Math.max(...words.map((w) => w.args[2] as number))).toBeGreaterThan(area.y + area.h * 0.8)
    // The key presses' pill: at the area's top.
    const pill = d.mine.find((c) => c.name === 'roundRect' && c.args[1] === area.y + TEXT_INSET * u)
    expect(pill).toBeDefined()
    // The lower third's band: its bottom at the area's.
    const band = d.all.find((c) => c.name === 'roundRect' && Math.abs((c.args[1] as number) + (c.args[3] as number) - (area.y + area.h)) < 1e-6)
    expect(band).toBeDefined()
    // The logo's text: inside the area's top right corner.
    const logo = d.all.find((c) => c.name === 'fillText' && c.args[0] === 'qbexel.com')!
    expect(logo).toBeDefined()
    const stamp = d.mine.filter((c) => c.name === 'drawImage' && c.args.length === 3).map((c) => c.args as number[])
    expect(stamp.some((s) => s[2] >= area.y - 1 && s[2] < area.y + 0.1 * u)).toBe(true)
    // appSafe off and no band: placement as today (nothing at the area's top).
    const off = draw({ ...p, reframe: { ...p.reframe!, appSafe: false } }, 2, { cursor })
    expect(off.mine.find((c) => c.name === 'roundRect' && c.args[1] === area.y + TEXT_INSET * u)).toBeUndefined()
  })
})
