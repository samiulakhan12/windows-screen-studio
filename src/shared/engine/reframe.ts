/**
 * The view that follows the action (NW-05, docs/design/vertical-video.md §5): an offline shot
 * plan of holds and C² glides, planned in output time from where the cursor rests and goes,
 * clicks, typing, drawn shapes, scrolls and zooms, and read by source time. Pure: the plan is a
 * function of the drawn project and the drawn track (cropView), so preview, scrubbing and export
 * agree. Also the framed zooms (gentler, capped, relative to the view; §5.12).
 *
 * CONTRACT (part P1): signatures and constants are frozen; bodies are to be written.
 */
import type { Clip, CursorTrack, Project, ReframePace, ZoomSegment } from '../types'
import type { ViewSize } from './layout'

/** A point in view space (normalised to the drawn recording). */
export interface Pt {
  x: number
  y: number
}

/** Constants every Movement preset shares (§5.18); seconds are output time unless noted. */
export const FOLLOW = {
  /** Attention sampling (s). */
  grid: 1 / 30,
  /** In view with a margin (views): short visits, cuts. */
  visible: 0.45,
  /** Where a click, typing or zoom must be at its time (views). */
  inView: 0.35,
  /** A new view fits what the next lookAhead seconds need. */
  lookAhead: 1.2,
  /** The first view looks this far ahead (s). */
  startAhead: 2.0,
  /** Smaller changes of centre are not made (views). */
  minChange: 0.1,
  /** Click attention window (s). */
  clickBefore: 0.4,
  clickAfter: 0.6,
  /** Attention after the last key or wheel event (source s). */
  typingTail: 0.3,
  scrollTail: 0.3,
  /** Longer moves are tracked, not aimed (source s). */
  maxAimedMove: 2.5,
  /** Lead when tracking (s). */
  trackAhead: 0.3,
  /** Pan duration bounds (s). */
  minPan: 0.5,
  maxPan: 1.5,
  /** Never faster, even to meet a click (views/s). */
  hardSpeed: 3,
  /** A shot is shown this long before the view anticipates the next (s). */
  minShown: 0.3,
  /** After the previous shot's last firm event (s). */
  settle: 0.1,
  /** Pans this close in the same direction join (s). */
  joinGap: 0.6,
  /** Ease in and out of a joined glide (s). */
  glideRamp: 0.5
} as const

/** One Movement preset: a column of the constants table (§5.18). */
export interface PaceParams {
  grid: number
  /** A target this close to the centre needs no move (views). */
  deadZone: number
  visible: number
  inView: number
  /** A soft target must stay out this long (s). */
  confirm: number
  lookAhead: number
  startAhead: number
  minChange: number
  /** Shorter soft visits that stay visible are dropped (s). */
  minHold: number
  clickBefore: number
  clickAfter: number
  typingTail: number
  scrollTail: number
  maxAimedMove: number
  trackAhead: number
  minPan: number
  maxPan: number
  /** Normal peak speed (views/s). */
  maxSpeed: number
  /** Normal peak acceleration (views/s²). */
  maxAccel: number
  hardSpeed: number
  /** Longest anticipation (s). */
  maxLead: number
  minShown: number
  settle: number
  joinGap: number
  glideRamp: number
}

/** The Movement presets: Calm, Balanced (the default) and Lively. */
export const PACE: Readonly<Record<ReframePace, Readonly<PaceParams>>> = Object.freeze({
  calm: Object.freeze({ ...FOLLOW, deadZone: 0.35, confirm: 0.7, minHold: 1.2, maxSpeed: 1.2, maxAccel: 4, maxLead: 0.5 }),
  balanced: Object.freeze({ ...FOLLOW, deadZone: 0.3, confirm: 0.5, minHold: 0.8, maxSpeed: 1.5, maxAccel: 5, maxLead: 0.6 }),
  lively: Object.freeze({ ...FOLLOW, deadZone: 0.25, confirm: 0.35, minHold: 0.5, maxSpeed: 2.0, maxAccel: 6, maxLead: 0.8 })
})

/** Zooms are this strong in a followed view (1 + (s − 1) × ZOOM_STRENGTH). */
export const ZOOM_STRENGTH = 0.5
/** At most this many output pixels per recorded pixel. */
export const MAX_MAGNIFY = 3

