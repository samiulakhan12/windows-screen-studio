/**
 * The colour maths (docs/design/editing-polish.md §9.2; §19.1 tests 46 to 52 and the pure part of
 * 81): the white balance's gains, the per-channel table, how a look and the sliders resolve, the
 * CPU path against the reference, saturation keeping luminance, the LUT's interpolation, why the
 * grade is not one baked LUT, and where a shaper entry sits in its texture.
 */
import { describe, expect, it } from 'vitest'
import {
  crossesChannels,
  decodeSrgb,
  effectiveGrade,
  encodeSrgb,
  gradeEncoded,
  gradeKey,
  gradePixel,
  gradePixelsCpu,
  gradeTable,
  LUMA,
  lutSample,
  resolveGrade,
  saturateLinear,
  saturationGain,
  shaperSample,
  shaperTexel,
  TEAL,
  whiteBalanceGains,
  type ResolvedGrade
} from '../src/shared/render/colorGrade'
import type { CubeLut } from '../src/shared/render/cubeLut'
import { LOOKS } from '../src/shared/render/looks'
import type { ColorGrade, LookId } from '../src/shared/types'

const ZERO: ResolvedGrade = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  fade: 0,
  saturation: 0,
  vibrance: 0,
  split: { kS: 0, kH: 0 },
  lutStrength: 0
}
const grade = (over: Partial<ResolvedGrade>): ResolvedGrade => ({ ...ZERO, ...over })
const dot = (g: readonly number[]): number => LUMA[0] * g[0] + LUMA[1] * g[1] + LUMA[2] * g[2]

/** A LUT of size n whose entry at grid (r, g, b) (0..1) is `f(r, g, b)`. */
function lutOf(n: number, f: (r: number, g: number, b: number) => [number, number, number], extra: Partial<CubeLut> = {}): CubeLut {
  const data = new Float32Array(n * n * n * 3)
  let k = 0
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const v = f(r / (n - 1), g / (n - 1), b / (n - 1))
        data[k++] = v[0]
        data[k++] = v[1]
        data[k++] = v[2]
      }
  return { title: '', size: n, data, shaper: null, domainMin: [0, 0, 0], domainMax: [1, 1, 1], ...extra }
}

/** A shaper of n entries per channel, `f(v)` at v = i / (n − 1) over 0..1. */
function shaperOf(n: number, f: (v: number, c: number) => number): CubeLut['shaper'] {
  const data = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[i * 3 + c] = f(i / (n - 1), c)
  return { size: n, data, min: 0, max: 1 }
}

/** The self-test's kind of pattern: 64 × 64, a vertical ramp in green, so top and bottom differ. */
function pattern(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(64 * 64 * 4)
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const o = (y * 64 + x) * 4
      px[o] = (x * 4 + (y & 3)) & 255
      px[o + 1] = y * 4 + (x & 3)
      px[o + 2] = (x * 7 + y * 13) & 255
      px[o + 3] = 255
    }
  return px
}

describe('the white balance (test 46)', () => {
  it('gives the gains of §9.2 within 0.002', () => {
    const near = (got: number[], want: number[]): void => got.forEach((v, i) => expect(Math.abs(v - want[i]), `${got} vs ${want}`).toBeLessThan(0.002))
    near(whiteBalanceGains(1, 0), [1.217, 0.969, 0.671])
    near(whiteBalanceGains(-1, 0), [0.82, 1.01, 1.429])
    near(whiteBalanceGains(0, 1), [1.128, 0.949, 1.128])
    expect(whiteBalanceGains(0, 0)).toEqual([1, 1, 1])
  })

  it('keeps brightness: W · gains = 1 everywhere', () => {
    for (let t = -1; t <= 1; t += 0.125) for (let n = -1; n <= 1; n += 0.25) expect(dot(whiteBalanceGains(t, n))).toBeCloseTo(1, 12)
    // Warmer is redder and less blue, step by step.
    let last = whiteBalanceGains(-1, 0)
    for (let t = -0.9; t <= 1.0001; t += 0.1) {
      const g = whiteBalanceGains(t, 0)
      expect(g[0]).toBeGreaterThan(last[0])
      expect(g[2]).toBeLessThan(last[2])
      last = g
    }
  })
})

