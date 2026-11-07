/**
 * Reading stored sound-effect references and rules (docs/design/editing-polish.md §4.2, §10.6):
 * a reference is 'sfx:' plus the id of an effect of the library, else it is dropped. Absent input
 * reads as undefined, so loading a project from before wave 10 adds no key.
 */
import type { SfxRef, SoundFx } from "../types";
import { SOUND_EFFECTS } from "./soundLibrary";

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** An effect of the library as stored ('sfx:pop-soft'), or undefined. */
export function readSfxRef(raw: unknown): SfxRef | undefined {
  if (typeof raw !== "string" || !raw.startsWith("sfx:")) return undefined;
  const id = raw.slice(4);
  return SOUND_EFFECTS.some((e) => e.id === id) ? (raw as SfxRef) : undefined;
}

/** An item's own sound ('none' silences it), or undefined: the project's rule. */
export function readItemSound(raw: unknown): "none" | SfxRef | undefined {
  return raw === "none" ? "none" : readSfxRef(raw);
}

/** A Captions Studio graphic's sound: today's 'pop' and 'ding', or an effect of the library (§10.7). */
export function readGraphicSound(
  raw: unknown,
): "pop" | "ding" | SfxRef | undefined {
  return raw === "pop" || raw === "ding" ? raw : readSfxRef(raw);
}

/** Project.soundFx as stored, or undefined when nothing readable is left. */
export function readSoundFx(raw: unknown): SoundFx | undefined {
  if (!isObject(raw)) return undefined;
  const out: SoundFx = {};
  for (const key of ["zoomIn", "zoomOut", "titles", "callouts"] as const) {
    const ref = readSfxRef(raw[key]);
    if (ref) out[key] = ref;
  }
  if (typeof raw.volume === "number" && Number.isFinite(raw.volume))
    out.volume = Math.min(1, Math.max(0, raw.volume));
  return Object.keys(out).length ? out : undefined;
}
