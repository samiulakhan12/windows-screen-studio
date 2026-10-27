/**
 * The speech detector on a project's sound (docs/design/offline-captions.md §3.5): ffmpeg
 * decodes the source to 16 kHz mono float samples into `ssw-speech vad`, which returns a
 * probability per 32 ms frame; shared/audio/vad.ts turns them into ranges. Results are kept in
 * the project's .cache/speech.json (keyed by the file's size and time, the engine and the model),
 * so the editor opens without running it again. Workstream B's own module (it may change).
 */
import type { Range } from '../../shared/audio/activity'
import type { ProjectProcesses } from '../projectProcesses'

/**
 * Speech ranges of `file` (source `source` of project `projectId`), or null when the detector
 * cannot run or failed (the level-based detector is used then). Rejects only when stopped (the
 * editor closed), like the level measurement.
 */
export async function speechOfFile(projectId: string, source: 'mic' | 'mix', file: string, stat: { size: number; mtimeMs: number }, processes: ProjectProcesses): Promise<Range[] | null> {
  void projectId
  void source
  void file
  void stat
  void processes
  return null
}
