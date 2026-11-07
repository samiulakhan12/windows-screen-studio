/**
 * The colour maths (docs/design/editing-polish.md §9.2): a grade resolved from its look and
 * sliders, the exact per-channel table, the cross-channel steps and the LUT, as the pure reference
 * the shader (render/gradeLayer.ts) and the CPU path match.
 *
 * Pixels are 8-bit sRGB codes. Stages 1–6 (white balance, exposure, brightness, contrast, shadows
 * and highlights, fade) work on one channel at a time and are baked into a table of 256 linear
 * values per channel, indexed by the input's code, so they carry no interpolation error. Stages
 * 7–9 (saturation and vibrance, split toning, encoding) mix the channels, and stage 10 is the
 * user's LUT on the encoded values, mixed by its strength. The result is clamped and rounded to 8
 * bits, without dither, so the same input always gives the same bytes.
 *
 * A grade that changes nothing (no look, no LUT, every slider 0) resolves to null: it is no grade,
 * and nothing is drawn differently.
 */
import type { ColorGrade } from '../types'
import type { CubeLut } from './cubeLut'
import { EXPOSURE_RANGE } from './gradeData'
import { lookOf, SCREEN_LOOKS, type LookParams } from './looks'

export interface ResolvedGrade {
  temperature: number
  tint: number
  exposure: number
  brightness: number
  contrast: number
  highlights: number
  shadows: number
  fade: number
  saturation: number
  vibrance: number
  split: { kS: number; kH: number }
  lutStrength: number
}

/** Luminance weights of linear sRGB (Rec. 709). */
export const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722]
/** Split toning's shadow colour (its luminance is 0); the highlights get its opposite, orange. */
export const TEAL: readonly [number, number, number] = [-0.4298, 0.0702, 0.5702]
/** Shadows and highlights: the Bernstein bumps' gain (0.14 × 6.75), monotonic for every amount in −1..1. */
export const TONE_GAIN = 0.945
/** Fade lifts black to 0.08 at full strength. */
export const FADE_LIFT = 0.08
/** Steps of the CPU path's encode table (linear 0..1). */
export const ENCODE_STEPS = 4096

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const num = (v: unknown, fallback: number): number => (finite(v) ? v : fallback)
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0)

/** sRGB-encoded (0..1) to linear light. */
export function decodeSrgb(e: number): number {
  return e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4
}

/** Linear light to sRGB-encoded, clamped to 0..1. */
export function encodeSrgb(l: number): number {
  const v = clamp01(l)
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
}

const SLIDERS = ['temperature', 'tint', 'brightness', 'contrast', 'saturation', 'highlights', 'shadows', 'vibrance'] as const

/** True when `g` changes no pixel (every stage at rest). */
function atRest(g: ResolvedGrade): boolean {
  return (
    g.temperature === 0 &&
    g.tint === 0 &&
    g.exposure === 0 &&
    g.brightness === 0 &&
    g.contrast === 0 &&
    g.highlights === 0 &&
    g.shadows === 0 &&
    g.fade === 0 &&
    g.saturation === 0 &&
    g.vibrance === 0 &&
    g.split.kS === 0 &&
    g.split.kH === 0 &&
    g.lutStrength === 0
  )
}

/** The grade's look times its strength plus its sliders, clamped; null: the identity (no grade). */
export function resolveGrade(g: ColorGrade | undefined, which: 'screen' | 'camera'): ResolvedGrade | null {
  if (!g) return null
  // The screen takes only the looks that keep neutrals neutral (the reader drops the others, and so does this).
  const look = g.look && (which === 'camera' || SCREEN_LOOKS.includes(g.look)) ? lookOf(g.look) : null
  const k = look ? clamp01(num(g.lookStrength, 1)) : 0
  const p: LookParams = look?.params ?? {}
  // `+ 0` turns −0 into 0, so a grade is written and compared the same way whatever its signs.
  const slider = (key: (typeof SLIDERS)[number]): number => clamp(num(p[key], 0) * k + num(g[key], 0), -1, 1) + 0
  const r: ResolvedGrade = {
    temperature: slider('temperature'),
    tint: slider('tint'),
    exposure: which === 'camera' ? clamp(num(g.exposure, 0), EXPOSURE_RANGE.min, EXPOSURE_RANGE.max) + 0 : 0,
    brightness: slider('brightness'),
    contrast: slider('contrast'),
    highlights: slider('highlights'),
    shadows: slider('shadows'),
    fade: clamp01(num(p.fade, 0) * k) + 0,
    saturation: slider('saturation'),
    vibrance: slider('vibrance'),
    split: { kS: clamp01(num(p.split?.kS, 0) * k) + 0, kH: clamp01(num(p.split?.kH, 0) * k) + 0 },
    lutStrength: g.lut ? clamp01(num(g.lut.strength, 1)) + 0 : 0
  }
  return atRest(r) ? null : r
}

