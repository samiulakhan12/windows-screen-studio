/**
 * Grading the screen and the camera (docs/design/editing-polish.md §9.1, §9.3): one WebGL2 shader,
 * or the same maths on the CPU, applied to each source picture before it is drawn. drawFrame
 * calls gradeScreen right after the crop copy, and the webcam layer calls gradeCamera after the
 * person mask was looked up; captions, the background and the overlays are never graded.
 *
 * - Without a grade (every project from before), with a grade that changes nothing, or with the
 *   preview's Compare pressed, the picture is returned as it came: nothing is copied and no WebGL
 *   context is made.
 * - The shader's input is always a 2D canvas (the crop's copy, or a copy made here), so the
 *   graded bytes are those of the picture the ungraded path would draw, in the preview (a
 *   <video>) and the export (a VideoFrame) alike.
 * - One WebGL2 context for the app, on an OffscreenCanvas, chosen once per session after a
 *   self-test: a 64 × 64 pattern that differs top to bottom, graded under every look with a 17³
 *   LUT and a 1,024-entry shaper, must match the CPU path within one level. Otherwise (no WebGL2,
 *   a GPU-blocklisted PC, a wrong result, or a lost context that cannot be made again) the CPU
 *   path grades the preview and the export alike, and the log says why.
 * - Never 'display-p3': the 2D canvases, the drawing buffer and the unpacking are sRGB bytes.
 */
import { effectiveGrade, gradePixelsCpu, gradeTable, resolveGrade, type ResolvedGrade } from '../../../shared/render/colorGrade'
import type { CubeLut } from '../../../shared/render/cubeLut'
import { LOOKS } from '../../../shared/render/looks'
import type { ColorGrade } from '../../../shared/types'
import type { FrameImage } from './compositor'

type Ctx = CanvasRenderingContext2D
type Which = 'screen' | 'camera'
type Backend = 'gl' | 'cpu'

/* ---------- the shader ---------- */

