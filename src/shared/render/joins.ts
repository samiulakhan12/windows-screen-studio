/**
 * Smooth cuts (docs/design/editing-polish.md §5): the cuts of an edit, the join each one gets, the
 * windows a crossfade, a slide or a dip runs over, the still A* each needs, the punch-in's scale,
 * and the feeds that keep the export's decoder going forward. Pure; preview and export share it.
 *
 * Contracts step: these are the exported signatures of part P1 (§17.1), each a stub that draws and
 * plays nothing new (no cut has a join, the punch-in's scale is 1, a camera is returned as it is,
 * the feeds are the pictures as they are). Part P1 writes the bodies.
 */
import type { Clip, CutJoin, Project, SlideFrom } from "../types";
import { editToVideo, type FreezePlan } from "../engine/freeze";
import { JOIN_LENGTHS, PUNCH_LIMITS } from "../engine/joinData";
import { sourceToOutput } from "../engine/timeline";
import type { Camera } from "../engine/zoom";

export const JOIN_DEFAULTS: Readonly<
  Record<
    "crossfade" | "dip" | "slide",
    { duration: number; min: number; max: number }
  >
> = JOIN_LENGTHS;
export const PUNCH_SCALE: { default: 1.1; min: 1.05; max: 1.2 } = PUNCH_LIMITS;
/** A dip less than this many seconds of video after the previous dip draws as a crossfade (§5.2 rule 5). */
export const FLASH_GAP = 1.0;

/** A cut: the clip after it (B) by index and id, B's start in edit and in video time (T). */
export interface CutRef {
  index: number;
  clip: string;
  edit: number;
  video: number;
}

/** Each cut of `clips` once, in order (a gap of more than 1e-6 s between neighbours). */
export function cutsOf(
  clips: readonly Clip[],
  plan: FreezePlan,
): readonly CutRef[] {
  void clips;
  void plan;
  return [];
}

/** Whether the camera leads the picture at source time `t` (camera-only or camera-large, the camera showing). */
export function cameraLed(project: Project, t: number): boolean {
  void project;
  void t;
  return false;
}

/** The join cut `index` draws with: its own, else every cut's, resolved (never 'smooth'); null: a hard cut. */
export function resolvedJoin(project: Project, index: number): CutJoin | null {
  void project;
  void index;
  return null;
}

/** The window a crossfade, slide or dip runs over (video seconds), and the still it needs (§5.4). */
export interface JoinWindow {
  index: number;
  clip: string;
  kind: "crossfade" | "dip" | "slide";
  from: number;
  to: number;
  at: number;
  still: { screen: number; held: boolean; camera: number | null } | null;
  color?: string;
  dir?: SlideFrom;
}

/** The windows of every cut with a crossfade, slide or dip, in order (memoised per project). */
export function joinPlan(project: Project): readonly JoinWindow[] {
  void project;
  return [];
}

export interface JoinAt {
  window: JoinWindow;
  /** Progress through the window, 0..1. */
  p: number;
}

/** The window holding video time `video` (binary search), or null. */
export function joinAt(
  windows: readonly JoinWindow[],
  video: number,
): JoinAt | null {
  void windows;
  void video;
  return null;
}

/** A track's presentation-ordered frame starts and half its median frame duration. */
export interface TrackTimes {
  starts: Float64Array;
  half: number;
}

/** A track's frame times from its samples, or a constant-rate grid at `fallbackFps` over `seconds`. */
export function trackTimes(
  samples: readonly { time: number; duration: number }[] | null,
  fallbackFps: number,
  seconds: number,
): TrackTimes {
  void samples;
  void fallbackFps;
  void seconds;
  return { starts: new Float64Array(0), half: 0 };
}

/** The frame k* that holds `instant` (§5.3) and the time to ask for it. */
export function stillFrame(
  track: TrackTimes,
  instant: number,
  held: boolean,
  aStart: number,
): { index: number; ask: number } {
  void track;
  void held;
  void aStart;
  return { index: 0, ask: instant };
}

/** The punch-in's scale at source time `t`: 1 without one. */
export function punchAt(project: Project, t: number): number {
  void project;
  void t;
  return 1;
}

/** `cam` shown `punchAt` times closer about its own centre, or `cam` itself when there is no punch-in on the screen at `t`. */
export function punchedCamera(
  cam: Camera,
  project: Project,
  t: number,
): Camera {
  void project;
  void t;
  return cam;
}

/** How the live picture, A* and a dip's colour are drawn at `at` in a w × h frame (§5.5). */
export function joinPose(
  at: JoinAt,
  w: number,
  h: number,
): {
  live: { dx: number; dy: number };
  still: { alpha: number; dx: number; dy: number } | null;
  fill: { color: string; alpha: number } | null;
} {
  void at;
  void w;
  void h;
  return { live: { dx: 0, dy: 0 }, still: null, fill: null };
}

/** The video time of the preview's frame at source time `t` (§5.7): inside a hold its start plus the time spent in it. */
export function frameVideoTime(
  clips: Clip[],
  plan: FreezePlan,
  t: number,
  hold: { start: number; elapsed: number } | null,
  leftHoldAt: number | null,
): number {
  void leftHoldAt;
  if (hold) return hold.start + hold.elapsed;
  return editToVideo(plan, sourceToOutput(clips, t) ?? 0);
}

/** The export's decoder feeds with the stills inserted where their frames fall (§5.8). */
export interface JoinFeed {
  screen: number[];
  camera: number[];
  draw: { screen: Int32Array; camera: Int32Array };
  stills: { window: number; screen: number; camera: number | null }[];
}

/** The feeds of both sources: without joins, the pictures and camera times as they are, each output frame drawing its own entry. */
export function joinFeed(input: {
  pictures: readonly number[];
  cameraTimes: readonly number[] | null;
  windows: readonly JoinWindow[];
  fps: number;
  screen: TrackTimes;
  camera: TrackTimes | null;
}): JoinFeed {
  const n = input.pictures.length;
  const draw = Int32Array.from({ length: n }, (_, i) => i);
  return {
    screen: [...input.pictures],
    camera: input.cameraTimes ? [...input.cameraTimes] : [],
    draw: {
      screen: draw,
      camera: input.cameraTimes ? Int32Array.from(draw) : new Int32Array(0),
    },
    stills: [],
  };
}
