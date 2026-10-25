/**
 * The input as the edit uses it (NW-03, docs/design/smarter-auto-zoom.md): one derived cursor
 * track with the project's input edits applied. The editor binds its `cursor` to it, so the
 * render scene, and through it preview, scrubbing and export, the click effects and sounds,
 * the follow-cursor camera, motion blur, spotlights, smart speed and every auto zoom
 * regeneration all see the same clicks and the same cursor path. cursor.json itself is never
 * changed. Pure.
 */
import type { ClickEvent, CursorSample, CursorTrack, IgnoredClick, PathRange, Project } from '../types'
import { planCursorPath } from './cursorPath'
import { clickKey } from './inputData'

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
  if (!recorded.valid) return recorded
  const edits = ctx.inputEdits
  const ignored = edits?.ignoredClicks ?? NONE_IGNORED
  const paths = edits?.paths ?? NO_PATHS
  const straighten = edits?.straighten === true
  const aspect = ctx.width > 0 && ctx.height > 0 ? ctx.width / ctx.height : 16 / 9
  const inVideo = !!ctx.capture?.cursorInVideo
  const hit = trackCache.get(recorded)
  if (
    hit &&
    hit.samples === recorded.samples &&
    hit.clicks === recorded.clicks &&
    hit.scrolls === recorded.scrolls &&
    hit.ignored === ignored &&
    hit.paths === paths &&
    hit.straighten === straighten &&
    hit.aspect === aspect &&
    hit.inVideo === inVideo
  )
    return hit.track
  const clicks = usedClicks(recorded.clicks, ignored)
  const samples: CursorSample[] =
    inVideo || (!straighten && paths.length === 0) ? recorded.samples : planCursorPath(recorded, { aspect, straighten, paths }).samples
  const track = clicks === recorded.clicks && samples === recorded.samples ? recorded : { ...recorded, samples, clicks }
  trackCache.set(recorded, { samples: recorded.samples, clicks: recorded.clicks, scrolls: recorded.scrolls, ignored, paths, straighten, aspect, inVideo, track })
  return track
}

const NONE_IGNORED: IgnoredClick[] = []
const NO_PATHS: PathRange[] = []

const trackCache = new WeakMap<
  CursorTrack,
  {
    samples: CursorSample[]
    clicks: ClickEvent[]
    scrolls: CursorTrack['scrolls']
    ignored: IgnoredClick[]
    paths: PathRange[]
    straighten: boolean
    aspect: number
    inVideo: boolean
    track: CursorTrack
  }
>()
const clickCache = new WeakMap<ClickEvent[], WeakMap<IgnoredClick[], ClickEvent[]>>()

/** `clicks` without the ignored ones: `clicks` itself when none of them is ignored. Cached per (clicks, ignored) arrays. */
function usedClicks(clicks: ClickEvent[], ignored: IgnoredClick[]): ClickEvent[] {
  if (ignored.length === 0 || clicks.length === 0) return clicks
  let byIgnored = clickCache.get(clicks)
  if (!byIgnored) {
    byIgnored = new WeakMap()
    clickCache.set(clicks, byIgnored)
  }
  let used = byIgnored.get(ignored)
  if (!used) {
    const keys = new Set(ignored.map((e) => e.ms))
    const kept = clicks.filter((c) => !keys.has(clickKey(c.t)))
    used = kept.length === clicks.length ? clicks : kept
    byIgnored.set(ignored, used)
  }
  return used
}
