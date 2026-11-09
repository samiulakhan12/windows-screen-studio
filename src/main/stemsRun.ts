/**
 * Writing the sound stems after the video (docs/design/output-and-languages.md §7.6): one ffmpeg run
 * into temporary files next to the video, each renamed into place; a cancel deletes the stems written
 * so far and never the video, and a failure is reported, never undoing the video.
 *
 * Part P3 writes it; the contracts' stub writes nothing.
 */
import type { ExportJob, SoundStem } from '../shared/api/export'

/**
 * The stem step of `export:finish`, after the video `output` is in place. `projectId` names the
 * project whose recordings the stems are cut from (export:start's). Part P3.
 */
export async function writeStemsStep(
  job: ExportJob,
  output: string,
  signal: AbortSignal,
  projectId: string
): Promise<{ stems?: { stem: SoundStem; path: string; bytes: number }[]; stemsProblem?: string }> {
  void job
  void output
  void signal
  void projectId
  return {}
}

/** Renders `only` of the job's stems of project `projectId` into `folder` under `names` (P4's timeline media). Part P3. */
export async function renderStems(
  job: ExportJob,
  folder: string,
  only: readonly SoundStem[],
  names: Partial<Record<SoundStem, string>>,
  signal: AbortSignal,
  projectId: string
): Promise<Partial<Record<SoundStem, string>>> {
  void projectId
  void job
  void folder
  void only
  void names
  void signal
  return {}
}