describe('the per-channel table (test 47)', () => {
  const identity = gradeTable(ZERO)
  const monotonic = (t: Float32Array): void => {
    for (let ch = 0; ch < 3; ch++) for (let i = 1; i < 256; i++) expect(t[ch * 256 + i], `channel ${ch} code ${i}`).toBeGreaterThanOrEqual(t[ch * 256 + i - 1])
    // And the slider does something.
    expect(t).not.toEqual(identity)
  }

  it('is monotonic per channel for every slider at ±1 (and exposure at ±2, fade at 1)', () => {
    for (const key of ['temperature', 'tint', 'brightness', 'contrast', 'highlights', 'shadows'] as const) {
      for (const v of [-1, 1]) monotonic(gradeTable(grade({ [key]: v })))
    }
    for (const v of [-2, 2]) monotonic(gradeTable(grade({ exposure: v })))
    monotonic(gradeTable(grade({ fade: 1 })))
    monotonic(gradeTable(grade({ temperature: 1, tint: -1, brightness: 1, contrast: 1, highlights: -1, shadows: 1, fade: 0.6, exposure: 1 })))
  })

  it('keeps black and white with brightness and contrast', () => {
    for (const over of [{ brightness: 1 }, { brightness: -1 }, { contrast: 1 }, { contrast: -1 }, { brightness: -1, contrast: 1 }]) {
      const t = gradeTable(grade(over))
      for (let ch = 0; ch < 3; ch++) {
        expect(t[ch * 256], JSON.stringify(over)).toBe(0)
        expect(t[ch * 256 + 255], JSON.stringify(over)).toBe(1)
        expect(Math.abs(t[ch * 256 + 64] - identity[64]), JSON.stringify(over)).toBeGreaterThan(0.005)
      }
    }
  })

  it('a zero grade is the identity', () => {
    const t = gradeTable(ZERO)
    for (let i = 0; i < 256; i++) for (let ch = 0; ch < 3; ch++) expect(t[ch * 256 + i]).toBeCloseTo(decodeSrgb(i / 255), 6)
    for (let i = 0; i < 256; i++) expect(gradePixel([i, 255 - i, (i * 7) & 255], ZERO, t, null)).toEqual([i, 255 - i, (i * 7) & 255])
    // And brightness lightens the middle, contrast darkens the shadows and lifts the highlights.
    const mid = (g: Partial<ResolvedGrade>, i: number): number => gradeTable(grade(g))[i]
    expect(mid({ brightness: 0.5 }, 128)).toBeGreaterThan(decodeSrgb(128 / 255))
    expect(mid({ contrast: 0.5 }, 60)).toBeLessThan(decodeSrgb(60 / 255))
    expect(mid({ contrast: 0.5 }, 200)).toBeGreaterThan(decodeSrgb(200 / 255))
  })
})

