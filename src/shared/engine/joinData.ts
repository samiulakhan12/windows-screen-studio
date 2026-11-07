/**
 * Reading stored cut styles (docs/design/editing-polish.md §4.2, §5): Project.joins as the editor
 * and the drawing code use it. Pure and idempotent; absent or unreadable input reads as undefined,
 * so loading a project from before wave 10 adds no key.
 */
import type {
  CutJoin,
  CutStyle,
  JoinKind,
  ProjectJoins,
  SlideFrom,
} from "../types";

/** Most cuts with a style of their own kept from a file (edit-by-text makes thousands of clips). */
export const MAX_CUT_STYLES = 20000;

/** The lengths of the kinds with one (output seconds, §5.2): the default and the range. */
export const JOIN_LENGTHS: Readonly<
  Record<
    "crossfade" | "dip" | "slide",
    { duration: number; min: number; max: number }
  >
> = {
  crossfade: { duration: 0.15, min: 0.05, max: 0.5 },
  dip: { duration: 0.5, min: 0.2, max: 1.2 },
  slide: { duration: 0.4, min: 0.25, max: 0.7 },
};

/** Punch-in's size (§5.2): the default and the range. */
export const PUNCH_LIMITS = { default: 1.1, min: 1.05, max: 1.2 } as const;

export const JOIN_KINDS: readonly JoinKind[] = [
  "cut",
  "smooth",
  "crossfade",
  "dip",
  "slide",
  "punch",
];
export const SLIDE_FROM: readonly SlideFrom[] = [
  "left",
  "right",
  "top",
  "bottom",
];

const HEX = /^#[0-9a-f]{6}$/i;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The range of a kind's `duration`: smooth's crossfades take Crossfade's. */
function lengthRange(kind: JoinKind): { min: number; max: number } | null {
  if (kind === "crossfade" || kind === "smooth") return JOIN_LENGTHS.crossfade;
  if (kind === "dip" || kind === "slide") return JOIN_LENGTHS[kind];
  return null;
}

/**
 * A stored join, or null when its kind is unknown. `duration` is clamped to the kind's range
 * (non-finite dropped), `color` must be #rrggbb and is lower-cased, `from` must be a side,
 * `scale` is clamped to 1.05..1.2; fields that do not belong to the kind are dropped ('smooth'
 * keeps `duration` and `scale`).
 */
export function readCutJoin(raw: unknown): CutJoin | null {
  if (!isObject(raw) || !JOIN_KINDS.includes(raw.kind as JoinKind)) return null;
  const kind = raw.kind as JoinKind;
  const out: CutJoin = { kind };
  const range = lengthRange(kind);
  if (range && finite(raw.duration))
    out.duration = clamp(raw.duration, range.min, range.max);
  if (kind === "dip" && typeof raw.color === "string" && HEX.test(raw.color))
    out.color = raw.color.toLowerCase();
  if (kind === "slide" && SLIDE_FROM.includes(raw.from as SlideFrom))
    out.from = raw.from as SlideFrom;
  if ((kind === "punch" || kind === "smooth") && finite(raw.scale))
    out.scale = clamp(raw.scale, PUNCH_LIMITS.min, PUNCH_LIMITS.max);
  return out;
}

/** A stored cut style: a readable join on a clip id of 1..64 characters, or null. */
function readCutStyle(raw: unknown): CutStyle | null {
  if (
    !isObject(raw) ||
    typeof raw.clip !== "string" ||
    raw.clip.length < 1 ||
    raw.clip.length > 64
  )
    return null;
  const join = readCutJoin(raw);
  return join ? { clip: raw.clip, ...join } : null;
}

/**
 * Project.joins as stored, or undefined when it is not an object or nothing readable is left.
 * `cuts` keeps at most MAX_CUT_STYLES entries and the first of a repeated clip; `auto` needs
 * `by: 'polish'` and `was` a readable join or null.
 */
export function readJoins(raw: unknown): ProjectJoins | undefined {
  if (!isObject(raw)) return undefined;
  const out: ProjectJoins = {};
  const all = readCutJoin(raw.all);
  if (all) out.all = all;
  if (Array.isArray(raw.cuts)) {
    const seen = new Set<string>();
    const cuts: CutStyle[] = [];
    for (const entry of raw.cuts) {
      if (cuts.length >= MAX_CUT_STYLES) break;
      const style = readCutStyle(entry);
      if (!style || seen.has(style.clip)) continue;
      seen.add(style.clip);
      cuts.push(style);
    }
    if (cuts.length) out.cuts = cuts;
  }
  if (isObject(raw.auto) && raw.auto.by === "polish") {
    const was = raw.auto.was === null ? null : readCutJoin(raw.auto.was);
    if (was !== null || raw.auto.was === null) out.auto = { by: "polish", was };
  }
  return Object.keys(out).length ? out : undefined;
}
