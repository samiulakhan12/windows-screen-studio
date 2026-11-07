/**
 * The magnifier (docs/design/editing-polish.md §6): a spotlight with `magnify`, a round loupe that
 * shows a detail larger from the recording's own pixels. Pure.
 *
 * Contracts step: the exported signatures of part P2 (§17.2). The timeline asks spotlightName and
 * spotlightIcon for every spotlight; the stubs give today's name and icon, and the rest show no
 * magnifier. Part P2 writes the bodies.
 */
import type { Rect } from "../engine/layout";
import type { Camera } from "../engine/zoom";
import type { Clip, Project, Spotlight } from "../types";

export const MAGNIFIER: {
  enter: 0.3;
  exit: 0.22;
  size: 0.3;
  min: 1.5;
  max: 4;
  step: 0.25;
  defaultMin: 1.5;
  defaultMax: 2.5;
  targetPpr: 2;
  softAbove: 2.5;
  ring: 0.004;
  shadowY: 0.006;
  shadowBlur: 0.02;
  shadowAlpha: 0.35;
  corner: 0.18;
} = {
  enter: 0.3,
  exit: 0.22,
  size: 0.3,
  min: 1.5,
  max: 4,
  step: 0.25,
  defaultMin: 1.5,
  defaultMax: 2.5,
  targetPpr: 2,
  softAbove: 2.5,
  ring: 0.004,
  shadowY: 0.006,
  shadowBlur: 0.02,
  shadowAlpha: 0.35,
  corner: 0.18,
};

/** Whether a spotlight is a magnifier. */
export function isMagnifier(s: Spotlight): boolean {
  return typeof s.magnify === "number";
}

/** The lens's size factor, zoom and opacity at source time `t`, or null outside it (§6.2). */
export function magnifierPhase(
  s: Spotlight,
  t: number,
  clips: Clip[],
  calm: boolean,
): { r: number; z: number; alpha: number } | null {
  void s;
  void t;
  void clips;
  void calm;
  return null;
}

/** The camera that shows `z` times more around `centre`, which stays where it is (§6.3). */
export function lensCamera(
  cam: Camera,
  centre: { x: number; y: number },
  z: number,
): Camera {
  void centre;
  void z;
  return cam;
}

/** The lens on screen: its centre and half sizes in output px. */
export function lensBox(
  s: Spotlight,
  centre: { x: number; y: number },
  rect: Rect,
  cam: Camera,
  r: number,
  toOut: (x: number, y: number) => { x: number; y: number },
): { cx: number; cy: number; rx: number; ry: number } {
  void s;
  void rect;
  void cam;
  void r;
  const c = toOut(centre.x, centre.y);
  return { cx: c.x, cy: c.y, rx: 0, ry: 0 };
}

/** A new magnifier's zoom from the output pixels per recorded pixel (§6.1). */
export function defaultZoom(ppr: number): number {
  void ppr;
  return 2;
}

/** A magnifier added at `t`, on the cursor or the view's centre (§2.2). */
export function newMagnifier(
  project: Project,
  t: number,
  view: {
    rect: Rect;
    cam: Camera;
    w: number;
    h: number;
    centre: { x: number; y: number };
    cursor: { x: number; y: number } | null;
  },
  mode: "region" | "cursor",
): { project: Project; id: string } {
  void t;
  void view;
  void mode;
  return { project, id: "" };
}

/** A spotlight's name on the timeline, its tooltip and accessible name ("Magnifier, 2 times"). */
export function spotlightName(s: Spotlight): string {
  return s.mode === "cursor" ? "Cursor spotlight" : "Spotlight";
}

/** A spotlight's icon on the timeline. */
export function spotlightIcon(s: Spotlight): "spotlight" | "magnifier" {
  void s;
  return "spotlight";
}
