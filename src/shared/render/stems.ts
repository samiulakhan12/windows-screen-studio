/**
 * Sound stems (docs/design/output-and-languages.md §7): which WAV files an export writes, their
 * English file words, their exact length, and the one ffmpeg graph that writes them all. Pure.
 * Part P3 writes it; the contracts' stub asks for no stems, so every export is as before.
 */
import type { ExportJob, SoundStem, StemJob } from '../api/export'
import type { AudioAnalysis } from '../audio/soundtrack'
import type { Project } from '../types'
import type { SoundFiles } from './audioPlan'
import type { ExportOptions } from './exportPresets'

/** The word each stem's file is named with, in English in every UI language (§0 decision 10). */
export const STEM_FILE_WORDS: Readonly<Record<SoundStem, string>> = {
  voice: 'Voice',
  system: 'System sound',
  recording: 'Recording',
  music: 'Music',
  effects: 'Effects'
}

/** The stems an export of `project` with `options` writes, or undefined when it writes none (§7.1, §7.4). Part P3. */
export function stemJobOf(project: Project, options: ExportOptions, analysis: AudioAnalysis | null): StemJob | undefined {
  void project
  void options
  void analysis
  return undefined
}

/** The stems of `job` that have sound with the files main resolved (§7.1). Part P3. */
export function stemsOfJob(job: ExportJob, files: SoundFiles): SoundStem[] {
  void job
  void files
  return []
}

/** A stem's length in samples at 48 kHz: round(frames / fps × 48000) (§7.3). Part P3. */
export function stemSamples(frames: number, fps: number): number {
  void frames
  void fps
  return 0
}

/**
 * One ffmpeg run writing every stem (or only `only`): today's inputs from input `first` on, one
 * branch per stem built by today's functions, one output label each (§7.2). Part P3.
 */
export function stemPlan(job: ExportJob, files: SoundFiles, first: number, only?: readonly SoundStem[]): { args: string[]; graph: string; outputs: { stem: SoundStem; label: string }[] } {
  void job
  void files
  void first
  void only
  return { args: [], graph: '', outputs: [] }
}