/** One triangle covering the viewport, from gl_VertexID alone (no buffers). */
export const VERTEX_SOURCE = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`

/**
 * The grade, as colorGrade.ts's gradePixel: stages 1–6 from the per-channel table, saturation and
 * vibrance by the input's saturation, split toning by the encoded luminance, the encoding, then the
 * LUT (its shaper, its domain, tetrahedral from eight texelFetches) mixed by its strength. Every
 * texture is read with texelFetch (no filtering). Row 0 of the picture is its top row, row 0 of
 * gl_FragCoord the bottom: the picture's row is H − 1 − y.
 */
export const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D pic;
uniform sampler2D table;
uniform highp sampler3D lut;
uniform sampler2D shaper;
uniform int H;
uniform int crossing;
uniform float S0;
uniform float vib;
uniform float kS;
uniform float kH;
uniform int lutN;
uniform float lutMix;
uniform vec3 dMin;
uniform vec3 dScale;
uniform int shaperN;
uniform float sMin;
uniform float sScale;
out vec4 o;

const vec3 W = vec3(0.2126, 0.7152, 0.0722);
const vec3 TEAL = vec3(-0.4298, 0.0702, 0.5702);

float enc1(float l) {
  l = clamp(l, 0.0, 1.0);
  return l <= 0.0031308 ? l * 12.92 : 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}

// Entry i of the shaper is at (i % 256, i / 256): shaperTexel in colorGrade.ts.
vec4 entry(int i) {
  return texelFetch(shaper, ivec2(i % 256, i / 256), 0);
}

vec2 between(float v) {
  float t = clamp((v - sMin) * sScale, 0.0, 1.0) * float(shaperN - 1);
  int i = min(int(floor(t)), shaperN - 2);
  return vec2(float(i), t - float(i));
}

vec3 shape(vec3 e) {
  vec2 r = between(e.r);
  vec2 g = between(e.g);
  vec2 b = between(e.b);
  float sr = mix(entry(int(r.x)).r, entry(int(r.x) + 1).r, r.y);
  float sg = mix(entry(int(g.x)).g, entry(int(g.x) + 1).g, g.y);
  float sb = mix(entry(int(b.x)).b, entry(int(b.x) + 1).b, b.y);
  return vec3(sr, sg, sb);
}

vec3 corner(ivec3 p) {
  return texelFetch(lut, p, 0).rgb;
}

vec3 tetrahedral(vec3 x) {
  vec3 t = x * float(lutN - 1);
  ivec3 i = min(ivec3(floor(t)), ivec3(lutN - 2));
  vec3 f = t - vec3(i);
  vec3 c000 = corner(i);
  vec3 c100 = corner(i + ivec3(1, 0, 0));
  vec3 c010 = corner(i + ivec3(0, 1, 0));
  vec3 c001 = corner(i + ivec3(0, 0, 1));
  vec3 c110 = corner(i + ivec3(1, 1, 0));
  vec3 c101 = corner(i + ivec3(1, 0, 1));
  vec3 c011 = corner(i + ivec3(0, 1, 1));
  vec3 c111 = corner(i + ivec3(1, 1, 1));
  if (f.r > f.g) {
    if (f.g > f.b) return (1.0 - f.r) * c000 + (f.r - f.g) * c100 + (f.g - f.b) * c110 + f.b * c111;
    if (f.r > f.b) return (1.0 - f.r) * c000 + (f.r - f.b) * c100 + (f.b - f.g) * c101 + f.g * c111;
    return (1.0 - f.b) * c000 + (f.b - f.r) * c001 + (f.r - f.g) * c101 + f.g * c111;
  }
  if (f.b > f.g) return (1.0 - f.b) * c000 + (f.b - f.g) * c001 + (f.g - f.r) * c011 + f.r * c111;
  if (f.b > f.r) return (1.0 - f.g) * c000 + (f.g - f.b) * c010 + (f.b - f.r) * c011 + f.r * c111;
  return (1.0 - f.g) * c000 + (f.g - f.r) * c010 + (f.r - f.b) * c110 + f.b * c111;
}

void main() {
  ivec2 at = ivec2(int(gl_FragCoord.x), H - 1 - int(gl_FragCoord.y));
  vec3 e8 = texelFetch(pic, at, 0).rgb;
  ivec3 k = ivec3(round(e8 * 255.0));
  vec3 c = vec3(texelFetch(table, ivec2(k.r, 0), 0).r, texelFetch(table, ivec2(k.g, 0), 0).g, texelFetch(table, ivec2(k.b, 0), 0).b);
  if (crossing == 1) {
    float Y = dot(W, c);
    if (S0 != 1.0 || vib != 0.0) {
      float mx = max(max(e8.r, e8.g), e8.b);
      float sat = mx > 0.0 ? (mx - min(min(e8.r, e8.g), e8.b)) / mx : 0.0;
      float S = S0 * (1.0 + vib * (1.0 - sat) * (1.0 - sat));
      c = max(vec3(0.0), vec3(Y) + (c - vec3(Y)) * S);
    }
    if (kS != 0.0 || kH != 0.0) {
      float y = enc1(Y);
      c += (kS * (1.0 - y) * (1.0 - y) - kH * y * y) * TEAL;
    }
  }
  vec3 e = vec3(enc1(c.r), enc1(c.g), enc1(c.b));
  if (lutN > 0) {
    vec3 s = e;
    if (shaperN > 0) s = shape(e);
    vec3 m = tetrahedral(clamp((s - dMin) * dScale, 0.0, 1.0));
    e = e + (m - e) * lutMix;
  }
  o = vec4(clamp(e, 0.0, 1.0), 1.0);
}`

/* ---------- the self-test ---------- */

export const SELF_TEST_SIZE = 64

/** 64 × 64 RGBA: red across, green a vertical ramp (so a picture flipped top to bottom differs), blue mixed. */
export function selfTestPattern(): Uint8ClampedArray {
  const n = SELF_TEST_SIZE
  const px = new Uint8ClampedArray(n * n * 4)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4
      px[o] = (x * 4 + (y & 3)) & 255
      px[o + 1] = y * 4 + (x & 3)
      px[o + 2] = (x * 7 + y * 13) & 255
      px[o + 3] = 255
    }
  }
  return px
}

