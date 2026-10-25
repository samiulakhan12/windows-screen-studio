/**
 * Editing the recorded input (NW-03, docs/design/smarter-auto-zoom.md): stray-click detection,
 * ignoring and using clicks, the straightening option and path ranges, and the facts the editor
 * shows about them. Every operation takes the project and the RECORDED track (cursor.json as
 * loaded, never the effective one) and returns a new project, or `p` itself when nothing changes
 * (the edit store then adds no undo step). Ignoring or using clicks updates the automatic zooms
 * in the same new project, so one undo step restores both. Pure.
 */
import type { ClickRow } from '../engine/inputData'
import type { MoveReason } from '../engine/cursorPath'
import type { AutoZoomSettings, ClickEvent, CursorTrack, IgnoredClick, PathMode, Project, ZoomSegment } from '../types'

export const STRAY = {
  /** 'start': clicks before this (seconds), usually the click that focuses the recorded app. */
  edge: 0.6,
  /** 'moving': the cursor is measured this long (seconds) before and after the click... */
  window: 0.08,
  /** ...and must travel at least this far (video heights) on both sides... */
  travel: 0.04,
  /** ...in nearly the same direction (cosine of the angle between the two moves at least this). */
  sameDirection: Math.SQRT1_2,
  /** A press held at least this long (seconds, ClickEvent.up) is deliberate, never 'moving'. */
  held: 0.25
} as const

/**
 * Clicks that are almost certainly not part of the demo, with why. Only clicks inside the
 * video (every button) are checked; each one is reported once, with the first reason that fits:
 *  - 'start': t < STRAY.edge;
 *  - 'end': t > duration - STRAY.edge and no input after it (no click, key, mark or scroll with
 *    a later t, no typing burst ending after it);
 *  - 'moving': the cursor travels at least STRAY.travel in the STRAY.window before the click
 *    and in the STRAY.window after it (cursorAt on the samples, distances in video heights with
 *    aspect = `aspect`), the two moves within 45 degrees of each other, and the press was not
 *    held (no finite `up` with up - t >= STRAY.held).
 * Sorted by time; entries carry `stray`. [] without valid cursor data.
 * CONTRACT: recording finalize stores the result as the new project's ignored clicks.
 */
export function findStrayClicks(track: CursorTrack, duration: number, aspect: number): IgnoredClick[] {
  // Stub until workstream B lands: nothing is detected (finalize then stores no edits).
  void track
  void duration
  void aspect
  return []
}

/**
 * Ignores the clicks of `change.ignore` (entries as stored: the user's have no `stray`) and uses
 * the clicks whose keys are in `change.use` again. An entry for a click already ignored replaces
 * it. When auto zoom is on (zoomSettingsOf(p).auto.enabled), the automatic zooms are updated in
 * the same project with rebaseAutoZooms(p.zooms, before, after, newly ignored keys), where before
 * and after are autoZoomsForTrack(effectiveTrack(recorded, p / next), p.duration, auto). Arrays
 * the change does not touch (inputEdits.paths, ...) keep their identity; an empty ignoredClicks
 * list and an empty inputEdits are removed. `p` itself when no click changes state.
 */
export function setClicksIgnored(p: Project, recorded: CursorTrack, change: { ignore?: readonly IgnoredClick[]; use?: readonly number[] }): Project {
  void p
  void recorded
  void change
  throw new Error('not implemented')
}

/** Runs findStrayClicks (aspect p.width / p.height) and ignores what it finds that is still used ("Find stray clicks"). */
export function ignoreStrayClicks(p: Project, recorded: CursorTrack): { project: Project; added: IgnoredClick[] } {
  void p
  void recorded
  throw new Error('not implemented')
}

/** Uses every ignored click again (setClicksIgnored with every key). */
export function useAllClicks(p: Project, recorded: CursorTrack): Project {
  void p
  void recorded
  throw new Error('not implemented')
}

/**
 * The click "at the playhead" (source seconds `t`): the click an automatic zoom under the
 * playhead was made for (a click anchor, anchor.until undefined, whose clickKey matches a row),
 * else the row nearest to `t` within 1 s (the later one on a tie), else null. Ignored rows count.
 */
export function clickAtPlayhead(rows: readonly ClickRow[], zooms: readonly ZoomSegment[], t: number): ClickRow | null {
  void rows
  void zooms
  void t
  throw new Error('not implemented')
}

/** What an automatic zoom was made for, from its anchor; null for zooms made or edited by hand. */
export type ZoomCause =
  | { kind: 'click'; click: ClickEvent; ms: number }
  | { kind: 'typing'; t: number }
  | { kind: 'mark'; t: number }
  /** Zooming back in where a long scroll stopped (`t`: the session's last wheel event). */
  | { kind: 'scroll'; t: number }
  | null

/**
 * Why `z` exists, from its anchor: anchor.until set -> typing; clickKey(anchor.t) equal to a
 * click of `track` -> click; a mark at anchor.t (within 1e-6) -> mark; anchor.t equal (within
 * 1e-6) to the landing time of a long scroll of scrollBreaks(track, settings) (session end +
 * SCROLL.rest + settings.leadIn) -> scroll. Null otherwise, and for every zoom with auto: false.
 * `track` is the effective track, so an ignored click is never a cause.
 */
export function zoomCause(z: ZoomSegment, track: CursorTrack, settings: AutoZoomSettings): ZoomCause {
  // Stub until workstream B lands: no cause line is shown.
  void z
  void track
  void settings
  return null
}

/** Turns the automatic straightening option on or off (inputEdits.straighten; off removes the key). */
export function setStraighten(p: Project, on: boolean): Project {
  void p
  void on
  throw new Error('not implemented')
}

/**
 * Paints a path range over [start, end] (paintPathRange): 'straight', 'recorded', or null to
 * clear it back to the automatic option. `p` itself when the stored ranges do not change.
 */
export function setPathRange(p: Project, range: { start: number; end: number }, mode: PathMode | null): Project {
  void p
  void range
  void mode
  throw new Error('not implemented')
}

/** Counts for the editor's hints and notices. */
export interface PathSummary {
  /** Moves (with their midpoint in the range, when one is given). */
  moves: number
  straightened: number
  /** Moves kept as recorded, by the reason that applied (auto or manual, as decided). */
  kept: Partial<Record<MoveReason, number>>
}

/**
 * What straightening does in the whole recording, or in `range`: the moves (planCursorPath on
 * the recorded track with the project's options), how many are straightened, and why the others
 * keep their path. All zero when the cursor is in the video or there is no cursor data.
 */
export function pathSummary(recorded: CursorTrack, p: Project, range?: { start: number; end: number }): PathSummary {
  // Stub until workstream B lands.
  void recorded
  void p
  void range
  return { moves: 0, straightened: 0, kept: {} }
}
