/**
 * Straightened cursor paths (NW-03 part 2, docs/design/smarter-auto-zoom.md): finds the moves
 * between two resting points and replaces the eligible ones with a straight, minimum-jerk glide
 * between the same two points at the same two times. The recorded samples are never changed
 * (a new array is returned); rests, clicks and scroll positions stay exactly as recorded.
 *
 * Distances are in video heights: d(p, q) = hypot((p.x - q.x) * aspect, p.y - q.y) with
 * aspect = project width / height (at 1080p, 0.001 is about 1 px). Pure and deterministic.
 */
import type { CursorSample, CursorTrack, PathRange } from '../types'

export const PATH = {
  /** Samples staying within this distance of a rest's first sample belong to the rest. */
  restRadius: 0.006,
  /** Shortest rest (seconds). */
  restMin: 0.15,
  /** Automatic option: moves this long (seconds) or longer... */
  minSeconds: 0.1,
  /** ...and at most this long. */
  maxSeconds: 2.5,
  /** A 'straight' range: at most this long. */
  maxManualSeconds: 10,
  /** Automatic option: shortest chord (distance from start to end). */
  minChord: 0.03,
  /** A 'straight' range: shortest chord. */
  minManualChord: 0.01,
  /** Automatic option: largest distance of a recorded sample from the chord, as a share of the chord. */
  wobbleMax: 0.2,
  /** Automatic option: a path turning this much (degrees, signed sum) is a gesture (a loop). */
  maxTurnDeg: 300,
  /** Arc length step (video heights) the path is resampled at to measure its turning. */
  turnStep: 0.02,
  /** Older recordings without releases: a press this long (seconds) before a move may start a drag. */
  dragGuess: 0.25,
  /** A press held this long (seconds) into a move makes it a drag. */
  dragOverlap: 0.03,
  /** Rate of the synthetic samples of a straightened move (the SmoothedTrack rate). */
  hz: 120
} as const

/**
 * Why a move keeps its recorded path. The first four block it everywhere, a 'straight' range
 * included: 'off-frame' (a sample outside the video: another monitor, beside the area or
 * window, hidden), 'click' or 'scroll' (a recorded click, ignored ones too, or a scroll event
 * strictly inside the move), 'drag' (a press held into the move, known from ClickEvent.up).
 * The others only stop the automatic option ('drag-guess': a click without `up` up to
 * PATH.dragGuess before the move; 'short' / 'long' / 'small': duration or chord out of limits,
 * 'wobbly': wobble above PATH.wobbleMax, 'gesture': turning of PATH.maxTurnDeg or more); a
 * 'straight' range is held to 'long' and 'small' with the manual limits only.
 */
export type MoveReason = 'off-frame' | 'click' | 'scroll' | 'drag' | 'drag-guess' | 'short' | 'long' | 'small' | 'wobbly' | 'gesture'

/** A move between two rests. */
export interface CursorMove {
  /** The last sample of one rest and the first sample of the next (source seconds). */
  t0: number
  t1: number
  /** Their indices in the recorded samples. */
  i0: number
  i1: number
  /** The recorded positions at t0 and t1 (kept by straightening). */
  from: { x: number; y: number }
  to: { x: number; y: number }
  /** Largest distance of a recorded sample from the chord, divided by the chord. */
  wobble: number
  /** Why the automatic option keeps it as recorded; null when it may straighten it. */
  auto: MoveReason | null
  /** Why a 'straight' range keeps it as recorded; null when it may straighten it. */
  manual: MoveReason | null
}

/** Minimum-jerk profile: 0 at 0, 1 at 1, zero speed and acceleration at both ends. */
export const minJerk = (s: number): number => s * s * s * (10 - 15 * s + 6 * s * s)

/**
 * The moves of a track: rests are found by walking the samples (from sample i, extend j while
 * d(S[j + 1], S[i]) <= restRadius; a run of at least restMin seconds is a rest, the walk goes on
 * after it, else at i + 1), and each stretch between two consecutive rests is a move (before the
 * first rest and after the last there is none). Each move carries its reasons (MoveReason) for
 * both modes. Cached per (samples, clicks, scrolls) arrays and aspect. [] for an invalid track.
 */
export function cursorMoves(track: CursorTrack, aspect: number): CursorMove[] {
  // Stub until workstream B lands: no moves (nothing is straightened, every count is 0).
  void track
  void aspect
  return []
}

/** The move whose [t0, t1] contains `t` (moves are sorted and disjoint), or null. */
export function moveAt(moves: readonly CursorMove[], t: number): CursorMove | null {
  void moves
  void t
  return null
}

/**
 * `samples` with each of `moves` replaced: the recorded samples strictly between t0 and t1 are
 * removed and synthetic ones inserted at t0 + k / PATH.hz (k = 1 .. ceil((t1 - t0) * hz) - 1),
 * at from + (to - from) * minJerk((t - t0) / (t1 - t0)). The samples at t0 and t1 and every
 * sample outside the moves are the same objects as before. Returns `samples` itself when
 * `moves` is empty.
 */
export function straightenSamples(samples: CursorSample[], moves: readonly CursorMove[]): CursorSample[] {
  void samples
  void moves
  throw new Error('not implemented')
}

/** Which moves a project straightens, and the samples that result. */
export interface PathPlan {
  /** The samples to draw and follow: `track.samples` itself when no move is straightened. */
  samples: CursorSample[]
  moves: CursorMove[]
  /** The straightened moves, in time order. */
  straightened: CursorMove[]
}

/**
 * Decides every move by the path range containing its midpoint (t0 + t1) / 2 (start <= mid <
 * end): 'recorded' keeps it, 'straight' straightens it when `manual` is null; outside every
 * range the automatic option (`straighten`) straightens it when `auto` is null. Then replaces
 * the chosen moves (straightenSamples). Cached like cursorMoves, plus straighten and the paths
 * array (by identity).
 */
export function planCursorPath(track: CursorTrack, ctx: { aspect: number; straighten: boolean; paths: readonly PathRange[] }): PathPlan {
  // Stub until workstream B lands: the path as recorded.
  void ctx
  return { samples: track.samples, moves: [], straightened: [] }
}
