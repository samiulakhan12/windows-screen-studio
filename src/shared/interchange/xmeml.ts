/** Premiere XML (xmeml version 4) for Premiere Pro (docs/design/output-and-languages.md §8.4). Pure. Part P4. */
import type { TimelineMedia, TimelinePlan } from './timelinePlan'

/** The Premiere XML of `plan`. Part P4. */
export function xmeml(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>): string {
  void plan
  void paths
  return ''
}
