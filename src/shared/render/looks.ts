/**
 * The looks (docs/design/editing-polish.md §9.4): parameter sets in code (no bundled LUT files).
 * A look's parameters are multiplied by its strength and added to the sliders (colorGrade.ts
 * resolveGrade). Names are generic, never film brands. The screen offers only the looks that keep
 * neutrals neutral or are plainly a choice: Warm, Cool, Soft, Cinematic and Vintage tint white
 * pages, greys and brand colours.
 */
import type { LookId } from "../types";

/** What a look adds (each in the slider's units); `fade` and `split` are only reached through looks. */
export interface LookParams {
  temperature?: number;
  tint?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  highlights?: number;
  shadows?: number;
  vibrance?: number;
  /** Lifts black (0..1): `0.08 f + e (1 − 0.08 f)`. */
  fade?: number;
  /** Split toning: teal into the shadows (kS) and orange into the highlights (kH). */
  split?: { kS: number; kH: number };
}

export interface Look {
  id: LookId;
  /** Its name in the UI. */
  label: string;
  params: LookParams;
}

export const LOOKS: readonly Look[] = [
  {
    id: "natural",
    label: "Natural",
    params: { contrast: 0.08, vibrance: 0.15 },
  },
  {
    id: "warm",
    label: "Warm",
    params: { temperature: 0.35, tint: 0.05, contrast: 0.06, vibrance: 0.1 },
  },
  {
    id: "cool",
    label: "Cool",
    params: {
      temperature: -0.3,
      tint: -0.05,
      contrast: 0.08,
      saturation: -0.05,
    },
  },
  {
    id: "vivid",
    label: "Vivid",
    params: { contrast: 0.2, saturation: 0.12, vibrance: 0.3 },
  },
  {
    id: "soft",
    label: "Soft",
    params: { contrast: -0.12, highlights: -0.3, fade: 0.5, saturation: -0.12 },
  },
  {
    id: "cinematic",
    label: "Cinematic",
    params: {
      contrast: 0.15,
      saturation: -0.1,
      temperature: 0.05,
      split: { kS: 0.06, kH: 0.05 },
    },
  },
  {
    id: "mono",
    label: "Mono",
    params: { saturation: -1, contrast: 0.18, shadows: 0.1 },
  },
  {
    id: "vintage",
    label: "Vintage",
    params: {
      temperature: 0.25,
      saturation: -0.35,
      fade: 0.6,
      contrast: -0.05,
      split: { kS: 0, kH: 0.04 },
    },
  },
];

/** Every look id, in the order of the camera's chips. */
export const LOOK_IDS: readonly LookId[] = LOOKS.map((l) => l.id);

/** The looks the screen offers (§9.7). */
export const SCREEN_LOOKS: readonly LookId[] = ["natural", "vivid", "mono"];

export function lookOf(id: LookId): Look | null {
  return LOOKS.find((l) => l.id === id) ?? null;
}
