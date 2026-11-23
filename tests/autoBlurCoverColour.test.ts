import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { effectiveGrade, gradePixelsCpu, gradeTable, resolveGrade } from '../src/shared/render/colorGrade'
import { coverColourOf, ringColour } from '../src/shared/render/coverColour'
import { COVER_COLOURS, COVER_DARK } from '../src/shared/privacy/kinds'
import { writePath, type CoverKey } from '../src/shared/privacy/coverPath'
import type { ColorGrade, Cover, Project } from '../src/shared/types'

/*
 * A cover's colour and the editor's own pictures (docs/design/auto-blur.md §8.4, §8.5, §9 rows 18
 * and 28; §17.1 tests 53 to 55, 59, 73, 210 and 211): the ring, the graded colour, Peek's outlines,
 * the colour read from the recording at a time, the filmstrip tiles and the look chips. Canvases
 * record their calls (as tests/autoBlurDrawing.test.ts).
 */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  fill: unknown
  stroke: unknown
  dash: unknown
}
const calls: Call[] = []
let canvases = 0
/** What a canvas's getImageData gives (the ring test's pixels). */
let imageData: Uint8ClampedArray | null = null

function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id }
  const state: Record<string | symbol, unknown> = {}
  let dash: number[] = []
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'setLineDash') return (d: number[]) => void (dash = d)
      if (prop === 'getImageData') return (...args: unknown[]) => (calls.push({ canvas: id, name: 'getImageData', args, fill: null, stroke: null, dash }), { data: imageData ?? new Uint8ClampedArray(4 * (args[2] as number) * (args[3] as number)) })
      return (...args: unknown[]) => void calls.push({ canvas: id, name: String(prop), args, fill: target.fillStyle, stroke: target.strokeStyle, dash })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = (type: string) => (type === '2d' ? ctx : null)
  return c
}

/** The hidden <video> coverPick seeks: assigning currentTime fires `seeked` at once. */
class FakeVideo extends EventTarget {
  muted = false
  preload = ''
  src = ''
  videoWidth = 1920
  videoHeight = 1080
  sought: number[] = []
  private time = 0
  get currentTime(): number {
    return this.time
  }
  set currentTime(t: number) {
    this.time = t
    this.sought.push(t)
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')))
  }
  removeAttribute(): void {}
  load(): void {}
}
const videos: FakeVideo[] = []
vi.stubGlobal('document', {
  createElement: (tag: string) => {
    if (tag === 'video') {
      const v = new FakeVideo()
      videos.push(v)
      return v
    }
    return canvas()
  }
})
vi.stubGlobal('window', { api: { getPref: async () => null } })
vi.stubGlobal('Path2D', class {})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const GRADE = '../src/renderer/src/render/coverGrade'
const LAYER = '../src/renderer/src/render/coverLayer'
const PICK = '../src/renderer/src/privacy/coverPick'
const STRIP = '../src/renderer/src/privacy/filmstripCovers'
const GRADE_LAYER = '../src/renderer/src/render/gradeLayer'
const RUN = '../src/renderer/src/guide/guideRun'
const grade = (await import(/* @vite-ignore */ GRADE)) as { gradedCoverColour(c: string, g: ColorGrade | undefined, l: unknown, compare?: boolean): string; COVER_OUTLINE: string }
const layer = (await import(/* @vite-ignore */ LAYER)) as { drawCoverOutput(c: unknown, scene: unknown, t: number, views: unknown[]): void; coverScreen(target: unknown, s: unknown, f: unknown, scene: unknown, t: number): unknown }
const pick = (await import(/* @vite-ignore */ PICK)) as { ringColourAt(id: string, t: number, box: unknown): Promise<string> }
const strip = (await import(/* @vite-ignore */ STRIP)) as {
  fillCoverTiles(ctx: unknown, p: Project, fps: number, tiles: { t: number; x: number; y: number; w: number; h: number }[]): void
  fillCoverPixels(px: Uint8ClampedArray, w: number, h: number, p: Project, t: number): void
}

