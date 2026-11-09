/** FCPXML 1.10 for DaVinci Resolve and Final Cut Pro (docs/design/output-and-languages.md §8.3). Pure. Part P4. */
import type { TimelineMedia, TimelinePlan } from './timelinePlan'

/** The FCPXML of `plan`; uids are 'flown.{projectId}.{n}'. Part P4. */
export function fcpxml(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>, projectId: string): string {
  void plan
  void paths
  void projectId
  return ''
}
