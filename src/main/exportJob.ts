import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExportJob, H264Encoder } from '../shared/api/export'
import { MAX_SPEED, MIN_SPEED } from '../shared/engine/timeline'
import { FfmpegFailure } from './ffmpeg'
import { HARDWARE_ENCODERS } from './hwEncoders'

let counter = 0
const uniqueSuffix = (): string => `${process.pid}-${Date.now().toString(36)}${(counter++).toString(36)}`

/** Hidden temporary name next to the target, keeping the real extension. */
export function partialPath(finalPath: string): string {
  const ext = path.extname(finalPath)
  const base = path.basename(finalPath, ext)
  return path.join(path.dirname(finalPath), `.${base}.partial-${uniqueSuffix()}${ext}`)
}

/** Path prefix for GIF intermediates in the OS temp folder. */
export function tempStem(tempDir: string): string {
  return path.join(tempDir, `screen-studio-gif-${uniqueSuffix()}`)
}

/** The renderer only sees `message`; keep ffmpeg's log after a blank line for the details view. */
export function toIpcError(e: unknown): Error {
  if (e instanceof FfmpegFailure) return new Error(e.detail && e.detail !== 'cancelled' ? `${e.message}\n\n${e.detail}` : e.message)
  if (e instanceof Error) return e
  return new Error(String(e))
}

export function renameError(e: unknown, finalPath: string): Error {
  const code = (e as NodeJS.ErrnoException).code
  const name = path.basename(finalPath)
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return new Error(`Could not save "${name}": the file is open in another app or the folder is read-only. Close it and export again.`)
  }
  if (code === 'ENOSPC') return new Error('The disk is full.')
  return new Error(`Could not save "${name}" (${code ?? (e as Error).message}).`)
}

/** Renames with a few retries: on Windows an antivirus scan can hold a fresh file briefly. */
export async function moveIntoPlace(from: string, to: string, rename = fs.rename, backoffMs = 150): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw renameError(e, to)
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)))
    }
  }
}

const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const ENCODERS: H264Encoder[] = [...HARDWARE_ENCODERS, 'libx264']

/** The renderer is trusted, but ffmpeg arguments are still built only from validated values. */
export function validateJob(job: ExportJob): void {
  const ok =
    (job.format === 'mp4' || job.format === 'gif') &&
    isNum(job.width, 2, 8192) &&
    isNum(job.height, 2, 8192) &&
    job.width % 2 === 0 &&
    job.height % 2 === 0 &&
    isNum(job.fps, 1, 120) &&
    isNum(job.frames, 1, 1e8) &&
    ['high', 'medium', 'small'].includes(job.quality) &&
    (job.video?.kind === 'raw'
      ? ENCODERS.includes(job.video.encoder) && ['rgba', 'bgra', 'rgb0', 'bgr0'].includes(job.video.pixelFormat)
      : job.video?.kind === 'h264' &&
        [job.video.color.primaries, job.video.color.transfer, job.video.color.matrix ?? 0].every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
        (job.video.color.fullRange === null || typeof job.video.color.fullRange === 'boolean')) &&
    (!job.audio ||
      (isNum(job.audio.volume, 0, 2) &&
        Array.isArray(job.audio.clips) &&
        job.audio.clips.every((c) => isNum(c.start, 0, 1e7) && isNum(c.end, c.start, 1e7) && isNum(c.speed, MIN_SPEED, MAX_SPEED))))
  if (!ok) throw new Error('Invalid export settings')
  if (job.format === 'gif' && job.video.kind !== 'raw') throw new Error('GIF export needs raw frames')
}
