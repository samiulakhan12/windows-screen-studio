/**
 * Grading pictures in the renderer (docs/design/editing-polish.md §9.1, §9.3; §19.1 tests 56 and
 * 81): an identity grade or Compare returns the picture itself and makes no context; the backend is
 * chosen once, after a self-test that a picture flipped top to bottom fails; a lost context that
 * cannot be made again moves the session to the CPU path, which logs why; the camera's blur
 * composite is made again for a new raw frame or a new grade, and only then.
 *
 * The WebGL2 context is a fake that runs the reference maths (gradePixel) on what was uploaded:
 * the picture, the per-channel table, the LUT and its shaper as textures, the grade's numbers as
 * uniforms. Its rows are read as the shader reads them (row H − 1 − y for the fragment at y, the
 * drawing buffer's origin at the bottom left), so the upload, the uniforms and the copy out are
 * checked against the shader's own conventions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gradePixel, gradePixelsCpu, gradeTable, resolveGrade, shaperTexel, type ResolvedGrade } from '../src/shared/render/colorGrade'
import type { CubeLut } from '../src/shared/render/cubeLut'
import { createProject } from '../src/shared/engine/project'
import type { ColorGrade, Project } from '../src/shared/types'

/* ---------- fakes: 2D canvases with pixels, and a WebGL2 context that runs the reference ---------- */

let made = { canvases: 0, offscreen: 0, webgl2: 0 }
/** Whether a new WebGL2 context can be had. */
let glAvailable = true
/** Changes what the fake GPU draws (a broken driver): the rows it wrote, top-down, in place. */
let spoil: ((px: Uint8ClampedArray, w: number, h: number) => void) | null = null
let lastGl: FakeGl | null = null
/** The next draw loses the context (a driver reset in the middle of a frame). */
let loseOnDraw = false

interface Pixels {
  width: number
  height: number
  px?: Uint8ClampedArray
}

/** Pixels of a source at (x, y) (zeros where it has none). */
function at(src: Pixels, x: number, y: number): [number, number, number, number] {
  const p = src.px
  if (!p || x < 0 || y < 0 || x >= src.width || y >= src.height) return [0, 0, 0, 255]
  const o = (y * src.width + x) * 4
  return [p[o], p[o + 1], p[o + 2], p[o + 3]]
}

class FakeCanvas implements Pixels {
  private w = 0
  private h = 0
  px = new Uint8ClampedArray(0)
  private ctx: unknown = null
  constructor() {
    made.canvases++
  }
  get width(): number {
    return this.w
  }
  set width(v: number) {
    this.w = v
    this.px = new Uint8ClampedArray(this.w * this.h * 4)
  }
  get height(): number {
    return this.h
  }
  set height(v: number) {
    this.h = v
    this.px = new Uint8ClampedArray(this.w * this.h * 4)
  }
  getContext(type: string): unknown {
    if (type !== '2d') return null
    return (this.ctx ??= context2d(this))
  }
}

/** A 2D context: pixel copies, image data, and every other call recorded and ignored. */
function context2d(canvas: FakeCanvas): unknown {
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over', imageSmoothingEnabled: true, globalAlpha: 1, filter: 'none' }
  const own: Record<string, unknown> = {
    canvas,
    drawImage(src: Pixels, ...a: number[]) {
      let [sx, sy, sw, sh, dx, dy] = [0, 0, src.width, src.height, 0, 0]
      if (a.length === 2 || a.length === 4) [dx, dy] = a
      else if (a.length === 8) [sx, sy, sw, sh, dx, dy] = a
      draws.push({ to: canvas, from: src, op: String(state.globalCompositeOperation) })
      for (let y = 0; y < sh; y++)
        for (let x = 0; x < sw; x++) {
          const tx = dx + x
          const ty = dy + y
          if (tx < 0 || ty < 0 || tx >= canvas.width || ty >= canvas.height) continue
          canvas.px.set(at(src, sx + x, sy + y), (ty * canvas.width + tx) * 4)
        }
    },
    getImageData(x: number, y: number, w: number, h: number) {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) data.set(at(canvas, x + c, y + r), (r * w + c) * 4)
      return { data, width: w, height: h }
    },
    putImageData(img: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) {
      for (let r = 0; r < img.height; r++)
        for (let c = 0; c < img.width; c++) {
          if (x + c >= canvas.width || y + r >= canvas.height) continue
          const o = (r * img.width + c) * 4
          canvas.px.set(img.data.subarray(o, o + 4), ((y + r) * canvas.width + x + c) * 4)
        }
    },
    createImageData(w: number, h: number) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
    }
  }
  return new Proxy(own, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop in state) return state[prop]
      return () => undefined
    },
    set(_t, prop: string, value) {
      state[prop] = value
      return true
    }
  })
}