/**
 * The grade as drawn with `lut` (null while it loads, or when it is missing): without the LUT its
 * strength is 0, and a grade left with nothing to do is null (the picture is drawn as it is).
 */
export function effectiveGrade(g: ResolvedGrade | null, lut: CubeLut | null): ResolvedGrade | null {
  if (!g) return null
  if (lut || g.lutStrength === 0) return g
  const r = { ...g, lutStrength: 0 }
  return atRest(r) ? null : r
}

/* ---------- stage 1: white balance ---------- */

/** CIE xy of the Planckian light at `cct` kelvin (Kim et al. 2002 cubic spline, 1667–25000 K). */
function planckianXy(cct: number): [number, number] {
  const T = clamp(cct, 1667, 25000)
  const x =
    T <= 4000
      ? -0.2661239e9 / T ** 3 - 0.2343589e6 / T ** 2 + 0.8776956e3 / T + 0.17991
      : -3.0258469e9 / T ** 3 + 2.1070379e6 / T ** 2 + 0.2226347e3 / T + 0.24039
  const y =
    T <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : T <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483
  return [x, y]
}

/** Linear sRGB of the Planckian light at `cct` (Y = 1). */
function planckianRgb(cct: number): [number, number, number] {
  const [x, y] = planckianXy(cct)
  const X = x / y
  const Z = (1 - x - y) / y
  return [3.2404542 * X - 1.5371385 - 0.4985314 * Z, -0.969266 * X + 1.8760108 + 0.041556 * Z, 0.0556434 * X - 0.2040259 + 1.0572252 * Z]
}

/** The neutral light: temperature 0 is 6504 K, and gives the gains 1, 1, 1. */
const NEUTRAL_CCT = 6504
const NEUTRAL = planckianRgb(NEUTRAL_CCT)

/** The light's colour temperature for a temperature slider value (−1 cooler … +1 warmer): 10,666 K … 4,678 K. */
export const temperatureCct = (temperature: number): number => 1e6 / (1e6 / NEUTRAL_CCT + 60 * temperature)

/**
 * Linear-light gains of a white balance (W · gains = 1, so brightness is kept): the Planckian
 * light at the slider's temperature against the one at 6504 K, then green × 2^(−0.25 · tint).
 */
export function whiteBalanceGains(temperature: number, tint: number): [number, number, number] {
  const t = clamp(num(temperature, 0), -1, 1)
  const n = clamp(num(tint, 0), -1, 1)
  if (t === 0 && n === 0) return [1, 1, 1]
  const light = planckianRgb(temperatureCct(t))
  const g: [number, number, number] = [light[0] / NEUTRAL[0], (light[1] / NEUTRAL[1]) * 2 ** (-0.25 * n), light[2] / NEUTRAL[2]]
  const y = LUMA[0] * g[0] + LUMA[1] * g[1] + LUMA[2] * g[2]
  return [g[0] / y, g[1] / y, g[2] / y]
}

/* ---------- stages 1–6: one channel ---------- */

/** What stages 1–6 need, worked out once per grade. */
interface Curve {
  gains: [number, number, number]
  exposure: number
  /** Brightness: e^power. */
  power: number
  /** Contrast: the S-curve's exponent. */
  k: number
  shadows: number
  highlights: number
  fade: number
}

function curveOf(g: ResolvedGrade): Curve {
  return {
    gains: whiteBalanceGains(g.temperature, g.tint),
    exposure: 2 ** g.exposure,
    power: 2 ** (-0.7 * g.brightness),
    k: 2 ** g.contrast,
    shadows: g.shadows * TONE_GAIN,
    highlights: g.highlights * TONE_GAIN,
    fade: FADE_LIFT * g.fade
  }
}