const key = (t: number, x: number, y: number, w: number, h: number): CoverKey => ({ t, x, y, w, h })
const cover = (id: string, start: number, end: number, keys: CoverKey[], over: Partial<Cover> = {}): Cover => ({ id, start, end, path: writePath(keys), color: '#203040', ...over })
function project(over: Partial<Project> = {}, fps = 60): Project {
  const p = createProject({ id: 'p', name: 'p', duration: 30, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'native', cursorInVideo: false, region: null, fps } })
  return { ...p, ...over }
}

/** A `w` × `h` RGBA picture of `fill`, with `paint(x, y)` overriding a pixel. */
function picture(w: number, h: number, fill: [number, number, number], paint?: (x: number, y: number) => [number, number, number] | null): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = paint?.(x, y) ?? fill
      px.set([c[0], c[1], c[2], 255], (y * w + x) * 4)
    }
  return px
}

/** One pixel graded with the CPU maths, worked out here on its own. */
function cpu(color: string, g: ColorGrade, lut: unknown): string {
  const r = effectiveGrade(resolveGrade(g, 'screen'), lut as never)
  if (!r) return color
  const px = new Uint8ClampedArray([parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), 255])
  gradePixelsCpu(px, r, gradeTable(r), lut && r.lutStrength > 0 ? (lut as never) : null)
  return `#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

describe('auto-blur P1: a cover\'s colour', () => {
  it('53. ringColour gives the median and spread of synthetic rings; a spread over 24 gives Dark through coverColourOf; the preference\'s chips replace the ring', () => {
    const box = { x: 6, y: 6, w: 8, h: 4 }
    // A plain ring (and a different inside, which is never read): its colour, no spread.
    const plain = picture(20, 16, [51, 102, 153], (x, y) => (x >= 6 && x < 14 && y >= 6 && y < 10 ? [255, 0, 0] : null))
    expect(ringColour(plain, 20, 16, box)).toEqual({ color: '#336699', spread: 0 })
    // A few odd pixels in the ring do not move the median.
    const speckled = picture(20, 16, [51, 102, 153], (x, y) => ((x === 5 && y === 5) || (x === 14 && y === 9) ? [255, 255, 255] : null))
    expect(ringColour(speckled, 20, 16, box).color).toBe('#336699')
    expect(coverColourOf(ringColour(speckled, 20, 16, box), 'ring')).toBe('#336699')
    // A ring over two backgrounds (left half black, right half white): a large spread, so Dark.
    const mixed = picture(20, 16, [0, 0, 0], (x) => (x >= 10 ? [255, 255, 255] : null))
    const ring = ringColour(mixed, 20, 16, box)
    expect(ring.spread).toBeGreaterThan(24)
    expect(coverColourOf(ring, undefined)).toBe(COVER_DARK)
    expect(coverColourOf(ring, 'ring')).toBe(COVER_DARK)
    // A slightly noisy ring keeps its colour (spread under 24).
    const noisy = picture(20, 16, [100, 100, 100], (x, y) => ((x + y) % 2 ? [110, 110, 110] : null))
    expect(ringColour(noisy, 20, 16, box).spread).toBeLessThanOrEqual(24)
    expect(coverColourOf(ringColour(noisy, 20, 16, box), undefined)).not.toBe(COVER_DARK)
    // The preference's chips replace the ring.
    for (const chip of ['dark', 'light', 'black', 'white'] as const) expect(coverColourOf(ringColour(plain, 20, 16, box), chip)).toBe(COVER_COLOURS[chip])
    // A box that fills the picture has no ring: Dark.
    expect(ringColour(plain, 20, 16, { x: 0, y: 0, w: 20, h: 16 })).toEqual({ color: COVER_DARK, spread: 0 })
  })

  it('54. gradedCoverColour equals the CPU grade of one pixel for five grades, with and without a LUT; with Compare on it is the raw colour', async () => {
    const { selfTestLut } = (await import(/* @vite-ignore */ GRADE_LAYER)) as { selfTestLut(): unknown }
    const lut = selfTestLut()
    const lutRef = { file: 'lut-1.cube', sha256: '0'.repeat(64), title: 'Test', size: 17, strength: 0.8 }
    const grades: ColorGrade[] = [
      { look: 'vivid' },
      { contrast: 0.3, brightness: -0.1 },
      { temperature: 0.4, tint: -0.2 },
      { saturation: -0.6, highlights: 0.3, shadows: -0.2 },
      { look: 'mono', lookStrength: 0.5, vibrance: 0.4 }
    ]
    for (const color of ['#203040', '#e8e8ee', '#1c1c22']) {
      for (const g of grades) {
        expect(grade.gradedCoverColour(color, g, null), JSON.stringify(g)).toBe(cpu(color, g, null))
        const withLut = { ...g, lut: lutRef }
        expect(grade.gradedCoverColour(color, withLut, lut), `${JSON.stringify(g)} + LUT`).toBe(cpu(color, withLut, lut))
        expect(grade.gradedCoverColour(color, withLut, lut, true)).toBe(color)
      }
      // A grade that changes something gives another colour; none gives the colour itself.
      expect(grade.gradedCoverColour(color, grades[1], null)).not.toBe(color)
      expect(grade.gradedCoverColour(color, undefined, null)).toBe(color)
    }
  })

  it('55. drawCoverPeek: peeked covers are outlined and not filled; others are filled', () => {
    const p = project({ covers: [cover('a', 1, 5, [key(1, 0.1, 0.1, 0.2, 0.1)]), cover('b', 1, 5, [key(1, 0.5, 0.5, 0.2, 0.1)])] })
    const c = canvas()
    const ctx = (c.getContext as (t: string) => unknown)('2d')
    const view = { toOut: (x: number, y: number) => ({ x: x * 1000, y: y * 500 }) }
    calls.length = 0
    layer.drawCoverOutput(ctx, { project: p, peek: { ids: ['a'] } }, 2, [view])
    const fills = calls.filter((k) => k.name === 'fillRect')
    // Only b is filled (its box grown by one output pixel).
    expect(fills.map((k) => k.args)).toEqual([[499, 249, 202, 52]])
    // a is outlined in the accent colour (2 px), with a black halo; nothing outlines b.
    const strokes = calls.filter((k) => k.name === 'strokeRect')
    expect(strokes.map((k) => k.stroke)).toEqual(['#000000', grade.COVER_OUTLINE])
    for (const s of strokes) expect((s.args[0] as number) < 100 && (s.args[0] as number) > 90).toBe(true)
    // Every cover peeked: nothing filled.
    calls.length = 0
    layer.drawCoverOutput(ctx, { project: p, peek: { ids: 'all' } }, 2, [view])
    expect(calls.filter((k) => k.name === 'fillRect')).toEqual([])
    expect(calls.filter((k) => k.name === 'strokeRect' && k.stroke === grade.COVER_OUTLINE)).toHaveLength(2)
    // Without Peek both are filled and nothing is outlined.
    calls.length = 0
    layer.drawCoverOutput(ctx, { project: p }, 2, [view])
    expect(calls.filter((k) => k.name === 'fillRect')).toHaveLength(2)
    expect(calls.filter((k) => k.name === 'strokeRect')).toEqual([])
  })

  it('59. ringColourAt seeks a hidden video to t and samples there; the guide\'s Blur an area… passes the step\'s shot time, not the playhead', async () => {
    // The ring the frame has at the box: a plain #406080 around it.
    imageData = picture(4 + 576, 4 + 108, [64, 96, 128])
    calls.length = 0
    const colour = await pick.ringColourAt('p', 7.25, { x: 0.25, y: 0.5, w: 0.3, h: 0.1 })
    expect(colour).toBe('#406080')
    const v = videos.at(-1)!
    expect(v.src).toContain('screen.mp4')
    expect(v.sought).toEqual([7.25])
    // Only the box and its 2 px ring are read, at the recording's own pixels.
    const draw = calls.find((k) => k.name === 'drawImage')!
    expect(draw.args.slice(1)).toEqual([478, 538, 580, 112, 0, 0, 580, 112])
    // The guide's Blur an area… takes the colour at the step's own shot time, never the paused frame's.
    const { blurArea } = (await import(/* @vite-ignore */ RUN)) as { blurArea(s: unknown, step: unknown, o: unknown): Promise<string> }
    const { testStore } = await import('./studioHarness')
    const { shotTime } = await import('../src/shared/guide/shots')
    const store = testStore(project())
    const player = { time: 21, seek: () => undefined, subscribe: () => () => undefined }
    const step = { key: 'c3000', t: 3, kind: 'click', x: 0.5, y: 0.5 }
    await blurArea({ store, player }, step, { after: false, scale: 1, onSelect: () => undefined })
    expect(videos.at(-1)!.sought.at(-1)).toBeCloseTo(shotTime(step as never, store.state.clips, 60, false), 9)
    expect(store.state.covers![0].color).toBe('#406080')
    imageData = null
  })

  it('73. fillCoverTiles fills each tile\'s active cover boxes in Dark; with no covers it makes no draw call', () => {
    const c = canvas()
    const ctx = (c.getContext as (t: string) => unknown)('2d')
    const tiles = [
      { t: 2, x: 0, y: 0, w: 96, h: 54 },
      { t: 20, x: 96, y: 0, w: 96, h: 54 }
    ]
    calls.length = 0
    strip.fillCoverTiles(ctx, project(), 60, tiles)
    expect(calls).toEqual([])
    const p = project({ covers: [cover('a', 1, 5, [key(1, 0.5, 0.5, 0.25, 0.1)])] })
    strip.fillCoverTiles(ctx, p, 60, tiles)
    const fills = calls.filter((k) => k.name === 'fillRect')
    expect(fills.map((k) => [k.args, k.fill])).toEqual([[[48, 27, 24, 6], COVER_DARK]])
    // A cropped project's tiles show the crop: the box is placed in the crop's view.
    calls.length = 0
    strip.fillCoverTiles(ctx, { ...p, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }, 60, tiles)
    expect(calls.filter((k) => k.name === 'fillRect').map((k) => k.args)).toEqual([[0, 0, 48, 11]])
  })

  it('210. fillCoverPixels fills the active covers into the look chips\' 96×54 pixels before grading; with no cover it touches nothing', () => {
    const W = 96
    const H = 54
    const px = new Uint8ClampedArray(W * H * 4).fill(200)
    strip.fillCoverPixels(px, W, H, project(), 2)
    expect(px.every((v) => v === 200)).toBe(true)
    const p = project({ covers: [cover('a', 1, 5, [key(1, 0.5, 0.5, 0.25, 0.1)])] })
    // At a time with no cover active: untouched.
    strip.fillCoverPixels(px, W, H, p, 10)
    expect(px.every((v) => v === 200)).toBe(true)
    strip.fillCoverPixels(px, W, H, p, 2)
    const at = (x: number, y: number): number[] => [...px.slice((y * W + x) * 4, (y * W + x) * 4 + 4)]
    expect(at(48, 27)).toEqual([0x1c, 0x1c, 0x22, 255])
    expect(at(71, 32)).toEqual([0x1c, 0x1c, 0x22, 255])
    expect(at(47, 27)).toEqual([200, 200, 200, 200])
    expect(at(72, 27)).toEqual([200, 200, 200, 200])
    // The look chips grade these pixels afterwards (ColourControls' LookThumb fills before grading).
    const thumb = fs.readFileSync('src/renderer/src/editor/panels/ColourControls.tsx', 'utf8')
    expect(thumb.indexOf('fillCoverPixels(px')).toBeLessThan(thumb.indexOf('gradePixelsCpu(px'))
  })

  it('211. fillCoverTiles fills, for a tile at t, every cover active anywhere in [t − 15 / fps − 0.02, t], so a cover that ended 10 frames before t is filled on a tile showing the key frame before it', () => {
    const c = canvas()
    const ctx = (c.getContext as (t: string) => unknown)('2d')
    for (const fps of [30, 60]) {
      const t = 10
      const ended = cover('e', 8, t - 10 / fps, [key(8, 0.1, 0.1, 0.25, 0.1)])
      const tooEarly = cover('o', 5, t - 15 / fps - 0.05, [key(5, 0.6, 0.6, 0.25, 0.1)])
      const later = cover('l', t + 0.5, 12, [key(t + 0.5, 0.6, 0.1, 0.25, 0.1)])
      calls.length = 0
      strip.fillCoverTiles(ctx, project({ covers: [ended, tooEarly, later] }, fps), fps, [{ t, x: 0, y: 0, w: 96, h: 54 }])
      expect(calls.filter((k) => k.name === 'fillRect').map((k) => k.args), `${fps} fps`).toEqual([[9, 5, 25, 6]])
    }
  })
})
