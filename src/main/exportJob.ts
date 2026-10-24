import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ColorTags, ExportJob, FfmpegVideoEncoder, MusicSound, RecordingSound, VideoInput } from '../shared/api/export'
import { MAX_DUCK_RANGES } from '../shared/audio/automation'
import { AUDIO_LIMITS, MUSIC_FILE_RE, SOURCE_FILES, STEM_KINDS, type StemKind } from '../shared/audio/settings'
import type { ExportFormat } from '../shared/types'
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

/** Path prefix for intermediates (GIF frames, two-pass files) in the OS temp folder. */
export function tempStem(tempDir: string): string {
  return path.join(tempDir, `screen-studio-gif-${uniqueSuffix()}`)
}

const EXPORT_EXTENSIONS = ['.mp4', '.gif', '.webm', '.mov', '.m4a']

/** A plain file name a batch export may create: no folders, no reserved characters, a known extension. */
export function batchFileOk(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    name === path.basename(name) &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(name) &&
    !name.startsWith('.') &&
    !/[. ]$/.test(name) &&
    EXPORT_EXTENSIONS.includes(path.extname(name).toLowerCase())
  )
}

/** `folder/name`, or `folder/name (2)`, `(3)`, ... when taken: a batch never replaces a file. */
export function freeBatchPath(folder: string, name: string, taken: (file: string) => boolean): string {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let file = path.join(folder, name)
  for (let n = 2; taken(file) && n < 10000; n++) file = path.join(folder, `${stem} (${n})${ext}`)
  return file
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export const isPng = (data: Uint8Array): boolean => data.byteLength > 8 && PNG_SIGNATURE.every((b, i) => data[i] === b)

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
const ENCODERS: FfmpegVideoEncoder[] = [...HARDWARE_ENCODERS, 'libx264', 'libvpx-vp9']
const FORMATS: ExportFormat[] = ['mp4', 'gif', 'webm', 'mov', 'm4a']
/** Video input each format accepts. */
const KINDS: Record<ExportFormat, VideoInput['kind'][]> = { mp4: ['raw', 'h264'], mov: ['raw', 'h264'], webm: ['raw', 'vp9'], gif: ['raw'], m4a: ['none'] }

/** Largest frame side any encoder here accepts (the renderer keeps exports at 4096). */
export const MAX_FRAME_SIDE = 8192
/** Most click sounds one export mixes in. */
export const MAX_CLICKS = 50_000

const validColor = (c: ColorTags | undefined): boolean =>
  !!c &&
  [c.primaries, c.transfer, c.matrix ?? 0].every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
  (c.fullRange === null || typeof c.fullRange === 'boolean')

function validVideo(job: ExportJob): boolean {
  const v = job.video
  if (!v || !KINDS[job.format]?.includes(v.kind)) return false
  if (v.kind === 'raw') {
    const vp9 = v.encoder === 'libvpx-vp9'
    return ENCODERS.includes(v.encoder) && vp9 === (job.format === 'webm') && ['rgba', 'bgra', 'rgb0', 'bgr0'].includes(v.pixelFormat)
  }
  return v.kind === 'none' || validColor(v.color)
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

function validRecording(a: RecordingSound): boolean {
  const stems = a.stems
  return (
    isNum(a.volume, 0, 2) &&
    Array.isArray(a.clips) &&
    a.clips.every((c) => isNum(c.start, 0, 1e7) && isNum(c.end, c.start, 1e7) && isNum(c.speed, MIN_SPEED, MAX_SPEED)) &&
    (stems === undefined ||
      (typeof stems === 'object' &&
        stems !== null &&
        Object.keys(stems).length > 0 &&
        Object.entries(stems).every(([k, g]) => (STEM_KINDS as string[]).includes(k) && isNum(g, 0, 2)))) &&
    (a.noiseReduction === undefined || isNum(a.noiseReduction, 0, 1)) &&
    (a.normalize === undefined || isBool(a.normalize))
  )
}

function validMusic(m: MusicSound): boolean {
  const d = m.duck
  return (
    typeof m.file === 'string' &&
    MUSIC_FILE_RE.test(m.file) &&
    isNum(m.volume, 0, 2) &&
    isBool(m.loop) &&
    isNum(m.fadeIn, 0, AUDIO_LIMITS.musicFade.max) &&
    isNum(m.fadeOut, 0, AUDIO_LIMITS.musicFade.max) &&
    (m.duration === null || isNum(m.duration, 0, 1e7)) &&
    (d === undefined ||
      (isNum(d.depth, 0, 1) &&
        isNum(d.attack, 0, 5) &&
        isNum(d.release, 0, 5) &&
        Array.isArray(d.ranges) &&
        d.ranges.length <= MAX_DUCK_RANGES &&
        d.ranges.every((r) => isNum(r?.start, 0, 1e7) && isNum(r.end, r.start, 1e7))))
  )
}

/** The renderer is trusted, but ffmpeg arguments are still built only from validated values. */
export function validateJob(job: ExportJob): void {
  const audioOnly = job.format === 'm4a'
  const sizeOk = audioOnly || (isNum(job.width, 2, MAX_FRAME_SIDE) && isNum(job.height, 2, MAX_FRAME_SIDE) && job.width % 2 === 0 && job.height % 2 === 0)
  if (!sizeOk && typeof job.width === 'number' && typeof job.height === 'number') {
    throw new Error(`The export size ${job.width}×${job.height} is not supported: each side must be an even number of pixels, at most ${MAX_FRAME_SIDE}. Choose a lower resolution.`)
  }
  const ok =
    FORMATS.includes(job.format) &&
    sizeOk &&
    isNum(job.fps, 1, 120) &&
    isNum(job.frames, 1, 1e8) &&
    ['high', 'medium', 'small'].includes(job.quality) &&
    validVideo(job) &&
    (!job.audio || validRecording(job.audio)) &&
    (!job.music || (job.format !== 'gif' && validMusic(job.music))) &&
    (job.fadeIn === undefined || isNum(job.fadeIn, 0, AUDIO_LIMITS.fade.max)) &&
    (job.fadeOut === undefined || isNum(job.fadeOut, 0, AUDIO_LIMITS.fade.max)) &&
    (!job.clicks ||
      (isNum(job.clicks.volume, 0, 2) && Array.isArray(job.clicks.times) && job.clicks.times.length <= MAX_CLICKS && job.clicks.times.every((t) => isNum(t, 0, 1e7)))) &&
    (!job.bitrate || (isNum(job.bitrate.video, 0, 1e9) && isNum(job.bitrate.audio, 0, 1e6) && (audioOnly || job.bitrate.video >= 1000))) &&
    (job.maxBytes === undefined || (job.format === 'gif' && isNum(job.maxBytes, 1000, 1e12)))
  if (!ok) throw new Error('Invalid export settings')
  if (audioOnly && !job.audio && !job.clicks && !job.music) throw new Error('This recording has no sound to export.')
}

/** The files a job's soundtrack reads, inside the project folder. */
export interface SoundInputs {
  /** The job to run: without stems when one of them is missing (the mixed track is used instead). */
  job: ExportJob
  audioInput: string | null
  stems?: Partial<Record<StemKind, string>>
  music?: string | null
}

/**
 * Resolves the soundtrack files of `job` in project folder `dir`. Names come from fixed
 * lists only (the music's name was validated), so nothing outside the folder is read. A
 * missing stem falls back to the screen proxy's mixed track; missing music is an error the
 * user can act on.
 */
export async function resolveSoundInputs(job: ExportJob, dir: string, exists: (file: string) => Promise<boolean>): Promise<SoundInputs> {
  const audioInput = job.audio ? path.join(dir, SOURCE_FILES.mix) : null
  let out: SoundInputs = { job, audioInput }
  const wanted = job.audio?.stems ? STEM_KINDS.filter((k) => job.audio?.stems?.[k] !== undefined) : []
  if (job.audio && wanted.length > 0) {
    const files = Object.fromEntries(wanted.map((k) => [k, path.join(dir, SOURCE_FILES[k])])) as Partial<Record<StemKind, string>>
    const present = await Promise.all(wanted.map((k) => exists(files[k]!)))
    if (present.every(Boolean)) out.stems = files
    else {
      console.warn('A sound track of the recording is missing; exporting its mixed sound instead.')
      const { stems: _dropped, ...audio } = job.audio
      void _dropped
      out = { job: { ...job, audio }, audioInput }
    }
  }
  if (job.music) {
    if (!MUSIC_FILE_RE.test(job.music.file)) throw new Error('Invalid export settings')
    const music = path.join(dir, job.music.file)
    if (!(await exists(music))) throw new Error('The background music file is missing. Choose it again in the Audio panel.')
    out.music = music
  }
  return out
}