/**
 * What the view looks at (§5.6), in rule order after 'none'. followAttention's `kind` holds the
 * index in this list (0: no target, the view holds). Zooms, typing and clicks are firm.
 */
export const ATTENTION_KINDS = ['none', 'zoom', 'typing', 'click', 'shape', 'scroll', 'cursor'] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]

/** A hold, a pan or a joined glide, back to back over output time (§5.9-5.11). */
export interface FollowSegment {
  o0: number
  o1: number
  from: Pt
  to: Pt
  ramp: number
  kind: 'hold' | 'pan' | 'glide'
}

/** A held view (§5.7): where it starts (output s), its centre, and why. */
export interface FollowShot {
  o0: number
  centre: Pt
  firm: boolean
  firstFirm: number
  lastFirm: number
  cut: boolean
  late: boolean
  kind: AttentionKind
}

export interface FollowPlan {
  total: number
  clips: readonly Clip[]
  /** Output second at which each clip starts. */
  clipOut: Float64Array
  /** Back to back from 0 to total; holds between moves. */
  segments: FollowSegment[]
  /** segments[i].o0, for the binary search. */
  starts: Float64Array
  /** For tests, diagnostics and the Later "why it moved" view. */
  shots: FollowShot[]
}

/** What the plan depends on (the drawn project: cropView, framed zooms). */
export type FollowProject = Pick<
  Project,
  'clips' | 'zooms' | 'layouts' | 'webcam' | 'hasWebcam' | 'style' | 'reframe' | 'width' | 'height' | 'zoomSettings' | 'duration' | 'shapes' | 'spotlights'
>

/**
 * The view's size and limits at the canonical frame (§5.12): `base` at the effective `level`,
 * the magnification `mag` (output px per recorded px), `fit` (the zoom level showing the whole
 * recording) and `cap` (the highest zoom level within MAX_MAGNIFY).
 */
export interface FollowLimits {
  base: ViewSize
  level: number
  mag: number
  fit: number
  cap: number
}

/** The glide profile (§5.10): progress 0..1 at u in 0..1, ramp r in (0, 0.5]; C², zero speed and acceleration at both ends. */
export function glide(u: number, r: number): number {
  return notImplemented(u, r)
}

/** The u at which glide(u, r) reaches progress p (bisection, 40 steps). */
export function glideInverse(p: number, r: number): number {
  return notImplemented(p, r)
}

/** Seconds of a pan of d views (§5.9): within minPan..maxPan by maxSpeed and maxAccel, never faster than hardSpeed. */
export function panDuration(d: number, pace: PaceParams = PACE.balanced): number {
  return notImplemented(d, pace)
}

/** The followed view's limits for `project` at its canonical frame, or null when it does not follow (cached per project). */
export function followLimits(project: FollowProject): FollowLimits | null {
  return notImplemented(project)
}

/** `zooms` as a followed view shows them (§5.12): half strength, capped, regions framed in the view, pull-backs to the whole recording. Memoised per array and limits. */
export function framedZooms(zooms: ZoomSegment[], limits: FollowLimits): ZoomSegment[] {
  return notImplemented(zooms, limits)
}

/** The target of every grid sample (§5.6): output time, position, kind (ATTENTION_KINDS index) and event time (firm kinds). */
export function followAttention(
  project: FollowProject,
  track: CursorTrack
): { o: Float64Array; x: Float32Array; y: Float32Array; kind: Uint8Array; event: Float64Array } {
  return notImplemented(project, track)
}

/** The follow plan of the drawn project and track (uncached). */
export function planFollow(project: FollowProject, track: CursorTrack): FollowPlan {
  return notImplemented(project, track)
}

/** The follow plan, cached by the identities and values it depends on (§8.1). */
export function followPlanFor(project: FollowProject, track: CursorTrack): FollowPlan {
  return notImplemented(project, track)
}

/**
 * The view's centre at source time `t` (view space): `at` (default `t`) picks the clip, so a
 * motion-blur sub-frame past a clip's end samples that clip's last view (§5.4). Stateless, O(log n).
 */
export function followCentre(plan: FollowPlan, t: number, at?: number): { x: number; y: number } {
  return notImplemented(plan, t, at)
}

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
