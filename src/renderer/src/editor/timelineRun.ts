/**
 * The timeline step of an export (docs/design/output-and-languages.md §8.7): builds the plan from the
 * project (exportTimeline or recordingsTimeline) and asks main to write the files. Part P4 writes
 * it; the contracts' stub writes nothing.
 */
import type { TimelineRequest, TimelineResult } from '../../../shared/api/export'
import type { Project } from '../../../shared/types'

/** Writes the timeline files of an export that just finished. Part P4. */
export async function writeTimelineStep(project: Project, request: Omit<TimelineRequest, 'plan'>, exported: { fps: number; frames: number; width: number; height: number }): Promise<TimelineResult> {
  void project
  void request
  void exported
  return { files: [] }
}
