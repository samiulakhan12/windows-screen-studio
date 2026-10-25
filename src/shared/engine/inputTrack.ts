/**
 * The input as the edit uses it (NW-03, docs/design/smarter-auto-zoom.md): one derived cursor
 * track with the project's input edits applied. The editor binds its `cursor` to it, so the
 * render scene, and through it preview, scrubbing and export, the click effects and sounds,
 * the follow-cursor camera, motion blur, spotlights, smart speed and every auto zoom
 * regeneration all see the same clicks and the same cursor path. cursor.json itself is never
 * changed. Pure.
 */
import type { CursorTrack, Project } from '../types'

/** What effectiveTrack reads from the project. */
export type InputContext = Pick<Project, 'inputEdits' | 'capture' | 'width' | 'height'>

/**
 * The recorded track with the project's input edits applied:
 *  - `clicks` without the ignored ones (InputEdits.ignoredClicks, matched by clickKey);
 *  - `samples` with the straightened moves replaced (planCursorPath in cursorPath.ts, with
 *    aspect = width / height, InputEdits.straighten and InputEdits.paths), only when Flown draws
 *    the cursor: never with capture.cursorInVideo, never for an invalid track;
 *  - everything else (keys, shapes, marks, typing, scrolls, scale, valid) passed through.
 * Returns `recorded` itself when nothing changes, which is every project without input edits,
 * and the same object again for the same inputs: memoised on recorded.samples, recorded.clicks,
 * recorded.scrolls, the ignoredClicks and paths arrays (by identity), straighten, the aspect and
 * cursorInVideo. Ignoring a click keeps the same `samples` array (so the smoothed cursor and
 * focus paths are not rebuilt); changing straightening keeps the same `clicks` array.
 * CONTRACT: the editor scene (preview and export), recording finalize and every auto zoom
 * regeneration read the track through this; nothing reads ignored clicks or straightened
 * samples any other way.
 */
export function effectiveTrack(recorded: CursorTrack, ctx: InputContext): CursorTrack {
  // Stub until workstream B lands: no edit is applied, which is exactly the old behaviour.
  void ctx
  return recorded
}
