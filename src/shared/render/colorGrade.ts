/**
 * The colour maths (docs/design/editing-polish.md §9.2): a grade resolved from its look and
 * sliders, the exact per-channel table, the cross-channel steps and the LUT, as the pure reference
 * the shader and the CPU path match.
 *
 * Contracts step: the exported signatures of part P4 (§17.4), stubs: every grade resolves to null
 * (no grade), so nothing is graded. Part P4 writes the bodies.
 */
import type { ColorGrade } from "../types";
import type { CubeLut } from "./cubeLut";

export interface ResolvedGrade {
  temperature: number;
  tint: number;
  exposure: number;
  brightness: number;
  contrast: number;
  highlights: number;
  shadows: number;
  fade: number;
  saturation: number;
  vibrance: number;
  split: { kS: number; kH: number };
  lutStrength: number;
}

/** The grade's look times its strength plus its sliders, clamped; null: the identity (no grade). */
export function resolveGrade(
  g: ColorGrade | undefined,
  which: "screen" | "camera",
): ResolvedGrade | null {
  void g;
  void which;
  return null;
}

/** Linear-light gains of a white balance (W · gains = 1). */
export function whiteBalanceGains(
  temperature: number,
  tint: number,
): [number, number, number] {
  void temperature;
  void tint;
  return [1, 1, 1];
}

/** Stages 1–6 baked per channel: 768 linear values (256 per channel). */
export function gradeTable(g: ResolvedGrade): Float32Array {
  void g;
  const t = new Float32Array(768);
  for (let i = 0; i < 256; i++) {
    const e = i / 255;
    const l = e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4;
    t[i] = t[256 + i] = t[512 + i] = l;
  }
  return t;
}

/** A cache key of a resolved grade and its LUT ('' for none). */
export function gradeKey(g: ResolvedGrade | null, lut: CubeLut | null): string {
  void lut;
  return g ? JSON.stringify(g) : "";
}

/** A shaper's value for input `v` on `channel` (linear between its entries). */
export function shaperSample(
  lut: CubeLut,
  v: number,
  channel: 0 | 1 | 2,
): number {
  void lut;
  void channel;
  return v;
}

/** A LUT's value for an encoded colour (shaper, then tetrahedral). */
export function lutSample(
  lut: CubeLut,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  void lut;
  return [r, g, b];
}

/** One pixel graded (the reference). */
export function gradePixel(
  rgb: readonly [number, number, number],
  g: ResolvedGrade,
  table: Float32Array,
  lut: CubeLut | null,
): [number, number, number] {
  void g;
  void table;
  void lut;
  return [rgb[0], rgb[1], rgb[2]];
}

/** RGBA pixels graded in place (the CPU path). */
export function gradePixelsCpu(
  data: Uint8ClampedArray,
  g: ResolvedGrade,
  table: Float32Array,
  lut: CubeLut | null,
): void {
  void data;
  void g;
  void table;
  void lut;
}

/** Where shaper entry i sits in its 256-wide texture. */
export function shaperTexel(i: number): [number, number] {
  return [i % 256, Math.floor(i / 256)];
}