/** The self-test's LUT: a 17³ table that moves every colour, after a 1,024-entry shaper. */
export function selfTestLut(): CubeLut {
  const n = 17
  const data = new Float32Array(n * n * n * 3)
  let k = 0
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const [R, G, B] = [r / (n - 1), g / (n - 1), b / (n - 1)]
        data[k++] = 0.1 + 0.8 * G ** 1.2
        data[k++] = B
        data[k++] = 0.5 * (R + B)
      }
    }
  }
  const s = 1024
  const shaper = new Float32Array(s * 3)
  for (let i = 0; i < s; i++) for (let c = 0; c < 3; c++) shaper[i * 3 + c] = (i / (s - 1)) ** (0.9 + c * 0.05)
  return { title: 'self-test', size: n, data, shaper: { size: s, data: shaper, min: 0, max: 1 }, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

/** The grades the self-test runs: every look, each with the LUT at 75 %. */
export function selfTestGrades(): ResolvedGrade[] {
  return LOOKS.map((l) => ({ ...resolveGrade({ look: l.id }, 'camera')!, lutStrength: 0.75 }))
}

/** How many colour values of `got` are more than one level from `want` (alpha is not counted). */
export function selfTestDiff(want: Uint8ClampedArray, got: Uint8ClampedArray): number {
  let n = 0
  for (let i = 0; i < want.length; i++) if (i % 4 !== 3 && Math.abs(want[i] - (got[i] ?? -9)) > 1) n++
  return n
}

/* ---------- the backend ---------- */

let forced: Backend | null = null
let chosen: Backend | null = null
let reason: string | null = null
const listeners = new Set<() => void>()

const hasDom = (): boolean => typeof document !== 'undefined'

/** Chooses the CPU path for the rest of the session, saying why. */
function useCpu(why: string): void {
  chosen = 'cpu'
  reason = why
  releaseGl()
  console.warn(`Colour grading uses the CPU: ${why}`)
  for (const cb of [...listeners]) cb()
}

/** The backend grading every picture this session (decided at the first grade). */
export function gradeBackend(): Backend {
  if (forced) return forced
  if (chosen) return chosen
  const made = makeGl()
  if (!made) {
    useCpu('no WebGL2 context')
    return 'cpu'
  }
  gl = made
  const off = selfTest(made)
  if (off === null) useCpu('the self-test could not run')
  else if (off > 0) useCpu(`the self-test differed in ${off.toLocaleString('en-US')} values`)
  else {
    chosen = 'gl'
    for (const cb of [...listeners]) cb()
  }
  return chosen!
}

/** Why the CPU path is used, or null (WebGL2, or not decided yet). */
export function gradeBackendReason(): string | null {
  return forced === 'cpu' ? 'chosen for this test' : chosen === 'cpu' ? reason : null
}

/** Calls `cb` when the backend is chosen or changes; returns the function that stops it. */
export function onGradeBackend(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Tests and e2e only: the backend to use (null: choose). */
export function forceGradeBackend(b: Backend | null): void {
  forced = b
}

/* ---------- WebGL2 ---------- */

interface Unit {
  pic: WebGLTexture
  picW: number
  picH: number
  table: WebGLTexture
  tableKey: string
  lut: WebGLTexture
  lutOf: CubeLut | null
  shaper: WebGLTexture
  shaperOf: CubeLut | null
}

interface GlState {
  canvas: OffscreenCanvas | HTMLCanvasElement
  gl: WebGL2RenderingContext
  program: WebGLProgram
  loc: (name: string) => WebGLUniformLocation | null
  units: Map<string, Unit>
}

let gl: GlState | null = null

const CONTEXT: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: false
}

/** The drawing buffer grows in steps of this many pixels, so alternating sizes rarely reallocate it. */
const GROW = 64

function compile(c: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const s = c.createShader(type)
  if (!s) return null
  c.shaderSource(s, source)
  c.compileShader(s)
  if (c.getShaderParameter(s, c.COMPILE_STATUS)) return s
  console.warn('Colour grading shader:', c.getShaderInfoLog(s))
  c.deleteShader(s)
  return null
}

/** The app's WebGL2 context with the grade's program, or null when WebGL2 cannot be had. */
function makeGl(): GlState | null {
  if (!hasDom()) return null
  let canvas: OffscreenCanvas | HTMLCanvasElement
  try {
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(GROW, GROW) : Object.assign(document.createElement('canvas'), { width: GROW, height: GROW })
  } catch {
    return null
  }
  let c: WebGL2RenderingContext | null = null
  try {
    c = canvas.getContext('webgl2', CONTEXT) as WebGL2RenderingContext | null
  } catch {
    c = null
  }
  if (!c) return null
  const vs = compile(c, c.VERTEX_SHADER, VERTEX_SOURCE)
  const fs = compile(c, c.FRAGMENT_SHADER, FRAGMENT_SOURCE)
  const program = c.createProgram()
  if (!vs || !fs || !program) {
    c.getExtension('WEBGL_lose_context')?.loseContext()
    return null
  }
  c.attachShader(program, vs)
  c.attachShader(program, fs)
  c.linkProgram(program)
  if (!c.getProgramParameter(program, c.LINK_STATUS)) {
    console.warn('Colour grading program:', c.getProgramInfoLog(program))
    c.getExtension('WEBGL_lose_context')?.loseContext()
    return null
  }
  c.useProgram(program)
  // sRGB bytes in and out, never converted, flipped or premultiplied.
  if ('drawingBufferColorSpace' in c) (c as { drawingBufferColorSpace: string }).drawingBufferColorSpace = 'srgb'
  if ('unpackColorSpace' in c) (c as { unpackColorSpace: string }).unpackColorSpace = 'srgb'
  c.pixelStorei(c.UNPACK_COLORSPACE_CONVERSION_WEBGL, c.NONE)
  c.pixelStorei(c.UNPACK_FLIP_Y_WEBGL, false)
  c.pixelStorei(c.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  c.pixelStorei(c.UNPACK_ALIGNMENT, 1)
  c.disable(c.BLEND)
  c.disable(c.DITHER)
  const cache = new Map<string, WebGLUniformLocation | null>()
  const loc = (name: string): WebGLUniformLocation | null => {
    if (!cache.has(name)) cache.set(name, c!.getUniformLocation(program, name))
    return cache.get(name)!
  }
  // Texture units: the picture 0, the table 1, the LUT 2 (3D), the shaper 3.
  c.uniform1i(loc('pic'), 0)
  c.uniform1i(loc('table'), 1)
  c.uniform1i(loc('lut'), 2)
  c.uniform1i(loc('shaper'), 3)
  return { canvas, gl: c, program, loc, units: new Map() }
}

function releaseGl(): void {
  if (!gl) return
  gl.gl.getExtension('WEBGL_lose_context')?.loseContext()
  gl.canvas.width = gl.canvas.height = 0
  gl = null
}

/** An unfiltered texture (texelFetch only: float textures are complete with NEAREST, without mipmaps). */
function texture(c: WebGL2RenderingContext, target: number): WebGLTexture {
  const t = c.createTexture()!
  c.bindTexture(target, t)
  c.texParameteri(target, c.TEXTURE_MIN_FILTER, c.NEAREST)
  c.texParameteri(target, c.TEXTURE_MAG_FILTER, c.NEAREST)
  c.texParameteri(target, c.TEXTURE_WRAP_S, c.CLAMP_TO_EDGE)
  c.texParameteri(target, c.TEXTURE_WRAP_T, c.CLAMP_TO_EDGE)
  if (target === c.TEXTURE_3D) c.texParameteri(target, c.TEXTURE_WRAP_R, c.CLAMP_TO_EDGE)
  return t
}

function unitOf(s: GlState, name: string): Unit {
  let u = s.units.get(name)
  if (!u) {
    const c = s.gl
    u = { pic: texture(c, c.TEXTURE_2D), picW: 0, picH: 0, table: texture(c, c.TEXTURE_2D), tableKey: '', lut: texture(c, c.TEXTURE_3D), lutOf: null, shaper: texture(c, c.TEXTURE_2D), shaperOf: null }
    s.units.set(name, u)
  }
  return u
}

function dropUnit(s: GlState, name: string): void {
  const u = s.units.get(name)
  if (!u) return
  for (const t of [u.pic, u.table, u.lut, u.shaper]) s.gl.deleteTexture(t)
  s.units.delete(name)
}

/** Stages 1–6 depend on these only: the table is made again when they change. */
const tableKey = (g: ResolvedGrade): string => [g.temperature, g.tint, g.exposure, g.brightness, g.contrast, g.highlights, g.shadows, g.fade].join(',')

const tables = new Map<string, Float32Array>()
function tableOf(g: ResolvedGrade): Float32Array {
  const key = tableKey(g)
  let t = tables.get(key)
  if (!t) {
    t = gradeTable(g)
    if (tables.size >= 8) tables.delete(tables.keys().next().value!)
    tables.set(key, t)
  }
  return t
}

/** RGBA texels of the table: red, green and blue of code i at (i, 0). */
function tableTexels(t: Float32Array): Float32Array {
  const out = new Float32Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    out[i * 4] = t[i]
    out[i * 4 + 1] = t[256 + i]
    out[i * 4 + 2] = t[512 + i]
    out[i * 4 + 3] = 1
  }
  return out
}

/** Grades `source` (a 2D canvas, w × h) with the shader into `out` (made w × h); false when WebGL failed. */
function glDraw(s: GlState, unitName: string, source: TexImageSource, w: number, h: number, g: ResolvedGrade, table: Float32Array, lut: CubeLut | null, out: HTMLCanvasElement | OffscreenCanvas): boolean {
  const c = s.gl
  if (c.isContextLost()) return false
  const u = unitOf(s, unitName)
  // The picture.
  c.activeTexture(c.TEXTURE0)
  c.bindTexture(c.TEXTURE_2D, u.pic)
  if (u.picW === w && u.picH === h) c.texSubImage2D(c.TEXTURE_2D, 0, 0, 0, c.RGBA, c.UNSIGNED_BYTE, source)
  else {
    c.texImage2D(c.TEXTURE_2D, 0, c.RGBA8, c.RGBA, c.UNSIGNED_BYTE, source)
    u.picW = w
    u.picH = h
  }
  // The per-channel table.
  c.activeTexture(c.TEXTURE1)
  c.bindTexture(c.TEXTURE_2D, u.table)
  const key = tableKey(g)
  if (u.tableKey !== key) {
    c.texImage2D(c.TEXTURE_2D, 0, c.RGBA32F, 256, 1, 0, c.RGBA, c.FLOAT, tableTexels(table))
    u.tableKey = key
  }
  // The LUT and its shaper (uploaded once per LUT).
  c.activeTexture(c.TEXTURE2)
  c.bindTexture(c.TEXTURE_3D, u.lut)
  if (lut && u.lutOf !== lut) {
    const n = lut.size
    const texels = new Float32Array(n * n * n * 4)
    for (let i = 0, j = 0; i < lut.data.length; i += 3, j += 4) {
      texels[j] = lut.data[i]
      texels[j + 1] = lut.data[i + 1]
      texels[j + 2] = lut.data[i + 2]
      texels[j + 3] = 1
    }
    c.texImage3D(c.TEXTURE_3D, 0, c.RGBA32F, n, n, n, 0, c.RGBA, c.FLOAT, texels)
    u.lutOf = lut
  }
  c.activeTexture(c.TEXTURE3)
  c.bindTexture(c.TEXTURE_2D, u.shaper)
  if (lut?.shaper && u.shaperOf !== lut) {
    const n = lut.shaper.size
    const rows = Math.ceil(n / 256)
    const texels = new Float32Array(256 * rows * 4)
    for (let i = 0; i < n; i++) {
      texels[i * 4] = lut.shaper.data[i * 3]
      texels[i * 4 + 1] = lut.shaper.data[i * 3 + 1]
      texels[i * 4 + 2] = lut.shaper.data[i * 3 + 2]
      texels[i * 4 + 3] = 1
    }
    c.texImage2D(c.TEXTURE_2D, 0, c.RGBA32F, 256, rows, 0, c.RGBA, c.FLOAT, texels)
    u.shaperOf = lut
  }
  // The grade's numbers.
  const L = s.loc
  const crossing = g.saturation !== 0 || g.vibrance !== 0 || g.split.kS !== 0 || g.split.kH !== 0
  c.uniform1i(L('H'), h)
  c.uniform1i(L('crossing'), crossing ? 1 : 0)
  c.uniform1f(L('S0'), 1 + g.saturation)
  c.uniform1f(L('vib'), g.vibrance)
  c.uniform1f(L('kS'), g.split.kS)
  c.uniform1f(L('kH'), g.split.kH)
  const useLut = !!lut && g.lutStrength > 0
  c.uniform1i(L('lutN'), useLut ? lut!.size : 0)
  c.uniform1f(L('lutMix'), useLut ? g.lutStrength : 0)
  if (useLut) {
    const d = lut!
    c.uniform3f(L('dMin'), d.domainMin[0], d.domainMin[1], d.domainMin[2])
    c.uniform3f(L('dScale'), 1 / (d.domainMax[0] - d.domainMin[0]), 1 / (d.domainMax[1] - d.domainMin[1]), 1 / (d.domainMax[2] - d.domainMin[2]))
    c.uniform1i(L('shaperN'), d.shaper ? d.shaper.size : 0)
    c.uniform1f(L('sMin'), d.shaper ? d.shaper.min : 0)
    c.uniform1f(L('sScale'), d.shaper ? 1 / (d.shaper.max - d.shaper.min) : 1)
  } else c.uniform1i(L('shaperN'), 0)
  // Drawn at the bottom left of a buffer that only grows, then copied out in this same task.
  const cw = Math.max(s.canvas.width, Math.ceil(w / GROW) * GROW)
  const ch = Math.max(s.canvas.height, Math.ceil(h / GROW) * GROW)
  if (s.canvas.width !== cw || s.canvas.height !== ch) {
    s.canvas.width = cw
    s.canvas.height = ch
  }
  c.viewport(0, 0, w, h)
  c.drawArrays(c.TRIANGLES, 0, 3)
  if (c.isContextLost()) return false
  if (out.width !== w || out.height !== h) {
    out.width = w
    out.height = h
  }
  const o = out.getContext('2d', { alpha: false }) as Ctx | OffscreenCanvasRenderingContext2D | null
  if (!o) return false
  o.imageSmoothingEnabled = false
  o.globalCompositeOperation = 'copy'
  // The buffer's bottom h rows are the picture (the canvas's rows ch − h .. ch − 1, top down).
  o.drawImage(s.canvas, 0, s.canvas.height - h, w, h, 0, 0, w, h)
  o.globalCompositeOperation = 'source-over'
  return true
}

/** A 2D canvas of the document (or an OffscreenCanvas), w × h. */
function canvas2d(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** Grades the self-test pattern under every look with the shader: how many values differ from the CPU path, or null when it could not run. */
function selfTest(s: GlState): number | null {
  try {
    const n = SELF_TEST_SIZE
    const px = selfTestPattern()
    const src = canvas2d(n, n)
    const sctx = src.getContext('2d', { alpha: false, willReadFrequently: true })
    if (!sctx) return null
    const img = sctx.createImageData(n, n)
    img.data.set(px)
    sctx.putImageData(img, 0, 0)
    const lut = selfTestLut()
    const out = canvas2d(n, n)
    let off = 0
    for (const g of selfTestGrades()) {
      const table = gradeTable(g)
      const want = px.slice()
      gradePixelsCpu(want, g, table, lut)
      if (!glDraw(s, 'self-test', src, n, n, g, table, lut, out)) return null
      const octx = out.getContext('2d', { alpha: false })
      if (!octx) return null
      off += selfTestDiff(want, octx.getImageData(0, 0, n, n).data)
    }
    dropUnit(s, 'self-test')
    return off
  } catch (err) {
    console.warn('Colour grading self-test:', err)
    return null
  }
}

/* ---------- grading a picture ---------- */

/** What a target keeps per source: the copy the shader reads, its result, and the CPU path's canvas. */
interface Copies {
  input?: HTMLCanvasElement
  out?: HTMLCanvasElement
  cpu?: HTMLCanvasElement
}
const copies = new WeakMap<Ctx, Partial<Record<Which, Copies>>>()

function copiesOf(target: Ctx, which: Which): Copies {
  let all = copies.get(target)
  if (!all) {
    all = {}
    copies.set(target, all)
  }
  return (all[which] ??= {})
}

/** The picture as a 2D canvas the shader can read exactly: a canvas as it is, anything else copied 1:1. */
function asCanvas(c: Copies, frame: FrameImage, w: number, h: number): HTMLCanvasElement | null {
  if (typeof HTMLCanvasElement !== 'undefined' && frame.image instanceof HTMLCanvasElement && frame.image.width === w && frame.image.height === h) return frame.image
  const input = (c.input ??= document.createElement('canvas'))
  if (input.width !== w || input.height !== h) {
    input.width = w
    input.height = h
  }
  const ctx = input.getContext('2d', { alpha: false })
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(frame.image, 0, 0, w, h)
  return input
}

function gradeOnCpu(c: Copies, frame: FrameImage, w: number, h: number, g: ResolvedGrade, lut: CubeLut | null): FrameImage {
  const work = (c.cpu ??= document.createElement('canvas'))
  if (work.width !== w || work.height !== h) {
    work.width = w
    work.height = h
  }
  const ctx = work.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!ctx) return frame
  ctx.imageSmoothingEnabled = false
  ctx.globalCompositeOperation = 'copy'
  ctx.drawImage(frame.image, 0, 0, w, h)
  ctx.globalCompositeOperation = 'source-over'
  const img = ctx.getImageData(0, 0, w, h)
  gradePixelsCpu(img.data, g, tableOf(g), lut)
  ctx.putImageData(img, 0, 0)
  return { image: work, width: w, height: h }
}

/** The WebGL2 context, made again after a loss; null (and the CPU path from now on) when it cannot be. */
function liveGl(): GlState | null {
  if (gl && !gl.gl.isContextLost()) return gl
  releaseGl()
  const made = makeGl()
  if (made) return (gl = made)
  useCpu('the WebGL2 context was lost and could not be made again')
  return null
}

function grade(which: Which, target: Ctx, frame: FrameImage, colour: ColorGrade | undefined, lut: CubeLut | null, compare: boolean | undefined): FrameImage {
  if (compare || !colour) return frame
  const g = effectiveGrade(resolveGrade(colour, which), lut)
  if (!g || !hasDom()) return frame
  const w = Math.max(1, Math.round(frame.width))
  const h = Math.max(1, Math.round(frame.height))
  const useLut = lut && g.lutStrength > 0 ? lut : null
  const c = copiesOf(target, which)
  if (gradeBackend() === 'gl') {
    // A context lost while drawing is made again once; one that cannot be switches the session to the CPU path.
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = liveGl()
      if (!s) break
      const source = asCanvas(c, frame, w, h)
      const out = (c.out ??= document.createElement('canvas'))
      if (source && glDraw(s, which, source, w, h, g, tableOf(g), useLut, out)) return { image: out, width: w, height: h }
      if (!s.gl.isContextLost()) break
    }
  }
  // The same maths on the CPU (within one level of the shader).
  return gradeOnCpu(c, frame, w, h, g, useLut)
}

/** The screen's picture graded (its input without a grade, or with `compare`). */
export function gradeScreen(target: Ctx, frame: FrameImage, grade_: ColorGrade | undefined, lut: CubeLut | null, compare?: boolean): FrameImage {
  return grade('screen', target, frame, grade_, lut, compare)
}

/** The camera's picture graded (its input without a grade, or with `compare`). */
export function gradeCamera(target: Ctx, frame: FrameImage, grade_: ColorGrade | undefined, lut: CubeLut | null, compare?: boolean): FrameImage {
  return grade('camera', target, frame, grade_, lut, compare)
}

/** Drops the grade's copies kept for `target` (an export or a scratch target that is done). */
export function releaseGrade(target: Ctx): void {
  const all = copies.get(target)
  if (!all) return
  for (const c of Object.values(all)) {
    for (const canvas of [c.input, c.out, c.cpu]) if (canvas) canvas.width = canvas.height = 0
  }
  copies.delete(target)
}