describe('resolving a grade (test 48)', () => {
  it('no look, no LUT and zeros give null', () => {
    expect(resolveGrade(undefined, 'camera')).toBeNull()
    expect(resolveGrade({}, 'camera')).toBeNull()
    expect(resolveGrade({ temperature: 0, saturation: 0, exposure: 0, lookStrength: 1 }, 'camera')).toBeNull()
    expect(resolveGrade({ look: 'vivid', lookStrength: 0 }, 'screen')).toBeNull()
    expect(resolveGrade({ lut: { file: 'lut-1.cube', sha256: 'a'.repeat(64), title: 't', size: 2, strength: 0 } }, 'camera')).toBeNull()
    expect(resolveGrade({ temperature: 0.1 }, 'camera')).not.toBeNull()
  })

  it('adds a look times its strength to the sliders, clamped', () => {
    const warm = resolveGrade({ look: 'warm', temperature: -0.1 }, 'camera')!
    expect(warm.temperature).toBeCloseTo(0.25, 12)
    expect(warm.tint).toBeCloseTo(0.05, 12)
    expect(warm.contrast).toBeCloseTo(0.06, 12)
    expect(warm.vibrance).toBeCloseTo(0.1, 12)
    const half = resolveGrade({ look: 'cinematic', lookStrength: 0.5 }, 'camera')!
    expect(half.contrast).toBeCloseTo(0.075, 12)
    expect(half.split).toEqual({ kS: 0.03, kH: 0.025 })
    const soft = resolveGrade({ look: 'soft' }, 'camera')!
    expect(soft.fade).toBe(0.5)
    expect(resolveGrade({ look: 'vivid', saturation: 1 }, 'screen')!.saturation).toBe(1)
    expect(resolveGrade({ look: 'mono', saturation: -0.5 }, 'screen')!.saturation).toBe(-1)
    expect(resolveGrade({ temperature: 7 } as ColorGrade, 'camera')!.temperature).toBe(1)
    // A look's strength above 1 is 1, and not-a-number reads as nothing.
    expect(resolveGrade({ look: 'natural', lookStrength: 4 }, 'camera')!.contrast).toBeCloseTo(0.08, 12)
    expect(resolveGrade({ temperature: NaN, tint: 0.2 }, 'camera')!.temperature).toBe(0)
    // A LUT's strength, 1 when it is not written.
    expect(resolveGrade({ lut: { file: 'lut-1.cube', sha256: 'a'.repeat(64), title: 't', size: 2 } }, 'screen')!.lutStrength).toBe(1)
  })

  it('ignores exposure and the camera-only looks on the screen', () => {
    expect(resolveGrade({ exposure: 1 }, 'screen')).toBeNull()
    expect(resolveGrade({ exposure: 1 }, 'camera')!.exposure).toBe(1)
    expect(resolveGrade({ exposure: -5 }, 'camera')!.exposure).toBe(-2)
    expect(resolveGrade({ look: 'warm' }, 'screen')).toBeNull()
    expect(resolveGrade({ look: 'warm', tint: 0.2 }, 'screen')!.temperature).toBe(0)
  })

  it('a missing LUT leaves the rest of the grade; the key tells grades and LUTs apart', () => {
    const lut = lutOf(2, (r, g, b) => [r, g, b])
    const withLut = resolveGrade({ lut: { file: 'lut-1.cube', sha256: 'a'.repeat(64), title: 't', size: 2 } }, 'camera')!
    expect(effectiveGrade(withLut, null)).toBeNull()
    expect(effectiveGrade(withLut, lut)).toBe(withLut)
    expect(gradeKey(withLut, null)).toBe('')
    expect(gradeKey(null, lut)).toBe('')
    const warm = resolveGrade({ look: 'warm' }, 'camera')!
    expect(gradeKey(warm, null)).not.toBe('')
    expect(gradeKey(warm, null)).toBe(gradeKey(resolveGrade({ look: 'warm' }, 'camera'), null))
    expect(gradeKey(warm, null)).not.toBe(gradeKey(resolveGrade({ look: 'cool' }, 'camera'), null))
    const both = { ...warm, lutStrength: 1 }
    expect(gradeKey(both, lut)).not.toBe(gradeKey(both, lutOf(2, (r, g, b) => [r, g, b])))
    expect(gradeKey(both, lut)).toBe(gradeKey({ ...both }, lut))
  })
})

describe('the CPU path matches the reference (test 49)', () => {
  // A 17³ LUT that moves every colour (a rotation of the channels with a curve), and a 1,024-entry shaper.
  const lut = lutOf(17, (r, g, b) => [0.1 + 0.8 * g ** 1.2, b, 0.5 * (r + b)], { shaper: shaperOf(1024, (v, c) => v ** (0.9 + c * 0.05)) })
  const cases: [string, ColorGrade][] = [
    ...LOOKS.map((l) => [l.id, { look: l.id }] as [string, ColorGrade]),
    ['sliders', { temperature: 0.4, tint: -0.3, brightness: 0.3, contrast: -0.4, highlights: 0.5, shadows: -0.5, exposure: 0.5 }]
  ]

  for (const [name, g] of cases) {
    it(`${name}, alone and with the LUT at 70 %`, () => {
      for (const withLut of [false, true]) {
        const r = { ...resolveGrade(g, 'camera')!, lutStrength: withLut ? 0.7 : 0 }
        const table = gradeTable(r)
        const src = pattern()
        const cpu = src.slice()
        gradePixelsCpu(cpu, r, table, withLut ? lut : null)
        let off = 0
        for (let p = 0; p < src.length; p += 4) {
          const want = gradePixel([src[p], src[p + 1], src[p + 2]], r, table, withLut ? lut : null)
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(cpu[p + c] - want[c])
            expect(d, `${name} ${withLut} at ${p / 4} channel ${c}`).toBeLessThanOrEqual(1)
            if (d) off++
          }
          expect(cpu[p + 3]).toBe(255)
        }
        // One level, and rarely (under 1 % of the values): the encode table is a few thousandths of a level off at most.
        expect(off, `${name} ${withLut}`).toBeLessThan((src.length / 4) * 3 * 0.01)
        // A grade that does not mix the channels is one lookup per channel: exactly the reference.
        if (!crossesChannels(r, withLut ? lut : null)) expect(off).toBe(0)
      }
    })
  }

  it('changes the picture (the CPU path is not a no-op)', () => {
    const r = resolveGrade({ look: 'vintage' }, 'camera')!
    const px = pattern()
    gradePixelsCpu(px, r, gradeTable(r), null)
    expect(px).not.toEqual(pattern())
  })
})

