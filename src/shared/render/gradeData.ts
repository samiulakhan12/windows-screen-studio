/**
 * Reading stored colour grades (docs/design/editing-polish.md §4.2, §9): Project.grade as the
 * editor and the drawing code use it. Each number must be finite and is clamped to its range; a
 * value of 0 is kept as written, so a valid grade loads and saves to the same bytes. Absent or
 * unreadable input reads as undefined, so loading a project from before wave 10 adds no key.
 */
import type { ColorGrade, ColorLut, LookId, ProjectGrade } from "../types";
import { LOOK_IDS, SCREEN_LOOKS } from "./looks";

/** A LUT's file in the project folder. */
export const LUT_FILE_RE = /^lut-[1-9][0-9]{0,8}\.cube$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Longest LUT title kept, in characters. */
export const LUT_TITLE_MAX = 80;

/** The sliders of §2.5, each −1..1, in the order a grade is written. */
export const GRADE_SLIDERS = [
  "temperature",
  "tint",
  "brightness",
  "contrast",
  "saturation",
  "highlights",
  "shadows",
  "vibrance",
] as const;
/** The camera's exposure, in stops. */
export const EXPOSURE_RANGE = { min: -2, max: 2 } as const;

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** C0 and C1 controls and the bidi embeddings, overrides and isolates (U+202A–202E, U+2066–2069). */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** A LUT's title as shown: plain text without controls, at most 80 characters (whole code points). */
export function cleanLutTitle(title: string): string {
  return [...title.replace(UNSAFE_TEXT, "")].slice(0, LUT_TITLE_MAX).join("");
}

/** A stored LUT reference, or undefined when any of its fields is unusable. */
export function readColorLut(raw: unknown): ColorLut | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.file !== "string" || !LUT_FILE_RE.test(raw.file))
    return undefined;
  if (typeof raw.sha256 !== "string" || !SHA256_RE.test(raw.sha256))
    return undefined;
  if (
    !Number.isInteger(raw.size) ||
    (raw.size as number) < 2 ||
    (raw.size as number) > 65
  )
    return undefined;
  if (typeof raw.title !== "string") return undefined;
  const lut: ColorLut = {
    file: raw.file,
    sha256: raw.sha256,
    title: cleanLutTitle(raw.title),
    size: raw.size as number,
  };
  if (finite(raw.strength)) lut.strength = clamp(raw.strength, 0, 1);
  return lut;
}

/**
 * A stored grade of the screen or the camera, or undefined when nothing readable is left. Unknown
 * looks are dropped, and on the screen every look but Natural, Vivid and Mono; `exposure` is the
 * camera's only.
 */
export function readColorGrade(
  raw: unknown,
  which: "screen" | "camera",
): ColorGrade | undefined {
  if (!isObject(raw)) return undefined;
  const out: ColorGrade = {};
  for (const key of GRADE_SLIDERS) {
    const v = raw[key];
    if (finite(v)) out[key] = clamp(v, -1, 1);
  }
  if (which === "camera" && finite(raw.exposure))
    out.exposure = clamp(raw.exposure, EXPOSURE_RANGE.min, EXPOSURE_RANGE.max);
  const looks: readonly LookId[] = which === "screen" ? SCREEN_LOOKS : LOOK_IDS;
  if (looks.includes(raw.look as LookId)) out.look = raw.look as LookId;
  if (finite(raw.lookStrength))
    out.lookStrength = clamp(raw.lookStrength, 0, 1);
  const lut = readColorLut(raw.lut);
  if (lut) out.lut = lut;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Project.grade as stored, or undefined when nothing readable is left. `auto.camera` must be a
 * readable camera grade or null (the camera had no grade before Auto colour).
 */
export function readProjectGrade(raw: unknown): ProjectGrade | undefined {
  if (!isObject(raw)) return undefined;
  const out: ProjectGrade = {};
  const screen = readColorGrade(raw.screen, "screen");
  if (screen) out.screen = screen;
  const camera = readColorGrade(raw.camera, "camera");
  if (camera) out.camera = camera;
  if (isObject(raw.auto) && "camera" in raw.auto) {
    const was =
      raw.auto.camera === null
        ? null
        : readColorGrade(raw.auto.camera, "camera");
    if (was !== undefined) out.auto = { camera: was };
  }
  return Object.keys(out).length ? out : undefined;
}