const draws: { to: unknown; from: unknown; op: string }[] = []

interface Texture {
  target: number
  w: number
  h: number
  d: number
  px: Uint8ClampedArray | null
  data: Float32Array | null
}

/** Constant names as numbers (each its own). */
const constants = new Map<string, number>()
const constant = (name: string): number => {
  // TEXTURE0 + n is TEXTUREn, as in WebGL.
  const unit = /^TEXTURE(\d+)$/.exec(name)
  if (unit) return 0x84c0 + Number(unit[1])
  if (!constants.has(name)) constants.set(name, 0x1000 + constants.size)
  return constants.get(name)!
}

class FakeGl {
  lost = false
  canvas: FakeGlCanvas
  unit = 0
  bound = new Map<string, Texture>()
  uniforms = new Map<string, number[]>()
  viewportSize = [0, 0, 0, 0]
  draws = 0
  constructor(canvas: FakeGlCanvas) {
    this.canvas = canvas
  }
  isContextLost(): boolean {
    return this.lost
  }
  getExtension(name: string): unknown {
    return name === 'WEBGL_lose_context' ? { loseContext: () => void (this.lost = true) } : null
  }
  createShader(): object {
    return {}
  }
  getShaderParameter(): boolean {
    return true
  }
  getProgramParameter(): boolean {
    return true
  }
  createProgram(): object {
    return {}
  }
  getUniformLocation(_p: unknown, name: string): { name: string } {
    return { name }
  }
  uniform1i(l: { name: string }, v: number): void {
    this.uniforms.set(l.name, [v])
  }
  uniform1f(l: { name: string }, v: number): void {
    this.uniforms.set(l.name, [v])
  }
  uniform3f(l: { name: string }, a: number, b: number, c: number): void {
    this.uniforms.set(l.name, [a, b, c])
  }
  createTexture(): Texture {
    return { target: 0, w: 0, h: 0, d: 0, px: null, data: null }
  }
  activeTexture(u: number): void {
    this.unit = u - this.TEXTURE0
  }
  bindTexture(target: number, t: Texture): void {
    t.target = target
    this.bound.set(`${this.unit}:${target}`, t)
  }
  private current(target: number): Texture {
    return this.bound.get(`${this.unit}:${target}`)!
  }
  texImage2D(target: number, _level: number, _fmt: number, ...rest: unknown[]): void {
    const t = this.current(target)
    if (rest.length === 3) {
      const src = rest[2] as Pixels
      t.w = src.width
      t.h = src.height
      t.px = new Uint8ClampedArray(src.px ?? new Uint8ClampedArray(t.w * t.h * 4))
      t.data = null
    } else {
      t.w = rest[0] as number
      t.h = rest[1] as number
      t.data = new Float32Array(rest[5] as Float32Array)
      t.px = null
    }
  }
  texSubImage2D(target: number, _level: number, _x: number, _y: number, _f: number, _t: number, src: Pixels): void {
    const t = this.current(target)
    t.px = new Uint8ClampedArray(src.px ?? new Uint8ClampedArray(t.w * t.h * 4))
  }
  texImage3D(target: number, _level: number, _fmt: number, w: number, h: number, d: number, _b: number, _f: number, _t: number, data: Float32Array): void {
    const t = this.current(target)
    Object.assign(t, { w, h, d, data: new Float32Array(data), px: null })
  }
  viewport(x: number, y: number, w: number, h: number): void {
    this.viewportSize = [x, y, w, h]
  }
  private u(name: string, i = 0): number {
    return this.uniforms.get(name)?.[i] ?? 0
  }
  private tex(uniform: string, target: number): Texture | undefined {
    return this.bound.get(`${this.u(uniform)}:${target}`)
  }
  /** The fragment shader, emulated with the reference maths on what was uploaded. */
  drawArrays(): void {
    this.draws++
    if (loseOnDraw) {
      loseOnDraw = false
      this.lost = true
      return
    }
    const [, , w, h] = this.viewportSize
    const pic = this.tex('pic', this.TEXTURE_2D)!
    const tableTex = this.tex('table', this.TEXTURE_2D)!.data!
    const table = new Float32Array(768)
    for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) table[c * 256 + i] = tableTex[i * 4 + c]
    const crossing = this.u('crossing') === 1
    const lutN = this.u('lutN')
    const g: ResolvedGrade = {
      temperature: 0,
      tint: 0,
      exposure: 0,
      brightness: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      fade: 0,
      saturation: crossing ? this.u('S0') - 1 : 0,
      vibrance: crossing ? this.u('vib') : 0,
      split: { kS: crossing ? this.u('kS') : 0, kH: crossing ? this.u('kH') : 0 },
      lutStrength: lutN > 0 ? this.u('lutMix') : 0
    }
    let lut: CubeLut | null = null
    if (lutN > 0) {
      const t3 = this.tex('lut', this.TEXTURE_3D)!.data!
      const data = new Float32Array(lutN ** 3 * 3)
      for (let i = 0; i < lutN ** 3; i++) for (let c = 0; c < 3; c++) data[i * 3 + c] = t3[i * 4 + c]
      const dMin = [0, 1, 2].map((i) => this.u('dMin', i)) as [number, number, number]
      const dMax = [0, 1, 2].map((i) => this.u('dMin', i) + 1 / this.u('dScale', i)) as [number, number, number]
      const n1 = this.u('shaperN')
      let shaper: CubeLut['shaper'] = null
      if (n1 > 0) {
        const st = this.tex('shaper', this.TEXTURE_2D)!
        const sd = new Float32Array(n1 * 3)
        // Entry i is read at shaperTexel(i), as the shader's entry(i) does.
        for (let i = 0; i < n1; i++) {
          const [x, y] = shaperTexel(i)
          for (let c = 0; c < 3; c++) sd[i * 3 + c] = st.data![(y * st.w + x) * 4 + c]
        }
        shaper = { size: n1, data: sd, min: this.u('sMin'), max: this.u('sMin') + 1 / this.u('sScale') }
      }
      lut = { title: '', size: lutN, data, shaper, domainMin: dMin, domainMax: dMax }
    }
    const H = this.u('H')
    const flips = FRAGMENT.includes('H - 1 - int(gl_FragCoord.y)')
    const CH = this.canvas.height
    const out = this.canvas.px
    const rows = new Uint8ClampedArray(w * h * 4)
    // The fragment at buffer row y (from the bottom) reads picture row H − 1 − y, and lands on canvas row CH − 1 − y.
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [r, gg, b] = at({ width: pic.w, height: pic.h, px: pic.px! }, x, flips ? H - 1 - y : y)
        const o = gradePixel([r, gg, b], g, table, lut)
        rows.set([o[0], o[1], o[2], 255], ((h - 1 - y) * w + x) * 4)
      }
    spoil?.(rows, w, h)
    for (let y = 0; y < h; y++) out.set(rows.subarray(y * w * 4, (y + 1) * w * 4), ((CH - h + y) * this.canvas.width) * 4)
  }
}

