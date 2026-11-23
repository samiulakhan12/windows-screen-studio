import { describe, expect, it, vi } from 'vitest'
import type { Cover, CursorTrack, Project, Shape, Spotlight, TitleCard } from '../src/shared/types'
import { base, coverOf, key } from './autoBlurFixtures'

/*
 * Covers in every picture (docs/design/auto-blur.md §8; §17.1 tests 15 to 17), on canvases that
 * record their calls (as tests/verticalEquivalence.test.ts): the fill is in the screen picture
 * before anything samples it, again on the output per sub-frame camera, and the preview's Peek and
 * outlines never reach an output.
 */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  fill: unknown
}
const calls: Call[] = []
let canvases = 0

/** A canvas whose 2D context records its calls (with the fill style they were made with). */
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
      return (...args: unknown[]) => void calls.push({ canvas: id, name: String(prop), args, fill: target.fillStyle })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = (type: string) => (type === '2d' ? ctx : null)
  return c
}

const made = { count: 0 }
vi.stubGlobal('document', {
  createElement: () => {
    made.count++
    return canvas()
  }
})
vi.stubGlobal('Path2D', class {})

const { cropView } = await import('../src/shared/engine/crop')
const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { focusPathFor } = await import('../src/shared/engine/zoom')

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
type Ctx = unknown
type Scene = Record<string, unknown> & { project: Project }
const COMPOSITOR = '../src/renderer/src/render/compositor'
const COVER_LAYER = '../src/renderer/src/render/coverLayer'
const JOIN_STILLS = '../src/renderer/src/editor/joinStills'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: (ctx: Ctx, w: number, h: number, t: number, scene: unknown, src: unknown, options?: unknown) => void }
const layer = (await import(/* @vite-ignore */ COVER_LAYER)) as {
  coverScreen(target: Ctx, screen: unknown, full: unknown, scene: unknown, t: number): unknown
  drawCoverOutput(c: Ctx, scene: unknown, t: number, views: readonly { toOut(x: number, y: number): { x: number; y: number } }[]): void
  forOutput<S>(scene: S): S
}

const COLOR = '#1c1c22'
const SCREEN = { tag: 'the decoded screen frame' }
const ctxOf = (): { ctx: Ctx; id: number } => {
  const c = canvas()
  return { ctx: (c.getContext as (t: string) => unknown)('2d'), id: c.id as number }
}
const still: CursorTrack = { samples: [], clicks: [], keys: [], valid: false } as unknown as CursorTrack

/** The scene as Editor.tsx builds it: through cropView. */
function sceneOf(p: Project, extra: Record<string, unknown> = {}): Scene {
  const view = cropView(p, still)
  return {
    project: view.project,
    cursor: view.cursor,
    cursorPath: new SmoothedTrack(view.cursor.samples, p.duration, p.cursor.smoothing),
    focusPath: focusPathFor(view.cursor.samples, p.duration),
    ...(view.crop ? { crop: view.crop } : {}),
    ...extra
  }
}

const covered = (over: Partial<Project> = {}, covers: Cover[] = [coverOf('c1', 1, 5, [key(1, 0.3, 0.3, 0.1, 0.05)], { color: COLOR })]): Project => ({ ...base('d', 8), covers, ...over })

