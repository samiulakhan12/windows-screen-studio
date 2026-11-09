/** CMX 3600 EDLs (docs/design/output-and-languages.md §8.5): the finished video, and Resolve's chapter markers. Pure. Part P4. */
import type { TimelineMedia, TimelinePlan } from './timelinePlan'

/** Most events an EDL holds. */
export const EDL_EVENT_LIMIT = 999

/** The EDL of `plan` (This export only), lines ending in CRLF. Part P4. */
export function edl(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>): string {
  void plan
  void paths
  return ''
}

/** Resolve's markers EDL, or null when the video has no chapters. Part P4. */
export function markerEdl(plan: TimelinePlan): string | null {
  void plan
  return null
}