/** Every other WebGL call is ignored; constants are numbers. */
function glProxy(gl: FakeGl): unknown {
  return new Proxy(gl, {
    get(target, prop: string) {
      if (prop in target) {
        const v = (target as unknown as Record<string, unknown>)[prop]
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      }
      if (/^[A-Z0-9_]+$/.test(prop)) return constant(prop)
      return () => undefined
    }
  })
}
for (const name of ['TEXTURE0', 'TEXTURE_2D', 'TEXTURE_3D']) Object.defineProperty(FakeGl.prototype, name, { get: () => constant(name) })
interface FakeGl {
  TEXTURE0: number
  TEXTURE_2D: number
  TEXTURE_3D: number
}

class FakeGlCanvas implements Pixels {
  private w: number
  private h: number
  px: Uint8ClampedArray
  constructor(w: number, h: number) {
    made.offscreen++
    this.w = w
    this.h = h
    this.px = new Uint8ClampedArray(w * h * 4)
  }
  get width(): number {
    return this.w
  }
  set width(v: number) {
    this.w = v
    this.px = new Uint8ClampedArray(this.w * this.h * 4)
  }
  get height(): number {
    return this.h
  }
  set height(v: number) {
    this.h = v
    this.px = new Uint8ClampedArray(this.w * this.h * 4)
  }
  getContext(type: string): unknown {
    if (type !== 'webgl2') return null
    made.webgl2++
    if (!glAvailable) return null
    lastGl = new FakeGl(this)
    return glProxy(lastGl)
  }
}

vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
vi.stubGlobal('HTMLCanvasElement', FakeCanvas)
vi.stubGlobal('OffscreenCanvas', FakeGlCanvas)
vi.stubGlobal('Path2D', class {})

// The camera's person masks: a frame carries its own (as the export prepares them).
const MASK = { pixels: { width: 4, height: 4, data: new Uint8ClampedArray(64) } }
vi.mock('../src/renderer/src/render/segmentation/cameraMasks', () => ({
  maskOf: (image: { mask?: unknown }) => image.mask,
  livePicture: () => null,
  releaseLivePicture: () => undefined
}))

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const LAYER = '../src/renderer/src/render/gradeLayer'
const WEBCAM = '../src/renderer/src/render/webcamLayer'
interface FrameImage {
  image: unknown
  width: number
  height: number
}
interface GradeLayer {
  gradeBackend(): 'gl' | 'cpu'
  gradeBackendReason(): string | null
  gradeScreen(target: unknown, frame: FrameImage, grade: ColorGrade | undefined, lut: CubeLut | null, compare?: boolean): FrameImage
  gradeCamera(target: unknown, frame: FrameImage, grade: ColorGrade | undefined, lut: CubeLut | null, compare?: boolean): FrameImage
  releaseGrade(target: unknown): void
  forceGradeBackend(b: 'gl' | 'cpu' | null): void
  selfTestPattern(): Uint8ClampedArray
  selfTestDiff(want: Uint8ClampedArray, got: Uint8ClampedArray): number
  FRAGMENT_SOURCE: string
}
const FRAGMENT = ((await import(/* @vite-ignore */ LAYER)) as GradeLayer).FRAGMENT_SOURCE

/** A fresh gradeLayer (its backend not chosen yet). */
async function fresh(): Promise<GradeLayer> {
  vi.resetModules()
  return (await import(/* @vite-ignore */ LAYER)) as GradeLayer
}

/** A 2D canvas holding `px` (w × h), as the crop's copy is. */
function pictureCanvas(px: Uint8ClampedArray, w: number, h: number): FakeCanvas {
  const c = new FakeCanvas()
  c.width = w
  c.height = h
  c.px.set(px)
  return c
}

/** 48 × 20 pixels that differ everywhere (and top to bottom). */
function picture(w = 48, h = 20): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) px.set([(x * 5 + y) & 255, (y * 12 + x) & 255, (x * y * 3 + 40) & 255, 255], (y * w + x) * 4)
  return px
}

/** The pixels a graded FrameImage holds. */
const pixelsOf = (f: FrameImage): Uint8ClampedArray => (f.image as FakeCanvas).px

/** The reference: each pixel through gradePixel. */
function reference(px: Uint8ClampedArray, colour: ColorGrade, which: 'screen' | 'camera', lut: CubeLut | null = null): Uint8ClampedArray {
  const g = resolveGrade(colour, which)!
  const t = gradeTable(g)
  const out = px.slice()
  for (let p = 0; p < px.length; p += 4) out.set(gradePixel([px[p], px[p + 1], px[p + 2]], g, t, lut), p)
  return out
}

const target = (): unknown => new FakeCanvas().getContext('2d')
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  made = { canvases: 0, offscreen: 0, webgl2: 0 }
  glAvailable = true
  spoil = null
  lastGl = null
  loseOnDraw = false
  draws.length = 0
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => warn.mockRestore())

