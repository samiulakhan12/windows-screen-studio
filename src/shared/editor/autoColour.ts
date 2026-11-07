/**
 * Auto colour for the camera (docs/design/editing-polish.md §9.6): Shades-of-Gray on the
 * background, gentle levels, offline. The result is ordinary values of the camera's grade
 * (temperature, tint, brightness, contrast), worked out once from a few frames and never while
 * drawing, so it is the same at any seek and fps.
 *
 * - The light: Shades-of-Gray (Minkowski p = 6) in linear light over the background (the person
 *   mask below 0.3, or the whole frame without one), leaving out clipped (a channel ≥ 250), dark
 *   (the largest channel below 12) and strongly coloured (chroma above 0.6) pixels; the median of
 *   each channel across frames.
 * - The balance: the white balance of §9.2 stage 1 nearest to the light's inverse, by a grid search
 *   in steps of 0.01; 70 % of it is used and |temperature| ≤ 0.6 (webcams balance already, and a
 *   coloured wall makes grey-world overshoot).
 * - Levels: contrast only when black is above 0.04 or white below 0.92 (luminance percentiles 0.5
 *   and 99.5, encoded), by at most a 1.25× stretch; brightness only when the median is below 0.38,
 *   by at most 0.7 stops.
 * - Never a skin target: exposure is never set from a face, which would lighten darker skin. The
 *   face only guards against clipping: its 90th percentile must stay below 0.95.
 */
import type { Rect } from '../engine/layout'
import { readColorGrade } from '../render/gradeData'
import { decodeSrgb, encodeSrgb, gradeTable, LUMA, whiteBalanceGains, type ResolvedGrade } from '../render/colorGrade'
import type { ColorGrade, Project } from '../types'
import { withProjectGrade } from './colourEdit'

export interface ColourSample {
  /** RGBA, w × h. */
  pixels: Uint8ClampedArray
  /** The person mask (RGBA, alpha = person), w × h; null: none (the whole frame is used). */
  mask: Uint8ClampedArray | null
  w: number
  h: number
  /** The head, normalised (0..1) to the picture; null: not found. */
  face: Rect | null
}

