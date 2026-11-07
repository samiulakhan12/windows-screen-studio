/**
 * Editing cut styles (docs/design/editing-polish.md §2.1, §11, §16): Smooth all cuts, Use hard
 * cuts everywhere, a cut's own style, and the settle step that drops styles whose cut went. Each
 * is one project out (one store.update, one undo step).
 *
 * Contracts step: the exported signatures of part P1 (§17.1), each a stub that changes nothing
 * (`settleJoins` returns `next` itself). Part P1 writes the bodies.
 */
import type { CutJoin, Project } from "../types";

/** Every cut set to Smooth (cuts with their own style keep it). */
export function smoothAllCuts(project: Project): {
  project: Project;
  changed: number;
  kept: number;
} {
  return { project, changed: 0, kept: 0 };
}

/** Every cut a hard cut, stored as { kind: 'cut' } so Polish keeps it. */
export function hardCutsEverywhere(project: Project): Project {
  return project;
}

/** The style of every cut (null: none). */
export function withJoinAll(project: Project, join: CutJoin | null): Project {
  void join;
  return project;
}

/** The style of the cut before clip `clip` (null: the same as every cut). */
export function withCutJoin(
  project: Project,
  clip: string,
  join: CutJoin | null,
): Project {
  void clip;
  void join;
  return project;
}

/** Cuts with their own style given every cut's. */
export function giveSameStyle(project: Project): Project {
  return project;
}

/** `next` with styles of cuts that went dropped, and Polish's record when every cut's style changed by hand; `next` itself when nothing applies. */
export function settleJoins(next: Project, prev: Project): Project {
  void prev;
  return next;
}

export function cutCount(project: Project): number {
  void project;
  return 0;
}

/** "Cut 5 of 37" for the cut whose B starts at source time `start`. */
export function cutNumber(
  project: Project,
  start: number,
): { n: number; of: number } | null {
  void project;
  void start;
  return null;
}

/** A join's name in the UI ("Crossfade, 0.15 s"). */
export function joinLabel(join: CutJoin | null): string {
  void join;
  return "Hard cut";
}

export function nextCutAfter(
  project: Project,
  t: number,
): { start: number; end: number } | null {
  void project;
  void t;
  return null;
}

export function prevCutBefore(
  project: Project,
  t: number,
): { start: number; end: number } | null {
  void project;
  void t;
  return null;
}

/** What Smooth gives cut `index`: a crossfade, or a punch-in when the camera leads on both sides. */
export function smoothHere(
  project: Project,
  index: number,
): "crossfade" | "punch" {
  void project;
  void index;
  return "crossfade";
}
