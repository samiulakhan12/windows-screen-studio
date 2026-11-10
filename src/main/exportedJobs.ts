/**
 * The jobs of the files exported in this session, kept in memory for the steps that follow an export
 * (docs/design/output-and-languages.md §8.1, §8.7): a timeline over the original recordings renders
 * Music and Effects with the export's own job when no stems were written, and uses its Clean voice.
 * Only the last few are kept; nothing is written to disk.
 */
import type { ExportJob } from '../shared/api/export'

/** Exports remembered at once (the timeline step runs right after its export). */
const KEEP = 4
const jobs = new Map<string, ExportJob>()

/** Records the job `file` was exported with. */
export function rememberExportJob(file: string, job: ExportJob): void {
  jobs.delete(file)
  jobs.set(file, job)
  while (jobs.size > KEEP) jobs.delete(jobs.keys().next().value!)
}

/** The job `file` was exported with in this session, if it is one of the last few. */
export const exportJobOf = (file: string): ExportJob | undefined => jobs.get(file)