export const AUTO_COLOUR = {
  /** Shades-of-Gray's Minkowski norm. */
  p: 6,
  /** The person mask's alpha below which a pixel is background. */
  background: 0.3,
  /** Left out: a channel at or above this (clipped), the largest channel below `dark`, chroma above `chroma`. */
  clipped: 250,
  dark: 12,
  chroma: 0.6,
  /** How much of the found balance is used, and the largest temperature. */
  amount: 0.7,
  maxTemperature: 0.6,
  /** Levels (encoded luminance). */
  black: 0.04,
  white: 0.92,
  maxStretch: 1.25,
  median: 0.38,
  maxStops: 0.7,
  /** The face's 90th percentile stays below this. */
  faceCeiling: 0.95
} as const

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

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => decodeSrgb(i / 255))
const median = (v: readonly number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const round2 = (v: number): number => Math.round(v * 100) / 100 + 0

/** The light of one frame (linear RGB, Shades-of-Gray), or null when too few pixels are usable. */
function lightOf(s: ColourSample): [number, number, number] | null {
  const { pixels, mask, w, h } = s
  const n = Math.min(w * h, Math.floor(pixels.length / 4))
  const sum = [0, 0, 0]
  let count = 0
  for (let i = 0; i < n; i++) {
    if (mask && mask[i * 4 + 3] >= AUTO_COLOUR.background * 255) continue
    const r = pixels[i * 4]
    const g = pixels[i * 4 + 1]
    const b = pixels[i * 4 + 2]
    const mx = Math.max(r, g, b)
    if (mx >= AUTO_COLOUR.clipped || mx < AUTO_COLOUR.dark) continue
    if ((mx - Math.min(r, g, b)) / mx > AUTO_COLOUR.chroma) continue
    sum[0] += LINEAR[r] ** AUTO_COLOUR.p
    sum[1] += LINEAR[g] ** AUTO_COLOUR.p
    sum[2] += LINEAR[b] ** AUTO_COLOUR.p
    count++
  }
  if (count < 16) return null
  return [(sum[0] / count) ** (1 / AUTO_COLOUR.p), (sum[1] / count) ** (1 / AUTO_COLOUR.p), (sum[2] / count) ** (1 / AUTO_COLOUR.p)]
}

/** The temperature and tint (steps of 0.01) whose gains are nearest `want` (log distance). */
function nearestBalance(want: readonly [number, number, number]): { temperature: number; tint: number } {
  const lw = want.map(Math.log)
  let best = { temperature: 0, tint: 0 }
  let bestD = Infinity
  for (let ti = -100; ti <= 100; ti++) {
    for (let ni = -100; ni <= 100; ni++) {
      const g = whiteBalanceGains(ti / 100, ni / 100)
      const d = (Math.log(g[0]) - lw[0]) ** 2 + (Math.log(g[1]) - lw[1]) ** 2 + (Math.log(g[2]) - lw[2]) ** 2
      if (d < bestD) {
        bestD = d
        best = { temperature: ti / 100, tint: ni / 100 }
      }
    }
  }
  return best
}

/** Encoded luminance of every `step`-th pixel of the samples, sorted (after `table` when given). */
function lumas(samples: readonly ColourSample[], table: Float32Array | null, pick: (s: ColourSample, i: number) => boolean = () => true): number[] {
  const out: number[] = []
  for (const s of samples) {
    const n = Math.min(s.w * s.h, Math.floor(s.pixels.length / 4))
    const step = Math.max(1, Math.floor(n / 20000))
    for (let i = 0; i < n; i += step) {
      if (!pick(s, i)) continue
      const r = s.pixels[i * 4]
      const g = s.pixels[i * 4 + 1]
      const b = s.pixels[i * 4 + 2]
      const l = table ? LUMA[0] * table[r] + LUMA[1] * table[256 + g] + LUMA[2] * table[512 + b] : LUMA[0] * LINEAR[r] + LUMA[1] * LINEAR[g] + LUMA[2] * LINEAR[b]
      out.push(encodeSrgb(l))
    }
  }
  return out.sort((a, b) => a - b)
}

const percentile = (sorted: readonly number[], q: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : 0)

/** Whether pixel i of `s` is inside its face box. */
function inFace(s: ColourSample, i: number): boolean {
  const f = s.face
  if (!f) return false
  const x = ((i % s.w) + 0.5) / s.w
  const y = (Math.floor(i / s.w) + 0.5) / s.h
  return x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h
}

/** The camera grade that balances `samples`, or null when they say nothing (or nothing needs changing). */
export function autoCameraGrade(samples: readonly ColourSample[]): ColorGrade | null {
  const usable = samples.filter((s) => s.w > 0 && s.h > 0 && s.pixels.length >= s.w * s.h * 4)
  if (!usable.length) return null
  // The light: each channel's median across the frames.
  const lights = usable.map(lightOf).filter((l): l is [number, number, number] => l !== null)
  let temperature = 0
  let tint = 0
  if (lights.length) {
    const light = [0, 1, 2].map((c) => median(lights.map((l) => l[c]))) as [number, number, number]
    if (light.every((v) => v > 0)) {
      // The gains that make the light neutral, with brightness kept (W · gains = 1).
      const inv = light.map((v) => 1 / v)
      const y = LUMA[0] * inv[0] + LUMA[1] * inv[1] + LUMA[2] * inv[2]
      const found = nearestBalance([inv[0] / y, inv[1] / y, inv[2] / y])
      temperature = Math.max(-AUTO_COLOUR.maxTemperature, Math.min(AUTO_COLOUR.maxTemperature, round2(found.temperature * AUTO_COLOUR.amount)))
      tint = round2(found.tint * AUTO_COLOUR.amount)
    }
  }
  // Levels, measured after the balance.
  const balanced = gradeTable({ ...ZERO, temperature, tint })
  const all = lumas(usable, balanced)
  const black = percentile(all, 0.005)
  const white = percentile(all, 0.995)
  const mid = percentile(all, 0.5)
  let contrast = 0
  if ((black > AUTO_COLOUR.black || white < AUTO_COLOUR.white) && white > black) {
    // The S-curve's slope at the middle is 2^contrast: stretch the range toward black..white, at most 1.25×.
    const stretch = Math.min(AUTO_COLOUR.maxStretch, (AUTO_COLOUR.white - AUTO_COLOUR.black) / (white - black))
    if (stretch > 1) contrast = round2(Math.log2(stretch))
  }
  let brightness = 0
  if (mid > 0 && mid < AUTO_COLOUR.median) {
    // e^(2^(−0.7 b)) takes the median to its target: up to 0.38, at most 0.7 stops brighter.
    const target = Math.min(AUTO_COLOUR.median, encodeSrgb(decodeSrgb(mid) * 2 ** AUTO_COLOUR.maxStops))
    if (target > mid) brightness = Math.max(0, Math.min(1, Math.floor((-Math.log2(Math.log(target) / Math.log(mid)) / 0.7) * 100) / 100))
  }
  // The face only guards against clipping: brightness and contrast come down until its 90th percentile is below 0.95.
  const faces = usable.some((s) => s.face)
  while (faces && (brightness > 0 || contrast > 0)) {
    const t = gradeTable({ ...ZERO, temperature, tint, brightness, contrast })
    const face = lumas(usable, t, inFace)
    if (!face.length || percentile(face, 0.9) < AUTO_COLOUR.faceCeiling) break
    brightness = Math.max(0, round2(brightness - 0.05))
    if (brightness === 0) contrast = Math.max(0, round2(contrast - 0.05))
  }
  const out: ColorGrade = {}
  if (temperature) out.temperature = temperature
  if (tint) out.tint = tint
  if (brightness) out.brightness = brightness
  if (contrast) out.contrast = contrast
  return Object.keys(out).length ? out : null
}

/**
 * The camera graded `grade` (its balance and levels over the camera's own look, LUT and other
 * sliders), with Auto colour's record in the same update: the grade from before, or, when a record
 * is already there (a second run before Review settled the first), that one's, so Review's Remove
 * still puts back the user's own colour. The record is a new object each run (settleGrade tells a
 * run from an edit by hand by it).
 */
export function withAutoColour(project: Project, grade: ColorGrade): Project {
  const before = project.grade?.camera ?? null
  const was = project.grade?.auto ? project.grade.auto.camera : before
  const balance: ColorGrade = { ...before }
  for (const key of ['temperature', 'tint', 'brightness', 'contrast', 'exposure'] as const) delete balance[key]
  // Read as a load would (an empty grade is not written).
  const camera = readColorGrade({ ...balance, ...grade }, 'camera')
  return withProjectGrade(project, { ...project.grade, camera, auto: { camera: was } })
}