/** Stages 1–6 for channel `ch` of an encoded value `e` (0..1): the result in linear light. */
function channel(e: number, c: Curve, ch: 0 | 1 | 2): number {
  // 1, 2: white balance and exposure in linear light, clamped (a white page never goes past white).
  let v = encodeSrgb(decodeSrgb(e) * c.gains[ch] * c.exposure)
  // 3: brightness, encoded; black and white stay.
  if (c.power !== 1) v = v ** c.power
  // 4: contrast, an S-curve about 0.5 with its ends fixed.
  if (c.k !== 1) v = v < 0.5 ? 0.5 * (v / 0.5) ** c.k : 1 - 0.5 * ((1 - v) / 0.5) ** c.k
  // 5: shadows and highlights, bumps peaking at 1/3 and 2/3.
  if (c.shadows !== 0 || c.highlights !== 0) {
    const u = 1 - v
    v = v + c.shadows * v * u * u + c.highlights * v * v * u
  }
  // 6: fade lifts black.
  if (c.fade !== 0) v = c.fade + v * (1 - c.fade)
  return decodeSrgb(clamp01(v))
}

/** Stages 1–6 baked per channel: 768 linear values (red 0..255, then green, then blue). */
export function gradeTable(g: ResolvedGrade): Float32Array {
  const c = curveOf(g)
  const t = new Float32Array(768)
  for (let i = 0; i < 256; i++) {
    t[i] = channel(i / 255, c, 0)
    t[256 + i] = channel(i / 255, c, 1)
    t[512 + i] = channel(i / 255, c, 2)
  }
  return t
}

/* ---------- the key of a grade ---------- */

const lutIds = new WeakMap<CubeLut, number>()
let nextLutId = 1
function lutId(lut: CubeLut): number {
  let id = lutIds.get(lut)
  if (id === undefined) {
    id = nextLutId++
    lutIds.set(lut, id)
  }
  return id
}

/** A cache key of a resolved grade and its LUT ('' for none: the picture as it is). */
export function gradeKey(g: ResolvedGrade | null, lut: CubeLut | null): string {
  const e = effectiveGrade(g, lut)
  if (!e) return ''
  const values = [e.temperature, e.tint, e.exposure, e.brightness, e.contrast, e.highlights, e.shadows, e.fade, e.saturation, e.vibrance, e.split.kS, e.split.kH, e.lutStrength]
  return `${values.join(',')}|${lut && e.lutStrength > 0 ? lutId(lut) : 0}`
}

/* ---------- stage 10: the LUT ---------- */

/** A shaper's value for input `v` on `channel` (linear between its entries, after its input range). */
export function shaperSample(lut: CubeLut, v: number, channel: 0 | 1 | 2): number {
  const s = lut.shaper
  if (!s) return v
  const n = s.size
  const t = clamp01((v - s.min) / (s.max - s.min)) * (n - 1)
  const i = Math.min(Math.floor(t), n - 2)
  const a = s.data[i * 3 + channel]
  return a + (s.data[(i + 1) * 3 + channel] - a) * (t - i)
}

/**
 * Tetrahedral interpolation of the 3D table at `x`, `y`, `z` (each 0..1): the cell is split along
 * its grey diagonal into six tetrahedra, and the one holding the point is used. Exact on the grid
 * and along the grey axis. The shader takes the same branches (gradeLayer.ts).
 */
