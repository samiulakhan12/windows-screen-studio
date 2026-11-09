/**
 * ffmpeg arguments for the wave 12 codecs and for transparent videos (docs/design/output-and-languages.md
 * §5.4-5.7): HEVC and AV1 from raw frames or WebCodecs streams, CineForm, QuickTime Animation and
 * ProRes, VP9 with alpha, and their audio. Every encoder named here is on ALLOWED_ENCODERS.
 *
 * Part P1 writes it; the contracts' stub refuses, so no job with a new codec runs before P1.
 */
import type { ExportJob, FfmpegVideoEncoder } from '../shared/api/export'
import type { FfmpegPlan, PlanPaths } from './exportArgs'

/** Encoder arguments of `encoder` for `job` (§5.4). Part P1. */
export function proVideoArgs(job: ExportJob, encoder: FfmpegVideoEncoder): string[] {
  void job
  void encoder
  return []
}

/** Audio arguments: 32-bit float PCM for the editing formats, today's otherwise (§5.4). Part P1. */
export function proAudioArgs(job: ExportJob): string[] {
  void job
  return []
}

/** Arguments that copy a WebCodecs HEVC or AV1 stream and tag it (§5.4). Part P1. */
export function copyProArgs(kind: 'hevc' | 'av1'): string[] {
  void kind
  return []
}

/** Every ffmpeg process of a job with a non-default codec or a transparent background (§5). Part P1. */
export function proPlan(job: ExportJob, given: PlanPaths): FfmpegPlan {
  void given
  throw new Error(`This export's codec (${job.codec ?? 'transparent'}) is not available yet.`)
}
