/**
 * ffmpeg arguments for the WAV format and the sound stems (docs/design/output-and-languages.md §7):
 * 32-bit float PCM at 48 kHz, RF64 beyond 4 GiB, a BWF chunk starting at 0, names main derives.
 *
 * Part P3 writes it; the contracts' stub refuses, so no WAV export runs before P3.
 */
import type { ExportJob, SoundStem } from '../shared/api/export'
import type { FfmpegPlan, PlanPaths } from './exportArgs'

/** The output arguments of one stem written to `path` (§7.2). Part P3. */
export function stemOutputArgs(stem: SoundStem, path: string): string[] {
  void stem
  void path
  return []
}

/** The WAV format: today's M4A graph, written as 32-bit float WAV (§7.7). Part P3. */
export function wavPlan(job: ExportJob, given: PlanPaths): FfmpegPlan {
  void job
  void given
  throw new Error('WAV export is not available yet.')
}

/** Free paths next to `output` for `stems` ("Demo - Voice.wav", " (2)" when taken), never the video's own (§7.1). Part P3. */
export function stemPaths(output: string, stems: readonly SoundStem[], exists: (p: string) => boolean): Partial<Record<SoundStem, string>> {
  void output
  void stems
  void exists
  return {}
}