function tetrahedral(lut: CubeLut, x: number, y: number, z: number): [number, number, number] {
  const n = lut.size
  const d = lut.data
  const tr = x * (n - 1)
  const tg = y * (n - 1)
  const tb = z * (n - 1)
  const ir = Math.min(Math.floor(tr), n - 2)
  const ig = Math.min(Math.floor(tg), n - 2)
  const ib = Math.min(Math.floor(tb), n - 2)
  const fr = tr - ir
  const fg = tg - ig
  const fb = tb - ib
  // Steps through the table along red, green and blue.
  const sr = 3
  const sg = 3 * n
  const sb = 3 * n * n
  const c000 = ((ib * n + ig) * n + ir) * 3
  const c111 = c000 + sr + sg + sb
  // The two corners between 000 and 111 (as offsets from 000) and the four weights, by the order of the fractions.
  let p1: number, p2: number, w0: number, w1: number, w2: number, w3: number
  if (fr > fg) {
    if (fg > fb) {
      // r > g > b
      p1 = sr
      p2 = sr + sg
      w0 = 1 - fr
      w1 = fr - fg
      w2 = fg - fb
      w3 = fb
    } else if (fr > fb) {
      // r > b ≥ g
      p1 = sr
      p2 = sr + sb
      w0 = 1 - fr
      w1 = fr - fb
      w2 = fb - fg
      w3 = fg
    } else {
      // b ≥ r > g
      p1 = sb
      p2 = sr + sb
      w0 = 1 - fb
      w1 = fb - fr
      w2 = fr - fg
      w3 = fg
    }
  } else if (fb > fg) {
    // b > g ≥ r
    p1 = sb
    p2 = sg + sb
    w0 = 1 - fb
    w1 = fb - fg
    w2 = fg - fr
    w3 = fr
  } else if (fb > fr) {
    // g ≥ b > r
    p1 = sg
    p2 = sg + sb
    w0 = 1 - fg
    w1 = fg - fb
    w2 = fb - fr
    w3 = fr
  } else {
    // g ≥ r ≥ b
    p1 = sg
    p2 = sr + sg
    w0 = 1 - fg
    w1 = fg - fr
    w2 = fr - fb
    w3 = fb
  }
  p1 += c000
  p2 += c000
  return [
    w0 * d[c000] + w1 * d[p1] + w2 * d[p2] + w3 * d[c111],
    w0 * d[c000 + 1] + w1 * d[p1 + 1] + w2 * d[p2 + 1] + w3 * d[c111 + 1],
    w0 * d[c000 + 2] + w1 * d[p1 + 2] + w2 * d[p2 + 2] + w3 * d[c111 + 2]
  ]
}

/** A LUT's value for an encoded colour (shaper, then the table's domain, then tetrahedral). */
export function lutSample(lut: CubeLut, r: number, g: number, b: number): [number, number, number] {
  const lo = lut.domainMin
  const hi = lut.domainMax
  return tetrahedral(
    lut,
    clamp01((shaperSample(lut, r, 0) - lo[0]) / (hi[0] - lo[0])),
    clamp01((shaperSample(lut, g, 1) - lo[1]) / (hi[1] - lo[1])),
    clamp01((shaperSample(lut, b, 2) - lo[2]) / (hi[2] - lo[2]))
  )
}

/* ---------- stages 7–11 ---------- */

/** Whether `g` mixes the channels (saturation, vibrance, split toning or a LUT): else each channel is one lookup. */
export function crossesChannels(g: ResolvedGrade, lut: CubeLut | null): boolean {
  return g.saturation !== 0 || g.vibrance !== 0 || g.split.kS !== 0 || g.split.kH !== 0 || (!!lut && g.lutStrength > 0)
}

/** Stage 7's gain on a pixel whose input has saturation `sat`: vibrance lifts the dull colours more. */
export const saturationGain = (sat: number, saturation: number, vibrance: number): number => (1 + saturation) * (1 + vibrance * (1 - sat) * (1 - sat))

/**
 * Stage 7 alone: linear `l` saturated about its luminance by `S` (saturationGain), each channel at
 * least 0. Where nothing is cut at 0, the luminance is exactly kept.
 */
export function saturateLinear(l: readonly [number, number, number], S: number): [number, number, number] {
  const Y = LUMA[0] * l[0] + LUMA[1] * l[1] + LUMA[2] * l[2]
  return [Math.max(0, Y + (l[0] - Y) * S), Math.max(0, Y + (l[1] - Y) * S), Math.max(0, Y + (l[2] - Y) * S)]
}

/**
 * Stages 7–10 for one pixel: `l` its linear values after stages 1–6, `sat` the saturation of its
 * encoded input ((max − min) / max, 0 for black), `encode` the encoder (exact, or the CPU path's
 * table). Returns the encoded result, not yet clamped or rounded.
 */
function mix(l: readonly [number, number, number], sat: number, g: ResolvedGrade, lut: CubeLut | null, encode: (v: number) => number): [number, number, number] {
  let r = l[0]
  let gr = l[1]
  let b = l[2]
  if (g.saturation !== 0 || g.vibrance !== 0 || g.split.kS !== 0 || g.split.kH !== 0) {
    const Y = LUMA[0] * r + LUMA[1] * gr + LUMA[2] * b
    // 7: saturation and vibrance about the pixel's luminance, in linear light (luminance kept).
    if (g.saturation !== 0 || g.vibrance !== 0) [r, gr, b] = saturateLinear([r, gr, b], saturationGain(sat, g.saturation, g.vibrance))
    // 8: split toning by the encoded luminance, teal into the shadows and orange into the highlights.
    if (g.split.kS !== 0 || g.split.kH !== 0) {
      const y = encode(Y)
      const k = g.split.kS * (1 - y) * (1 - y) - g.split.kH * y * y
      r += k * TEAL[0]
      gr += k * TEAL[1]
      b += k * TEAL[2]
    }
  }
  // 9: encoded.
  const e: [number, number, number] = [encode(r), encode(gr), encode(b)]
  // 10: the LUT on the encoded values, mixed by its strength.
  if (lut && g.lutStrength > 0) {
    const m = lutSample(lut, e[0], e[1], e[2])
    const s = g.lutStrength
    return [e[0] + (m[0] - e[0]) * s, e[1] + (m[1] - e[1]) * s, e[2] + (m[2] - e[2]) * s]
  }
  return e
}