describe('saturation (test 50)', () => {
  it('keeps luminance within 1e-6 before clipping', () => {
    let checked = 0
    for (let i = 0; i < 2000; i++) {
      const l: [number, number, number] = [((i * 37) % 101) / 100, ((i * 53) % 97) / 96, ((i * 71) % 89) / 88]
      const sat = (i % 11) / 10
      const S = saturationGain(sat, ((i % 7) - 3) / 3, ((i % 5) - 2) / 2)
      const out = saturateLinear(l, S)
      const Y = dot(l)
      // Where no channel is cut at 0.
      if ([0, 1, 2].every((c) => Y + (l[c] - Y) * S >= 0)) {
        expect(Math.abs(dot(out) - Y)).toBeLessThan(1e-6)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1000)
    // Vibrance lifts a dull colour more than a saturated one.
    expect(saturationGain(0.1, 0, 0.5)).toBeGreaterThan(saturationGain(0.9, 0, 0.5))
    // Split toning's colours have no luminance.
    expect(Math.abs(dot(TEAL))).toBeLessThan(1e-4)
  })

  it('Mono gives R = G = B', () => {
    const r = resolveGrade({ look: 'mono' }, 'screen')!
    const table = gradeTable(r)
    const src = pattern()
    for (let p = 0; p < src.length; p += 4) {
      const [R, G, B] = gradePixel([src[p], src[p + 1], src[p + 2]], r, table, null)
      expect(R).toBe(G)
      expect(G).toBe(B)
    }
    const cpu = src.slice()
    gradePixelsCpu(cpu, r, table, null)
    for (let p = 0; p < src.length; p += 4) expect(cpu[p] === cpu[p + 1] && cpu[p + 1] === cpu[p + 2]).toBe(true)
  })
})

describe('the LUT (test 51)', () => {
  const rand = (i: number): number => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1
  const random = lutOf(9, (r, g, b) => [rand(r * 7 + g * 13 + b * 17), rand(r * 3 + g * 29 + b * 5 + 1), rand(r * 11 + g * 2 + b * 23 + 2)])

  it('is exact on the grid and on the grey axis', () => {
    const n = random.size
    for (let b = 0; b < n; b++)
      for (let g = 0; g < n; g++)
        for (let r = 0; r < n; r++) {
          const k = ((b * n + g) * n + r) * 3
          const got = lutSample(random, r / (n - 1), g / (n - 1), b / (n - 1))
          for (let c = 0; c < 3; c++) expect(got[c]).toBeCloseTo(random.data[k + c], 6)
        }
    // On the grey axis: linear between the two diagonal corners of each cell.
    for (let v = 0; v <= 1; v += 1 / 37) {
      const t = v * (n - 1)
      const i = Math.min(Math.floor(t), n - 2)
      const f = t - i
      const a = ((i * n + i) * n + i) * 3
      const z = (((i + 1) * n + (i + 1)) * n + (i + 1)) * 3
      const got = lutSample(random, v, v, v)
      for (let c = 0; c < 3; c++) expect(got[c]).toBeCloseTo(random.data[a + c] * (1 - f) + random.data[z + c] * f, 6)
    }
  })

  it('an identity 33³ LUT changes nothing by more than one level', () => {
    const identity = lutOf(33, (r, g, b) => [r, g, b])
    const r = { ...ZERO, lutStrength: 1 }
    const table = gradeTable(r)
    for (let R = 0; R < 256; R += 3) for (let G = 0; G < 256; G += 5) for (let B = 0; B < 256; B += 7) {
      const out = gradePixel([R, G, B], r, table, identity)
      expect(Math.abs(out[0] - R) + Math.abs(out[1] - G) + Math.abs(out[2] - B) <= 3 && Math.max(Math.abs(out[0] - R), Math.abs(out[1] - G), Math.abs(out[2] - B)) <= 1).toBe(true)
    }
  })

  it('mixes by strength', () => {
    const swap = lutOf(17, (r, g, b) => [b, g, r])
    for (const s of [0, 0.25, 0.5, 1]) {
      const r = { ...ZERO, lutStrength: s }
      const out = gradePixel([200, 100, 40], r, gradeTable(r), swap)
      expect(out[0]).toBe(Math.round(200 + (40 - 200) * s))
      expect(out[2]).toBe(Math.round(40 + (200 - 40) * s))
      expect(out[1]).toBe(100)
    }
  })

  it('maps the domain', () => {
    // The table spans −0.25..1.25: its grid point 0.25 holds the input 0.125 (ramps out of 0..1 are allowed in values).
    const wide = lutOf(5, (r, g, b) => [r, g, b], { domainMin: [-0.25, -0.25, -0.25], domainMax: [1.25, 1.25, 1.25] })
    expect(lutSample(wide, 0.125, 0.125, 0.125)[0]).toBeCloseTo(0.25, 6)
    expect(lutSample(wide, 0.5, 0.5, 0.5)[1]).toBeCloseTo(0.5, 6)
    // Outside the domain, clamped to its edge.
    const narrow = lutOf(3, (r, g, b) => [r, g, b], { domainMin: [0.2, 0.2, 0.2], domainMax: [0.6, 0.6, 0.6] })
    expect(lutSample(narrow, 0.9, 0.1, 0.4)).toEqual([1, 0, 0.5].map((v) => expect.closeTo(v, 6)))
  })

  it('runs the shaper first, linear between its entries', () => {
    const identity = lutOf(2, (r, g, b) => [r, g, b])
    const shaped = { ...identity, shaper: { size: 3, data: new Float32Array([0, 0, 0, 0.25, 0.25, 0.25, 1, 1, 1]), min: 0, max: 1 } }
    expect(shaperSample(shaped, 0.25, 0)).toBeCloseTo(0.125, 6)
    expect(shaperSample(shaped, 0.75, 1)).toBeCloseTo(0.625, 6)
    expect(lutSample(shaped, 0.25, 0.25, 0.25)[0]).toBeCloseTo(0.125, 6)
    // Its own input range: 0..2 maps 1 to the middle entry.
    const ranged = { ...shaped, shaper: { ...shaped.shaper, min: 0, max: 2 } }
    expect(shaperSample(ranged, 1, 2)).toBeCloseTo(0.25, 6)
    // Without one, the input goes to the table as it is.
    expect(shaperSample(identity, 0.3, 0)).toBe(0.3)
  })
})

describe('why not one baked LUT (test 52)', () => {
  it('a 33³ bake of Vivid differs from gradePixel by at least 10 levels somewhere', () => {
    const vivid = resolveGrade({ look: 'vivid' }, 'camera')!
    const baked = lutOf(33, (r, g, b) => gradeEncoded([r, g, b], vivid, null))
    const table = gradeTable(vivid)
    let worst = 0
    for (let R = 0; R < 256; R += 3)
      for (let G = 0; G < 256; G += 3)
        for (let B = 0; B < 256; B += 3) {
          const exact = gradePixel([R, G, B], vivid, table, null)
          const bake = lutSample(baked, R / 255, G / 255, B / 255)
          for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(Math.round(bake[c] * 255) - exact[c]))
        }
    expect(worst).toBeGreaterThanOrEqual(10)
    // On the grid itself the bake is the exact maths (the error is between grid points).
    for (const p of [[0, 0, 0], [1, 0.5, 0.25], [0.75, 0.75, 0.125]] as [number, number, number][]) {
      const at = lutSample(baked, ...p)
      const want = gradeEncoded(p, vivid, null)
      for (let c = 0; c < 3; c++) expect(at[c]).toBeCloseTo(want[c], 5)
    }
  })
})

describe('the shader texture of a shaper (test 81, pure)', () => {
  it('puts entry i at (i mod 256, ⌊i / 256⌋), at most 256 × 256', () => {
    expect(shaperTexel(0)).toEqual([0, 0])
    expect(shaperTexel(255)).toEqual([255, 0])
    expect(shaperTexel(256)).toEqual([0, 1])
    expect(shaperTexel(1000)).toEqual([232, 3])
    expect(shaperTexel(65535)).toEqual([255, 255])
  })

  it('encodes and decodes sRGB as inverses', () => {
    for (let i = 0; i < 256; i++) expect(Math.round(encodeSrgb(decodeSrgb(i / 255)) * 255)).toBe(i)
    expect(encodeSrgb(-1)).toBe(0)
    expect(encodeSrgb(2)).toBeCloseTo(1, 12)
  })

  it('every look id has a look', () => {
    const ids: LookId[] = ['natural', 'warm', 'cool', 'vivid', 'soft', 'cinematic', 'mono', 'vintage']
    for (const id of ids) expect(resolveGrade({ look: id }, 'camera'), id).not.toBeNull()
  })
})
