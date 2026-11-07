/**
 * Animated callouts (docs/design/editing-polish.md §7): one motion engine for texts, shapes and
 * title cards (Captions Studio's itemPose plus Draw and Wipe), step badges and speech bubbles. Pure.
 *
 * Contracts step: the exported signatures of part P3 (§17.3). The allowed motions and the defaults
 * new items get are data, final here; the functions are stubs (no pose: the drawing code keeps
 * today's fades). Part P3 writes the bodies.
 */
import type { Rect } from "../engine/layout";
import type { ChunkPose } from "../captions/motion";
import type {
  AnnotationStyle,
  CalloutMotion,
  CalloutMotionKind,
  Clip,
  Project,
  Shape,
  ShapeKind,
} from "../types";
import { CALLOUT_ALLOWED, graphemesOf, type CalloutItem } from "./calloutData";

export type { CalloutItem } from "./calloutData";

/** What each item allows (§7.1): calloutData's table, which the readers keep to. */
export const CALLOUT_KINDS: Readonly<
  Record<
    CalloutItem,
    { enter: readonly CalloutMotionKind[]; exit: readonly CalloutMotionKind[] }
  >
> = CALLOUT_ALLOWED;

const motion = (
  kind: CalloutMotionKind,
  duration: number,
  strength = 1,
): CalloutMotion => ({ kind, duration, strength });

/** The motions written into new items (§7.1; texts and title cards get them only when picked). */
export const CALLOUT_DEFAULTS: Readonly<
  Record<CalloutItem, { enter: CalloutMotion; exit: CalloutMotion }>
> = {
  text: { enter: motion("rise", 0.25), exit: motion("fade", 0.18) },
  badge: { enter: motion("pop", 0.24), exit: motion("fade", 0.18) },
  bubble: { enter: motion("pop", 0.26), exit: motion("pop", 0.18, 0.25) },
  arrow: { enter: motion("draw", 0.35), exit: motion("fade", 0.18) },
  box: { enter: motion("draw", 0.45), exit: motion("fade", 0.18) },
  highlight: { enter: motion("wipe", 0.28), exit: motion("fade", 0.18) },
  title: { enter: motion("rise", 0.35), exit: motion("fade", 0.35) },
};

/** The item an annotation style or a shape kind is ('title': a title card); null for blur and pixelate. */
export function calloutItemOf(
  kind: AnnotationStyle | ShapeKind | "title",
): CalloutItem | null {
  void kind;
  return null;
}

/** A new shape with its kind's default motion (§7.1). */
export function withDefaultMotion<T extends Shape>(shape: T): T {
  return shape;
}

/** Captions Studio's ChunkPose plus how much of a Draw is drawn (0..1). */
export interface CalloutPose extends ChunkPose {
  drawn: number;
}

/** An item's pose at source time `t`, or null outside it (§7.1). */
export function calloutPose(
  start: number,
  end: number,
  t: number,
  clips: Clip[],
  enter: CalloutMotion | undefined,
  exit: CalloutMotion | undefined,
  u: number,
  calm: boolean,
  oldFade: number,
): CalloutPose | null {
  void start;
  void end;
  void t;
  void clips;
  void enter;
  void exit;
  void u;
  void calm;
  void oldFade;
  return null;
}

/** The graphemes of `text` ("ক্ষা" and "👍🏽" are one each). */
export function graphemes(text: string): string[] {
  return graphemesOf(text);
}

/** The label each automatic badge draws, by annotation id (§7.3). */
export function badgeLabels(project: Project): ReadonlyMap<string, string> {
  void project;
  return new Map();
}

/** White or #111111 on `fill`, whichever reads better. */
export function badgeTextColor(fill: string): "#ffffff" | "#111111" {
  void fill;
  return "#ffffff";
}

/** A badge's circle or pill for `label` at font `px`. */
export function badgeBox(
  label: string,
  px: number,
  measure: (text: string, px: number) => number,
): { w: number; h: number; px: number; radius: number } {
  void label;
  void measure;
  return { w: 0, h: 0, px, radius: 0 };
}

/** A bubble's lines, wrapped by words, or between graphemes without spaces. */
export function wrapCallout(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  void maxWidth;
  void measure;
  return [text];
}

/** A bubble's body near its tip, kept inside `area`. */
export function bubbleBody(
  tip: { x: number; y: number },
  body: { dx: number; dy: number },
  size: { w: number; h: number },
  s: number,
  area: Rect,
): Rect {
  void body;
  void s;
  void area;
  return { x: tip.x, y: tip.y, w: size.w, h: size.h };
}

/** A bubble's tail toward `tip`, or null when it is left out. */
export function bubbleTail(
  body: Rect,
  tip: { x: number; y: number } | null,
  f: number,
  radius: number,
): {
  base: [{ x: number; y: number }, { x: number; y: number }];
  tip: { x: number; y: number };
} | null {
  void body;
  void tip;
  void f;
  void radius;
  return null;
}

/** A rectangle's perimeter (a Draw's dash length). */
export function rectPerimeter(w: number, h: number): number {
  return 2 * (w + h);
}

/** An ellipse's perimeter by Ramanujan's approximation. */
export function ellipsePerimeter(a: number, b: number): number {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}