/** 11: clamped and rounded to 8 bits. */
const to8 = (v: number): number => Math.round(clamp01(v) * 255)

/** The saturation of an input: (max − min) / max, 0 for black. */
function saturationOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b)
  return mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0
}

/** One pixel graded (the reference): `rgb` and the result are 8-bit codes; `table` is gradeTable(g). */
export function gradePixel(rgb: readonly [number, number, number], g: ResolvedGrade, table: Float32Array, lut: CubeLut | null): [number, number, number] {
  const [r, gr, b] = rgb
  const e = mix([table[r], table[256 + gr], table[512 + b]], saturationOf(r, gr, b), g, lut, encodeSrgb)
  return [to8(e[0]), to8(e[1]), to8(e[2])]
}

/**
 * A colour graded with the exact maths at any encoded input (each 0..1), without the 8-bit table:
 * what a LUT baked from the grade would hold at its grid points (§9.2: why the grade is not one
 * baked LUT). Returns encoded values, clamped, not rounded.
 */
export function gradeEncoded(e: readonly [number, number, number], g: ResolvedGrade, lut: CubeLut | null): [number, number, number] {
  const c = curveOf(g)
  const [r, gr, b] = [clamp01(e[0]), clamp01(e[1]), clamp01(e[2])]
  const out = mix([channel(r, c, 0), channel(gr, c, 1), channel(b, c, 2)], saturationOf(r, gr, b), g, lut, encodeSrgb)
  return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])]
}

/* ---------- the CPU path ---------- */

let encodeTable: Float64Array | null = null

/** The CPU path's encoder: 4,097 exact values, linear between them (a few thousandths of a level off at most). */
function tableEncode(l: number): number {
  const t = (encodeTable ??= Float64Array.from({ length: ENCODE_STEPS + 1 }, (_, i) => encodeSrgb(i / ENCODE_STEPS)))
  if (!(l > 0)) return 0
  if (l >= 1) return 1
  const x = l * ENCODE_STEPS
  const i = Math.floor(x)
  return t[i] + (t[i + 1] - t[i]) * (x - i)
}

/**
 * RGBA pixels graded in place (the CPU path, for PCs without WebGL2): the same maths as
 * gradePixel. A grade that does not mix the channels is one 8-bit lookup per channel, exactly
 * gradePixel; otherwise the encoding goes through a 4,097-entry table (within one level of it).
 * Alpha is left as it is.
 */
export function gradePixelsCpu(data: Uint8ClampedArray, g: ResolvedGrade, table: Float32Array, lut: CubeLut | null): void {
  const n = data.length - (data.length % 4)
  if (!crossesChannels(g, lut)) {
    const lookup = new Uint8Array(768)
    for (let i = 0; i < 768; i++) lookup[i] = to8(encodeSrgb(table[i]))
    for (let p = 0; p < n; p += 4) {
      data[p] = lookup[data[p]]
      data[p + 1] = lookup[256 + data[p + 1]]
      data[p + 2] = lookup[512 + data[p + 2]]
    }
    return
  }
  const l: [number, number, number] = [0, 0, 0]
  for (let p = 0; p < n; p += 4) {
    const r = data[p]
    const gr = data[p + 1]
    const b = data[p + 2]
    l[0] = table[r]
    l[1] = table[256 + gr]
    l[2] = table[512 + b]
    const e = mix(l, saturationOf(r, gr, b), g, lut, tableEncode)
    data[p] = to8(e[0])
    data[p + 1] = to8(e[1])
    data[p + 2] = to8(e[2])
  }
}

/** Where shaper entry i sits in its 256-wide texture (§9.3). */
export function shaperTexel(i: number): [number, number] {
  return [i % 256, Math.floor(i / 256)]
}