describe('the grade layer (test 56)', () => {
  it('returns the picture itself for no grade, a grade that changes nothing, a LUT not loaded, or Compare, and makes no context', async () => {
    const L = await fresh()
    const ctx = target()
    made = { canvases: 0, offscreen: 0, webgl2: 0 }
    const frame = { image: { tag: 'video' }, width: 1280, height: 720 }
    const lutRef = { file: 'lut-1.cube', sha256: 'a'.repeat(64), title: 't', size: 17 }
    for (const g of [undefined, {}, { temperature: 0, lookStrength: 1 }, { look: 'warm' as const, lookStrength: 0 }, { lut: lutRef }]) {
      expect(L.gradeScreen(ctx, frame, g, null), JSON.stringify(g)).toBe(frame)
      expect(L.gradeCamera(ctx, frame, g, null), JSON.stringify(g)).toBe(frame)
    }
    // The screen has no exposure and no warm look.
    expect(L.gradeScreen(ctx, frame, { exposure: 1, look: 'warm' }, null)).toBe(frame)
    // Compare: the picture as recorded.
    expect(L.gradeScreen(ctx, frame, { look: 'vivid' }, null, true)).toBe(frame)
    expect(L.gradeCamera(ctx, frame, { look: 'warm', temperature: 0.3 }, null, true)).toBe(frame)
    expect(made).toEqual({ canvases: 0, offscreen: 0, webgl2: 0 })
  })

  it('grades with the shader as the reference does, reading the copy of a picture that is not a canvas', async () => {
    const L = await fresh()
    const ctx = target()
    const px = picture()
    // A decoded frame (not a canvas): copied 1:1 first, then graded.
    const video = { width: 48, height: 20, px }
    const colour: ColorGrade = { look: 'cinematic', temperature: 0.2, saturation: 0.3 }
    const out = L.gradeCamera(ctx, { image: video, width: 48, height: 20 }, colour, null)
    expect(L.gradeBackend()).toBe('gl')
    expect(out.width).toBe(48)
    expect(out.height).toBe(20)
    expect(Array.from(pixelsOf(out))).toEqual(Array.from(reference(px, colour, 'camera')))
    // The crop's copy (a canvas) goes to the shader as it is.
    const crop = pictureCanvas(px, 48, 20)
    const screen = L.gradeScreen(ctx, { image: crop, width: 48, height: 20 }, { look: 'mono' }, null)
    expect(Array.from(pixelsOf(screen))).toEqual(Array.from(reference(px, { look: 'mono' }, 'screen')))
    // The same target keeps one result per source.
    expect(L.gradeScreen(ctx, { image: crop, width: 48, height: 20 }, { look: 'vivid' }, null).image).toBe(screen.image)
    expect(screen.image).not.toBe(out.image)
  })

  it('reads a LUT and its shaper as the reference does', async () => {
    const L = await fresh()
    const n = 9
    const data = new Float32Array(n ** 3 * 3)
    for (let i = 0, b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++, i += 3) data.set([b / (n - 1), (g / (n - 1)) ** 2, r / (n - 1)], i)
    const sd = new Float32Array(700 * 3)
    for (let i = 0; i < 700; i++) for (let c = 0; c < 3; c++) sd[i * 3 + c] = (i / 699) ** (0.8 + 0.1 * c)
    const lut: CubeLut = { title: '', size: n, data, shaper: { size: 700, data: sd, min: -0.05, max: 1.1 }, domainMin: [0, 0.05, 0], domainMax: [1, 0.95, 1.2] }
    const px = picture()
    const colour: ColorGrade = { contrast: 0.2, lut: { file: 'lut-1.cube', sha256: 'a'.repeat(64), title: 't', size: n, strength: 0.8 } }
    const out = L.gradeScreen(target(), { image: pictureCanvas(px, 48, 20), width: 48, height: 20 }, colour, lut)
    expect(L.gradeBackend()).toBe('gl')
    expect(Array.from(pixelsOf(out))).toEqual(Array.from(reference(px, colour, 'screen', lut)))
  })

  it('chooses the backend once', async () => {
    const L = await fresh()
    const ctx = target()
    const frame = { image: pictureCanvas(picture(), 48, 20), width: 48, height: 20 }
    for (let i = 0; i < 5; i++) {
      L.gradeScreen(ctx, frame, { look: 'vivid' }, null)
      L.gradeCamera(ctx, frame, { look: 'warm' }, null)
      expect(L.gradeBackend()).toBe('gl')
    }
    expect(made.offscreen).toBe(1)
    expect(made.webgl2).toBe(1)
    // Its self-test and the ten pictures were drawn on the one context.
    expect(lastGl!.draws).toBe(8 + 10)
  })

  it('without WebGL2 grades on the CPU, for the session, and says why', async () => {
    glAvailable = false
    const L = await fresh()
    const px = picture()
    const out = L.gradeScreen(target(), { image: pictureCanvas(px, 48, 20), width: 48, height: 20 }, { look: 'natural' }, null)
    expect(L.gradeBackend()).toBe('cpu')
    expect(L.gradeBackendReason()).toBe('no WebGL2 context')
    expect(warn).toHaveBeenCalledWith('Colour grading uses the CPU: no WebGL2 context')
    const want = px.slice()
    const g = resolveGrade({ look: 'natural' }, 'screen')!
    gradePixelsCpu(want, g, gradeTable(g), null)
    expect(Array.from(pixelsOf(out))).toEqual(Array.from(want))
    glAvailable = true
    L.gradeScreen(target(), { image: pictureCanvas(px, 48, 20), width: 48, height: 20 }, { look: 'natural' }, null)
    expect(made.webgl2).toBe(1)
  })

  it('a lost context is made again; one that cannot be switches the session to the CPU path', async () => {
    const L = await fresh()
    const ctx = target()
    const px = picture()
    const frame = { image: pictureCanvas(px, 48, 20), width: 48, height: 20 }
    L.gradeScreen(ctx, frame, { look: 'vivid' }, null)
    expect(L.gradeBackend()).toBe('gl')
    // Lost, and made again: still the shader.
    lastGl!.lost = true
    const again = L.gradeScreen(ctx, frame, { look: 'vivid' }, null)
    expect(made.webgl2).toBe(2)
    expect(L.gradeBackend()).toBe('gl')
    expect(Array.from(pixelsOf(again))).toEqual(Array.from(reference(px, { look: 'vivid' }, 'screen')))
    // Lost while drawing: drawn again on a new context, the same picture.
    loseOnDraw = true
    const redrawn = L.gradeScreen(ctx, frame, { look: 'vivid' }, null)
    expect(made.webgl2).toBe(3)
    expect(redrawn.image).toBe(again.image)
    expect(Array.from(pixelsOf(redrawn))).toEqual(Array.from(reference(px, { look: 'vivid' }, 'screen')))
    // Lost, and no context to be had: the CPU path from now on, preview and export alike.
    lastGl!.lost = true
    glAvailable = false
    const cpu = L.gradeScreen(ctx, frame, { look: 'vivid' }, null)
    expect(L.gradeBackend()).toBe('cpu')
    expect(L.gradeBackendReason()).toMatch(/lost/)
    expect(warn).toHaveBeenCalledWith('Colour grading uses the CPU: the WebGL2 context was lost and could not be made again')
    const want = px.slice()
    const g = resolveGrade({ look: 'vivid' }, 'screen')!
    gradePixelsCpu(want, g, gradeTable(g), null)
    expect(Array.from(pixelsOf(cpu))).toEqual(Array.from(want))
    const tries = made.webgl2
    L.gradeScreen(ctx, frame, { look: 'vivid' }, null)
    expect(made.webgl2).toBe(tries)
  })

  it('forceGradeBackend picks the CPU path without asking for a context', async () => {
    const L = await fresh()
    L.forceGradeBackend('cpu')
    L.gradeScreen(target(), { image: pictureCanvas(picture(), 48, 20), width: 48, height: 20 }, { look: 'mono' }, null)
    expect(L.gradeBackend()).toBe('cpu')
    expect(made.webgl2).toBe(0)
    L.forceGradeBackend(null)
  })

  it('releaseGrade lets go of a target’s copies', async () => {
    const L = await fresh()
    const ctx = target()
    const out = L.gradeScreen(ctx, { image: { width: 48, height: 20, px: picture() }, width: 48, height: 20 }, { look: 'vivid' }, null)
    const canvas = out.image as FakeCanvas
    expect(canvas.width).toBe(48)
    L.releaseGrade(ctx)
    expect(canvas.width).toBe(0)
    // A later picture gets new copies.
    expect(L.gradeScreen(ctx, { image: { width: 48, height: 20, px: picture() }, width: 48, height: 20 }, { look: 'vivid' }, null).image).not.toBe(canvas)
  })
})