describe('auto-blur contracts: drawing', () => {
  it('15. coverScreen through the view: no cover active returns its input and makes no canvas; with a crop (and a grade with a LUT) the fill is the view box mapped to the picture and rounded outward, never through the crop twice; with neither it fills a per-target copy and never draws into the video or a bitmap', () => {
    const target = ctxOf().ctx
    const W = 1920
    const H = 1080
    const screen = { image: SCREEN, width: W, height: H }
    // Nothing active at t = 6: the same object, no canvas.
    const before = made.count
    calls.length = 0
    expect(layer.coverScreen(target, screen, screen, sceneOf(covered()), 6)).toBe(screen)
    expect(made.count).toBe(before)
    expect(calls).toEqual([])

    // A crop, and a cover over text 10 px inside the crop's left and top edges (in the recording's pixels).
    const crop = { x: 0.25, y: 0.2, w: 0.5, h: 0.5 }
    const box = { x: crop.x + 10 / W, y: crop.y + 10 / H, w: 200 / W, h: 30 / H }
    for (const over of [{ crop }, { crop, grade: { screen: { look: 'vivid', lut: 'lut-1', contrast: 0.1 } } }] as Partial<Project>[]) {
      const p = covered(over, [coverOf('c1', 1, 5, [key(1, box.x, box.y, box.w, box.h)], { color: COLOR })])
      const scene = sceneOf(p)
      const pw = 960
      const ph = 540
      // The crop's copy: a picture the compositor owns.
      const picture = { image: SCREEN, width: pw, height: ph }
      calls.length = 0
      const out = layer.coverScreen(target, picture, screen, scene, 2) as { image: { id: number }; width: number; height: number }
      const fills = calls.filter((c) => c.name === 'fillRect')
      expect(fills).toHaveLength(1)
      const view = scene.project.covers![0]
      const k = { x: (box.x - crop.x) / crop.w, y: (box.y - crop.y) / crop.h, w: box.w / crop.w, h: box.h / crop.h }
      const [x, y, w, h] = fills[0].args as number[]
      // Rounded outward from the view box, which the scene's covers already are (cropView), mapped once.
      expect(x).toBe(Math.floor(k.x * pw - 1e-6))
      expect(y).toBe(Math.floor(k.y * ph - 1e-6))
      expect(x + w).toBeGreaterThanOrEqual(Math.ceil((k.x + k.w) * pw - 1e-6))
      expect(y + h).toBeGreaterThanOrEqual(Math.ceil((k.y + k.h) * ph - 1e-6))
      expect(x + w).toBeLessThanOrEqual(Math.ceil((k.x + k.w) * pw) + 1)
      // About 10 px of the picture's own 960 inside the left edge: mapped through the crop twice it would be far off.
      expect(x).toBeGreaterThanOrEqual(9)
      expect(x).toBeLessThanOrEqual(11)
      expect(view.path).not.toBe(p.covers![0].path)
      expect(fills[0].fill).toBe(COLOR)
      expect(out.width).toBe(pw)
    }

    // No crop, no grade: the decoded frame is copied once into this target's canvas and filled there.
    const video = {
      tag: 'video',
      getContext: () => {
        throw new Error('drew into the video')
      }
    }
    const frame = { image: video, width: W, height: H }
    const p = covered()
    const own = ctxOf().ctx
    const n0 = made.count
    calls.length = 0
    const out = layer.coverScreen(own, frame, frame, sceneOf(p), 2) as { image: { id: number } }
    expect(made.count).toBe(n0 + 1)
    expect(out.image).not.toBe(video)
    expect(calls.map((c) => [c.canvas, c.name]).filter(([, n]) => n === 'drawImage' || n === 'fillRect')).toEqual([
      [out.image.id, 'drawImage'],
      [out.image.id, 'fillRect']
    ])
    expect(calls.find((c) => c.name === 'drawImage')!.args[0]).toBe(video)
    // The same target again: the same copy, no new canvas.
    layer.coverScreen(own, frame, frame, sceneOf(p), 2.5)
    expect(made.count).toBe(n0 + 1)
    // Another target: its own copy (a bitmap or a video a worker shares is never drawn into).
    layer.coverScreen(ctxOf().ctx, frame, frame, sceneOf(p), 2)
    expect(made.count).toBe(n0 + 2)
  })

  it("16. Everything samples the covered picture: a blur shape beside a cover, a magnifier over it, every motion-blur sub-frame and a title card's blurred background draw from the filled copy, never the decoded frame; drawCoverOutput fills once per sub-frame camera; nothing in the 'overlays' alpha mode", () => {
    const blur: Shape = { id: 'h', start: 0, end: 8, kind: 'blur', x: 0.42, y: 0.3, w: 0.2, h: 0.05, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.6 }
    const lens: Spotlight = { id: 'm', start: 0, end: 8, mode: 'region', x: 0.25, y: 0.25, w: 0.2, h: 0.2, shape: 'ellipse', dim: 0, feather: 0.2, magnify: 2 }
    const card: TitleCard = { id: 't', start: 3, end: 5, title: 'Billing', style: 'centered', background: 'blur' }
    const p = covered({ shapes: [blur], spotlights: [lens], titles: [card], zooms: [{ id: 'z', start: 1.5, end: 4, scale: 2, focus: { mode: 'fixed', x: 0.35, y: 0.3 }, auto: false }] })
    const scene = sceneOf(p)
    const src = { screen: { readyState: 4, videoWidth: 1920, videoHeight: 1080 }, webcam: null, background: null, screenFrame: { image: SCREEN, width: 1920, height: 1080 } }
    for (const [t, options] of [
      [2, { blurSamples: 1 }],
      [2.2, { blurSamples: 6, frameInterval: 1 / 30 }],
      [4, { blurSamples: 4, frameInterval: 1 / 30 }]
    ] as const) {
      const { ctx, id } = ctxOf()
      calls.length = 0
      drawFrame(ctx, 1920, 1080, t, scene, src, options)
      const reads = calls.filter((c) => c.name === 'drawImage' && c.args[0] === SCREEN)
      expect(reads.length, `t=${t}`).toBeGreaterThan(0)
      // The decoded frame is only ever copied, and each copy is filled before anything else touches it.
      for (const r of reads) {
        expect(r.canvas, `t=${t}: the frame drawn onto the output`).not.toBe(id)
        const after = calls.slice(calls.indexOf(r) + 1).find((c) => c.canvas === r.canvas && !['save', 'restore', 'setTransform'].includes(c.name))
        expect(after?.name, `t=${t}: the copy's next call`).toBe('fillRect')
        expect(after?.fill).toBe(COLOR)
      }
      // What the output draws of the screen is the filled copy.
      const copies = new Set(reads.map((r) => r.canvas))
      expect(calls.some((c) => c.canvas === id && c.name === 'drawImage' && copies.has((c.args[0] as { id?: number })?.id ?? -1)), `t=${t}`).toBe(true)
    }
    // Once per sub-frame camera, the fill on the output, grown by a pixel.
    const views = [0, 0.4, 0.8].map((dx) => ({ toOut: (x: number, y: number) => ({ x: (x + dx / 100) * 1000, y: y * 500 }) }))
    const { ctx: out, id } = ctxOf()
    calls.length = 0
    layer.drawCoverOutput(out, scene, 2, views)
    const fills = calls.filter((c) => c.canvas === id && c.name === 'fillRect')
    expect(fills).toHaveLength(3)
    for (const f of fills) expect(f.fill).toBe(COLOR)
    calls.length = 0
    layer.drawCoverOutput(out, { ...scene, alpha: 'overlays' }, 2, views)
    expect(calls).toEqual([])
    // Nothing active: nothing drawn.
    layer.drawCoverOutput(out, scene, 6, views)
    expect(calls).toEqual([])
  })

  it('17. Peek and the cover outlines never reach an output: forOutput leaves them out of every export, preview, thumbnail, guide shot and join still; JoinStills.fresh is false when either changes, and its fallback never gives a still of another state', async () => {
    const p = covered()
    const scene = sceneOf(p, { peek: { ids: ['c1'] }, coverMarks: true })
    const plain = layer.forOutput(scene)
    expect(plain).not.toHaveProperty('peek')
    expect(plain).not.toHaveProperty('coverMarks')
    expect(plain.project).toBe(scene.project)
    const none = sceneOf(p)
    expect(layer.forOutput(none)).toBe(none)
    // Peeked, the preview leaves the cover open; for an output, the fill is drawn.
    const views = [{ toOut: (x: number, y: number) => ({ x: x * 1000, y: y * 500 }) }]
    const { ctx, id } = ctxOf()
    calls.length = 0
    layer.drawCoverOutput(ctx, scene, 2, views)
    expect(calls.filter((c) => c.canvas === id && c.name === 'fillRect')).toEqual([])
    layer.drawCoverOutput(ctx, plain, 2, views)
    expect(calls.filter((c) => c.canvas === id && c.name === 'fillRect')).toHaveLength(1)
    // Every output path starts from forOutput: the export's prepare (exports, thumbnails and guide shots), the export preview and join stills.
    const fs = await import('node:fs')
    const read = (f: string): string => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    expect(read('src/renderer/src/editor/exporter.ts')).toMatch(/async function prepare[\s\S]*?forOutput\(input\.scene\)/)
    expect(read('src/renderer/src/editor/exporter.ts')).toMatch(/export async function renderThumbnail[\s\S]*?await prepare\(raw\)/)
    expect(read('src/renderer/src/guide/guideStills.ts')).toMatch(/prepareFrames\(/)
    expect(read('src/renderer/src/editor/ExportPreview.tsx')).toContain('forOutput(props.scene)')
    expect(read('src/renderer/src/render/joinLayer.ts')).toContain('forOutput(scene)')

    // Join stills: a still composed with another Peek or outlines is neither fresh nor given.
    const { JoinStills } = (await import(/* @vite-ignore */ JOIN_STILLS)) as { JoinStills: new (...a: unknown[]) => Record<string, unknown> & { still(w: unknown, x: number, y: number): unknown; dispose(): void } }
    const js = JoinStills.prototype as unknown as { still: (w: unknown, x: number, y: number) => unknown }
    const self = Object.create(JoinStills.prototype) as Record<string, unknown>
    const win = { index: 0, clip: 'b', kind: 'crossfade', from: 1, to: 2, at: 1, still: { screen: 1, held: false, camera: null } }
    const composedCanvas = canvas()
    const composed = new Map([['b|640x360', { canvas: composedCanvas, project: plain.project, compare: false, peek: '', marks: false, screenLut: null, cameraLut: null }]])
    Object.assign(self, { composed, wanted: [win], disposed: false, timer: 1, target: { scene: plain, w: 640, h: 360, background: null } })
    expect(js.still.call(self, win, 640, 360)).toBe(composedCanvas)
    for (const changed of [{ ...plain, peek: { ids: ['c1'] } }, { ...plain, peek: { ids: 'all' } }, { ...plain, coverMarks: true }]) {
      Object.assign(self, { target: { scene: changed, w: 640, h: 360, background: null } })
      expect(js.still.call(self, win, 640, 360)).toBeNull()
    }
    // Another Compare or LUT: given until it is made again (as before).
    Object.assign(self, { target: { scene: { ...plain, compare: true }, w: 640, h: 360, background: null } })
    expect(js.still.call(self, win, 640, 360)).toBe(composedCanvas)
  })
})
