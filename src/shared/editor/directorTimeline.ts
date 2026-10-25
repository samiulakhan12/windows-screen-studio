/**
 * The camera director's timeline (docs/design/camera-director.md, steps 5-9): where the demo is,
 * the intro and outro (full camera while the person talks before the first deliberate action
 * and after the last one), the long silences where the camera hides, and the bubble time left
 * between them. Everything here is in OUTPUT seconds of the current edit (what the viewer sees,
 * after cuts and speed changes), so minimum lengths are what the viewer sees. Pure.
 *
 * CONTRACT (workstream A): signatures and constants are frozen; bodies are to be written.
 */
import type { Range } from '../audio/activity'
import type { ZoomStyle } from '../engine/zoom'
import type { Clip, CursorTrack, ZoomSegment } from '../types'

/** Fast cursor sweeps count as deliberate input: a path at least `sweepLength` (normalised) long within `sweepWindow` seconds. */
export const DEMO = { sweepWindow: 2.0, sweepLength: 0.35 } as const

/**
 * The intro ends `lead` s before the first action (snapped into a pause of at least `minPause`
 * within `snapWindow` s before it, or `tail` s after the last words); it is at least `min` s
 * long, speech starts within `maxOnset` s, and covers at least `speechShare` of it.
 */
export const INTRO = { lead: 1.0, tail: 0.5, snapWindow: 3.0, minPause: 0.25, min: 3.0, maxOnset: 4.0, speechShare: 0.4 } as const

/**
 * The outro starts `lag` s after the last action (snapped to a pause within `snapWindow` s of
 * the action while still talking, else `onsetLead` s before the next words); at least `min` s
 * long, speech covering at least `speechShare` of it.
 */
export const OUTRO = { lag: 1.5, onsetLead: 0.3, snapWindow: 4.0, minPause: 0.25, min: 3.0, speechShare: 0.4 } as const

/** The demo between an intro and an outro is at least this long (output seconds), or the outro (then the intro) is dropped. */
export const MIN_DEMO = 4.0

/**
 * Hiding: the camera hides `lag` s after the last words of a long silence and is back `lead` s
 * before the next ones; a hidden part is at least `minHidden` s; bubble time shorter than
 * `minShown` s next to a hidden part joins it unless it holds `speechToKeep` s of speech (then it
 * grows to `minShown`).
 */
export const HIDE = { lag: 1.0, lead: 0.8, minHidden: 5.0, minShown: 4.0, speechToKeep: 1.5 } as const

/** The demo: from the start of the first deliberate action to the end of the last one (output seconds). */
export interface DemoSpan {
  start: number
  end: number
}

/**
 * The demo span of a recording (output seconds), or null when nothing deliberate happens. Events,
 * mapped through the clips (events inside cuts are dropped): in-frame clicks of any button, keys,
 * "zoom here" marks, typing bursts [t, end], every zoom (manual or auto) over
 * [start, end - zoomTransition(z, style)], and cursor sweeps (DEMO). Cursor-derived events
 * (clicks, keys, typing, sweeps) count only when `track.valid`.
 */
export function demoSpan(track: CursorTrack, zooms: readonly ZoomSegment[], clips: readonly Clip[], style: ZoomStyle): DemoSpan | null {
  return notImplemented(track, zooms, clips, style)
}

/**
 * The intro (output seconds, starting at 0), or null: the full camera while the person talks
 * before the demo (INTRO). `speech` and `locked` are output ranges; the intro is cut at the first
 * locked range and dropped when what is left is shorter than INTRO.min.
 */
export function findIntro(speech: readonly Range[], demo: DemoSpan, locked: readonly Range[]): Range | null {
  return notImplemented(speech, demo, locked)
}

/** The outro (output seconds, ending at `total`), or null: the full camera while the person talks after the demo (OUTRO). */
export function findOutro(speech: readonly Range[], demo: DemoSpan, total: number, locked: readonly Range[]): Range | null {
  return notImplemented(speech, demo, total, locked)
}

/**
 * Hidden parts (output seconds) for the silences (gaps of `speech` over [0, total]) at least
 * `hideAfter` s long, inside `within` (the demo window minus locked ranges), at least
 * HIDE.minHidden long. A silence that touches the intro (outro) hides straight from (until) it;
 * one at the very start (end) without an intro (outro) hides from 0 (until `total`).
 * `hideAfter` 0: none.
 */
export function findHidden(
  speech: readonly Range[],
  within: readonly Range[],
  hideAfter: number,
  intro: Range | null,
  outro: Range | null,
  total: number
): Range[] {
  return notImplemented(speech, within, hideAfter, intro, outro, total)
}

/** What the timeline decides, in output seconds. */
export interface TimelinePlan {
  intro: Range | null
  outro: Range | null
  hidden: Range[]
  /** Bubble time: inside the demo window, not hidden, not locked (camera positions included). */
  shown: Range[]
}

export interface TimelineInput {
  /** Output length of the edit. */
  total: number
  /** Speech in output seconds, or null when unknown (no sound): no intro, outro or hiding then. */
  speech: readonly Range[] | null
  demo: DemoSpan | null
  /** Output ranges of the user's layout changes (not camera positions): never written over. */
  locked: readonly Range[]
  /** Whether to look for an intro and an outro (DirectorSettings.intro !== 'off'). */
  intro: boolean
  /** DirectorSettings.hideAfter (0: never hide). */
  hideAfter: number
}

/**
 * The whole timeline: intro, outro (MIN_DEMO between them), hidden parts, then the anti-flicker
 * rule (HIDE.minShown): every change the director adds is at least 3 s of output from the next.
 */
export function planTimeline(input: TimelineInput): TimelinePlan {
  return notImplemented(input)
}

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