describe('the shader and its self-test (test 81)', () => {
  it('reads the picture’s row H − 1 − y and each shaper entry at shaperTexel(i)', () => {
    expect(FRAGMENT).toContain('ivec2 at = ivec2(int(gl_FragCoord.x), H - 1 - int(gl_FragCoord.y));')
    expect(FRAGMENT).toContain('texelFetch(shaper, ivec2(i % 256, i / 256), 0)')
    // Every texture is fetched, never filtered.
    expect(FRAGMENT).not.toMatch(/\btexture\(/)
    expect(FRAGMENT.match(/= corner\(i/g)).toHaveLength(8)
  })

  it('a self-test result flipped top to bottom fails, and the CPU path is chosen with its reason logged', async () => {
    const L = await fresh()
    const want = L.selfTestPattern()
    const flipped = want.slice()
    for (let y = 0; y < 64; y++) flipped.set(want.subarray((63 - y) * 256, (64 - y) * 256), y * 256)
    expect(L.selfTestDiff(want, want)).toBe(0)
    expect(L.selfTestDiff(want, flipped)).toBeGreaterThan(1000)
    // A one-level difference passes; alpha is not counted.
    const near = want.map((v, i) => (i % 4 === 3 ? 0 : Math.min(255, v + 1)))
    expect(L.selfTestDiff(want, near)).toBe(0)

    // A driver that flips what it draws.
    spoil = (px, w, h) => {
      const copy = px.slice()
      for (let y = 0; y < h; y++) px.set(copy.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
    }
    const px = picture()
    const out = L.gradeScreen(target(), { image: pictureCanvas(px, 48, 20), width: 48, height: 20 }, { look: 'vivid' }, null)
    expect(L.gradeBackend()).toBe('cpu')
    expect(L.gradeBackendReason()).toMatch(/^the self-test differed in [\d,]+ values$/)
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([expect.stringMatching(/^Colour grading uses the CPU: the self-test differed in [\d,]+ values$/)])
    // And the picture is graded right anyway, on the CPU.
    const g = resolveGrade({ look: 'vivid' }, 'screen')!
    const cpu = px.slice()
    gradePixelsCpu(cpu, g, gradeTable(g), null)
    expect(Array.from(pixelsOf(out))).toEqual(Array.from(cpu))
  })

  it('a driver one level off in places still passes the self-test', async () => {
    spoil = (px) => {
      for (let i = 0; i < px.length; i += 97) if (i % 4 !== 3) px[i] = Math.min(255, px[i] + 1)
    }
    const L = await fresh()
    L.gradeScreen(target(), { image: pictureCanvas(picture(), 48, 20), width: 48, height: 20 }, { look: 'warm', tint: 0.2 }, null)
    expect(L.gradeBackend()).toBe('gl')
    expect(L.gradeBackendReason()).toBeNull()
  })
})

describe('the camera’s blur composite (test 56)', () => {
  function project(colour: ColorGrade): Project {
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
    return { ...p, grade: { camera: colour } }
  }

  it('is made again for a new raw frame or a new grade, and only then', async () => {
    const L = await fresh()
    L.forceGradeBackend('cpu')
    const { drawWebcamLayer } = (await import(/* @vite-ignore */ WEBCAM)) as { drawWebcamLayer(fc: unknown, camera: unknown): void }
    const ctx = target()
    const frame = (tag: string) => ({ image: { tag, mask: MASK, width: 32, height: 18, px: new Uint8ClampedArray(32 * 18 * 4).fill(120) }, width: 32, height: 18 })
    /** How many times the blurred background and the sharp person were put together. */
    const composed = (): number => draws.filter((d) => d.op === 'destination-in').length
    const draw = (colour: ColorGrade, camera: unknown, compare = false): void =>
      drawWebcamLayer({ ctx, project: project(colour), w: 1920, h: 1080, k: 1, vw: 1920, vh: 1080, t: 1, scene: { compare }, following: false }, camera)
    const a = frame('a')
    draw({ look: 'warm' }, a)
    expect(composed()).toBe(1)
    // The graded picture is one canvas reused for every frame: the same raw frame and grade make nothing again.
    draw({ look: 'warm' }, a)
    expect(composed()).toBe(1)
    // Another grade on the same raw frame: made again.
    draw({ look: 'cool' }, a)
    expect(composed()).toBe(2)
    // Another raw frame with the same grade: made again.
    const b = frame('b')
    draw({ look: 'cool' }, b)
    expect(composed()).toBe(3)
    draw({ look: 'cool' }, b)
    expect(composed()).toBe(3)
    // Compare: the raw frame without its colour, made once.
    draw({ look: 'cool' }, b, true)
    expect(composed()).toBe(4)
    draw({ look: 'cool' }, b, true)
    expect(composed()).toBe(4)
    L.forceGradeBackend(null)
  })
})
